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
 * Wrap a handler with verification, replay suppression and error capture.
 *
 * Always resolves 200 for a verified webhook, even when the handler throws:
 * returning 500 makes Shopify retry with the same payload, and after enough
 * failures it disables the subscription entirely. The failure is recorded
 * instead so it can be replayed deliberately.
 */
export async function handleWebhook(
  request: Request,
  handler: (context: WebhookContext) => Promise<void>,
): Promise<Response> {
  const context = await receiveWebhook(request);

  if (context.isReplay) {
    return new Response(null, { status: 200 });
  }

  try {
    await handler(context);
    await markWebhookProcessed(context.webhookId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[webhook:${context.topic}] ${context.shopDomain}`, error);
    await markWebhookProcessed(context.webhookId, message);
  }

  return new Response(null, { status: 200 });
}
