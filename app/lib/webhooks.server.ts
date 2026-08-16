import crypto from "node:crypto";

import { Prisma } from "@prisma/client";

import prisma from "~/db.server";
import {
  logOperationalFailure,
  safeOperationalFailure,
} from "~/lib/operational-errors.server";
import { dispatchPersistedWebhook } from "~/lib/webhook-dispatch.server";
import { minimizeWebhookPayload } from "~/lib/webhook-payload.server";
import { authenticate, hasShopifyCredentials } from "~/shopify.server";

const WEBHOOK_LEASE_MS = 5 * 60 * 1000;
const WEBHOOK_HEARTBEAT_MS = 60 * 1000;
const WEBHOOK_POLL_MS = 10 * 1000;
const WEBHOOK_BATCH_SIZE = 25;
export const WEBHOOK_PAYLOAD_RETENTION_DAYS = 7;
const WEBHOOK_PAYLOAD_RETENTION_MS =
  WEBHOOK_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 4_000;

type ClaimedDelivery = {
  kind: "claimed";
  leaseToken: string;
  attempt: number;
};

type WebhookClaim =
  ClaimedDelivery | { kind: "replay" } | { kind: "untracked" };

/**
 * Shopify guarantees at-least-once webhook delivery. The unique delivery id
 * suppresses replays, while payload + lease fields make the first verified
 * copy recoverable if this process dies after returning HTTP 200.
 */
export async function claimWebhook(
  webhookId: string,
  shopDomain: string,
  topic: string,
  payload: Record<string, unknown>,
): Promise<WebhookClaim> {
  const minimizedPayload = minimizeWebhookPayload(topic, payload);
  // A delivery row belongs to the shop and cascades with shop/redact. Late
  // deliveries for an already-redacted (or never-provisioned) shop remain
  // untracked so receiving one cannot recreate store-linked or customer data.
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  if (!shop) return { kind: "untracked" };

  const now = new Date();
  const leaseToken = crypto.randomUUID();

  try {
    await prisma.webhookEvent.create({
      data: {
        webhookId,
        shopDomain,
        shopId: shop.id,
        topic,
        payload: minimizedPayload as Prisma.InputJsonValue,
        payloadExpiresAt: new Date(
          now.getTime() + WEBHOOK_PAYLOAD_RETENTION_MS,
        ),
        attempts: 1,
        availableAt: now,
        lastAttemptAt: now,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + WEBHOOK_LEASE_MS),
      },
    });
    return { kind: "claimed", leaseToken, attempt: 1 };
  } catch (error) {
    // Only the delivery-id uniqueness constraint proves this is a replay. A
    // connection failure or timeout means the payload was not durably stored,
    // so it must escape and make Shopify retry the request.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { kind: "replay" };
    }

    throw error;
  }
}

export interface WebhookContext {
  shopDomain: string;
  topic: string;
  webhookId: string;
  payload: Record<string, unknown>;
  isReplay: boolean;
}

interface ReceivedWebhook {
  context: WebhookContext;
  claim: WebhookClaim;
}

/**
 * Verify a webhook and durably claim its payload before any 200 response.
 * Invalid HMACs never reach the database.
 */
export async function receiveWebhook(
  request: Request,
): Promise<ReceivedWebhook> {
  if (!hasShopifyCredentials || !authenticate) {
    throw new Response("Shopify credentials are not configured.", {
      status: 503,
    });
  }

  if (!request.headers.get("x-shopify-hmac-sha256")) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const { shop, topic, payload } = await authenticate.webhook(request);
  const webhookId = request.headers.get("x-shopify-webhook-id")?.trim();
  if (!webhookId) {
    // A generated timestamp would turn every retry into a new delivery and
    // defeat both the outbox claim and processor-level idempotency keys.
    throw new Response("Missing Shopify webhook delivery id.", { status: 400 });
  }
  const parsedPayload = (payload ?? {}) as Record<string, unknown>;
  const minimizedPayload = minimizeWebhookPayload(topic, parsedPayload);
  const claim = await claimWebhook(webhookId, shop, topic, minimizedPayload);

  return {
    context: {
      shopDomain: shop,
      topic,
      webhookId,
      payload: minimizedPayload,
      isReplay: claim.kind === "replay",
    },
    claim,
  };
}

