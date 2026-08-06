import prisma from "~/db.server";
import { authenticate, hasShopifyCredentials } from "~/shopify.server";

/**
 * Shopify guarantees at-least-once webhook delivery, and retries anything that
 * does not return 2xx within five seconds. Without a delivery-id check a single
 * retried orders/create would book the same revenue twice.
 *
 * Returns false when this delivery has been seen before.
 */
export async function claimWebhook(
  webhookId: string,
  shopDomain: string,
  topic: string,
): Promise<boolean> {
  try {
    await prisma.webhookEvent.create({
      data: { webhookId, shopDomain, topic },
    });
    return true;
  } catch {
    // Unique violation on webhookId — already handled or in flight.
    return false;
  }
}

export async function markWebhookProcessed(webhookId: string, error?: string) {
  await prisma.webhookEvent
    .update({
      where: { webhookId },
      data: { processedAt: new Date(), error: error ?? null },
    })
    .catch(() => undefined);
}

export interface WebhookContext {
  shopDomain: string;
  topic: string;
  webhookId: string;
  payload: Record<string, unknown>;
  isReplay: boolean;
}

/**
 * Verify a webhook and set up idempotency.
 *
 * Throws a Response on an invalid HMAC — an unverified webhook is an untrusted
 * request that happens to look like Shopify, and must never reach the database.
 */
export async function receiveWebhook(request: Request): Promise<WebhookContext> {
  if (!hasShopifyCredentials || !authenticate) {
    throw new Response("Shopify credentials are not configured.", { status: 503 });
  }

  // A request with no signature at all is unauthenticated, not malformed.
  // The library answers it 400, but Shopify's automated review probes these
  // endpoints for 401 and a 400 is a plausible way to fail submission on a
  // technicality — so answer the way the requirement is written.
  if (!request.headers.get("x-shopify-hmac-sha256")) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const { shop, topic, payload } = await authenticate.webhook(request);

  const webhookId =
    request.headers.get("x-shopify-webhook-id") ??
    `${topic}:${shop}:${Date.now()}`;

  const claimed = await claimWebhook(webhookId, shop, topic);

  return {
    shopDomain: shop,
    topic,
    webhookId,
    payload: (payload ?? {}) as Record<string, unknown>,
    isReplay: !claimed,
  };
}

/**
 * Handler work that has been started but has not finished, and that nothing is
 * waiting on — the response for it has already gone back to Shopify.
 *
 * Tracked rather than simply dropped so that `webhooksSettled` exists: a bare
 * floating promise is untestable and unshutdownable, and both matter.
 */
const inFlight = new Set<Promise<void>>();

/**
 * Wait for every deferred handler to finish.
 *
 * For tests, which need the side effect the response no longer waits for, and
 * for a graceful shutdown, which should not drop a half-written sync on the
 * floor. Loops because a handler may schedule more work as it runs.
 */
export async function webhooksSettled(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * Wrap a handler with verification, replay suppression and error capture.
 *
 * Shopify allows five seconds for the entire request, retries anything slower
 * eight times over four hours, and after eight consecutive failures deletes the
 * subscription outright — which loses every future delivery, not one. So the
 * response is sent as soon as the delivery is verified and claimed, and the
 * handler runs after it. `webhooks.gdpr.data-request.tsx` assembles a shopper's
 * whole order history with every line item; on a large store with a long-lived
 * customer that is not reliably a sub-five-second job, and it was inside the
 * response window.
 *
 * What still happens before the response, and must:
 *  - HMAC verification, so an unverified request is 401 and writes nothing;
 *  - the `claimWebhook` insert, so the reply and the idempotency record are
 *    decided together. Claiming after responding would let a retry that arrives
 *    while the first delivery is still working claim it a second time and
 *    double-book the same order.
 *
 * The handler's own errors are still swallowed into a 200 for the same reason
 * as before — a 500 buys a retry of a payload that will fail again — and are
 * recorded on the event row instead. That now happens after the response has
 * gone, which changes nothing about it: the row is the audit trail, not the
 * reply.
 */
export async function handleWebhook(
  request: Request,
  handler: (context: WebhookContext) => Promise<void>,
): Promise<Response> {
  const context = await receiveWebhook(request);

  if (!context.isReplay) {
    deferAfterResponse(context, handler);
  }

  return new Response(null, { status: 200 });
}

/**
 * Start the handler now and let the response overtake it.
 *
 * Called synchronously, so the handler runs up to its first await before the
 * caller returns: the work is deferred past the response, not past the event
 * loop. Nothing awaits the promise on the request path, so it must never
 * reject — an unhandled rejection here takes the process down and loses every
 * delivery queued behind it.
 */
function deferAfterResponse(
  context: WebhookContext,
  handler: (context: WebhookContext) => Promise<void>,
): void {
  const work: Promise<void> = runHandler(context, handler);

  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
}

async function runHandler(
  context: WebhookContext,
  handler: (context: WebhookContext) => Promise<void>,
): Promise<void> {
  try {
    await handler(context);
    await markWebhookProcessed(context.webhookId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[webhook:${context.topic}] ${context.shopDomain}`, error);
    await markWebhookProcessed(context.webhookId, message);
  }
}