/** Work started after a verified claim but not awaited by Shopify's request. */
const inFlight = new Set<Promise<void>>();

function trackWork(work: Promise<void>): void {
  inFlight.add(work);
  // `.finally()` creates a second promise which rejects when `work` rejects;
  // discarding that promise is itself an unhandled rejection. Two explicit
  // branches make cleanup safe even if a future caller forgets to catch.
  void work.then(
    () => inFlight.delete(work),
    () => inFlight.delete(work),
  );
}

/** Wait for all currently-running handlers. Used by tests and graceful shutdown. */
export async function webhooksSettled(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * Verify, persist, and answer Shopify before route processing finishes.
 *
 * The handler is an exported route processor. A fresh delivery uses that
 * exact function immediately; crash recovery resolves the same export through
 * `dispatchPersistedWebhook`, so the retry path cannot drift into a second
 * implementation of the business logic.
 */
export async function handleWebhook(
  request: Request,
  handler: (context: WebhookContext) => Promise<void>,
): Promise<Response> {
  const { context, claim } = await receiveWebhook(request);

  if (claim.kind === "claimed") {
    deferAfterResponse(context, handler, claim);
  } else if (claim.kind === "untracked") {
    // Unknown/redacted stores are intentionally not persisted. Their route
    // processors are no-ops except shop/redact's idempotent legacy cleanup.
    deferAfterResponse(context, handler, null);
  }

  return new Response(null, { status: 200 });
}

function deferAfterResponse(
  context: WebhookContext,
  handler: (context: WebhookContext) => Promise<void>,
  delivery: ClaimedDelivery | null,
): void {
  const work = runHandler(context, handler, delivery);
  trackWork(work);
}

async function runHandler(
  context: WebhookContext,
  handler: (context: WebhookContext) => Promise<void>,
  delivery: ClaimedDelivery | null,
): Promise<void> {
  const stopHeartbeat = delivery
    ? startLeaseHeartbeat(context.webhookId, delivery.leaseToken)
    : () => undefined;

  try {
    await handler(context);
    if (delivery) {
      await markWebhookSucceeded(context.webhookId, delivery.leaseToken);
    }
  } catch (error) {
    const message = safeOperationalFailure(error);
    logOperationalFailure(`webhook:${context.topic}`, error);
    if (delivery) {
      try {
        await markWebhookFailed(
          context.webhookId,
          delivery.leaseToken,
          delivery.attempt,
          message,
        );
      } catch (persistenceError) {
        // Leave the lease to expire. A later sweep can recover the payload;
        // rejecting this detached promise would instead risk taking down the
        // process after Shopify already received its 200.
        logOperationalFailure(
          `webhook:${context.webhookId} delivery-failure persistence`,
          persistenceError,
        );
      }
    }
  } finally {
    stopHeartbeat();
  }
}

function startLeaseHeartbeat(
  webhookId: string,
  leaseToken: string,
): () => void {
  const timer = setInterval(() => {
    const leaseExpiresAt = new Date(Date.now() + WEBHOOK_LEASE_MS);
    void prisma.webhookEvent
      .updateMany({
        where: { webhookId, leaseToken, processedAt: null },
        data: { leaseExpiresAt },
      })
      .catch((error) =>
        logOperationalFailure(
          `webhook:${webhookId} lease heartbeat`,
          error,
        ),
      );
  }, WEBHOOK_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function markWebhookSucceeded(
  webhookId: string,
  leaseToken: string,
): Promise<void> {
  // SQL NULL, not JSON null: no copy of the webhook payload survives success.
  await prisma.webhookEvent.updateMany({
    where: { webhookId, leaseToken, processedAt: null },
    data: {
      processedAt: new Date(),
      payload: Prisma.DbNull,
      payloadExpiresAt: null,
      error: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}

async function markWebhookFailed(
  webhookId: string,
  leaseToken: string,
  attempt: number,
  error: string,
): Promise<void> {
  await prisma.webhookEvent.updateMany({
    where: { webhookId, leaseToken, processedAt: null },
    data: {
      error: error.slice(0, MAX_ERROR_LENGTH),
      availableAt: new Date(Date.now() + retryDelayMs(attempt)),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}

function retryDelayMs(attempt: number): number {
  // 5s, 10s, 20s ... capped at 15m. Poison deliveries remain visible and
  // retryable instead of being silently marked processed or discarded.
  return Math.min(15 * 60 * 1000, 5_000 * 2 ** Math.min(10, attempt - 1));
}

interface LeasedWebhook {
  context: WebhookContext;
  delivery: ClaimedDelivery;
}

/** Atomically lease one due row. Contending processes can only win once. */
async function leaseNextWebhook(): Promise<LeasedWebhook | null> {
  // A bounded contention loop prevents two machines that selected the same
  // row from both stopping while other due rows are waiting.
  for (let contention = 0; contention < 8; contention += 1) {
    const now = new Date();
    const candidate = await prisma.webhookEvent.findFirst({
      where: {
        processedAt: null,
        payload: { not: Prisma.DbNull },
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      orderBy: [{ availableAt: "asc" }, { receivedAt: "asc" }],
      select: {
        id: true,
        webhookId: true,
        shopDomain: true,
        topic: true,
        payload: true,
        attempts: true,
      },
    });
    if (!candidate) return null;

    const leaseToken = crypto.randomUUID();
    const leased = await prisma.webhookEvent.updateMany({
      where: {
        id: candidate.id,
        processedAt: null,
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: now,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + WEBHOOK_LEASE_MS),
      },
    });
    if (leased.count !== 1) continue;

    return {
      context: {
        shopDomain: candidate.shopDomain,
        topic: candidate.topic,
        webhookId: candidate.webhookId,
        payload: candidate.payload as Record<string, unknown>,
        isReplay: true,
      },
      delivery: {
        kind: "claimed",
        leaseToken,
        attempt: candidate.attempts + 1,
      },
    };
  }

  return null;
}

/**
 * A poison order delivery must not retain protected customer data forever.
 * Seven days gives the worker hundreds of retry attempts at the 15-minute
 * ceiling; after that the event remains as a visible failed audit row but its
 * projected recovery payload is irreversibly cleared. Mandatory compliance
 * topics are intentionally excluded: age can never discharge a legal action.
 */
export async function expireWebhookRecoveryPayloads(
  now = new Date(),
): Promise<number> {
  const expired = await prisma.webhookEvent.updateMany({
    where: {
      processedAt: null,
      payload: { not: Prisma.DbNull },
      payloadExpiresAt: { lte: now },
      topic: { in: ["ORDERS_CREATE", "ORDERS_UPDATED", "orders/create", "orders/updated"] },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      processedAt: now,
      payload: Prisma.DbNull,
      payloadExpiresAt: null,
      error: `Recovery payload expired after ${WEBHOOK_PAYLOAD_RETENTION_DAYS} days`,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return expired.count;
}

/** Drain a bounded batch so queue work never monopolises a server process. */
export async function drainWebhookQueue(): Promise<number> {
  await expireWebhookRecoveryPayloads();
  let processed = 0;
  while (processed < WEBHOOK_BATCH_SIZE) {
    const leased = await leaseNextWebhook();
    if (!leased) break;
    await runHandler(leased.context, dispatchPersistedWebhook, leased.delivery);
    processed += 1;
  }
  return processed;
}

interface WebhookWorkerState {
  timer: ReturnType<typeof setInterval> | null;
  drain: Promise<void> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __meridianWebhookWorker: WebhookWorkerState | undefined;
}

const workerState = (global.__meridianWebhookWorker ??= {
  timer: null,
  drain: null,
});

function startDrain(): void {
  if (workerState.drain) return;

  const work = drainWebhookQueue()
    .then(() => undefined)
    .catch((error) => logOperationalFailure("webhook durable queue sweep", error));
  workerState.drain = work;
  trackWork(work);
  void work.then(
    () => {
      if (workerState.drain === work) workerState.drain = null;
    },
    () => {
      if (workerState.drain === work) workerState.drain = null;
    },
  );
}

/** Recover stale/unprocessed deliveries at process start and on an interval. */
export function startWebhookDeliveryWorker(): void {
  if (workerState.timer) return;

  startDrain();
  workerState.timer = setInterval(startDrain, WEBHOOK_POLL_MS);
  workerState.timer.unref?.();
}

/** Stop polling during a graceful shutdown (and isolate fake-timer tests). */
export function stopWebhookDeliveryWorker(): void {
  if (!workerState.timer) return;
  clearInterval(workerState.timer);
  workerState.timer = null;
}
