import { Redis } from "ioredis";
import { logOperationalFailure } from "~/lib/operational-errors.server";

/**
 * The shared Redis connection for queue infrastructure.
 *
 * Everything here is lazy and optional: without MERIDIAN_REDIS_URL the app
 * boots, serves, and syncs webhooks exactly as before — ad ingestion is the
 * only capability that stays down, and it says so once instead of crash-
 * looping a deploy that simply has no Redis yet.
 */

declare global {
  // eslint-disable-next-line no-var
  var __meridianQueueRedis: Redis | undefined;
}

export function queueRedisUrl(): string | null {
  return process.env.MERIDIAN_REDIS_URL ?? process.env.REDIS_URL ?? null;
}

export function queueRedisConfigured(): boolean {
  return queueRedisUrl() !== null;
}

/**
 * One connection per process, created on first use. BullMQ requires
 * `maxRetriesPerRequest: null` (it must block on commands during reconnects,
 * not fail them), and the retry strategy caps at 30s so a Redis outage costs
 * reconnect attempts, not a crashed worker — the Postgres ledger already
 * guarantees nothing is lost while the queue is unreachable.
 */
export function getQueueRedis(): Redis {
  if (global.__meridianQueueRedis) return global.__meridianQueueRedis;

  const url = queueRedisUrl();
  if (!url) {
    throw new Error(
      "Queue Redis is not configured. Set MERIDIAN_REDIS_URL (or REDIS_URL).",
    );
  }

  const connection = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (attempt) => Math.min(30_000, 1_000 * 2 ** attempt),
  });
  connection.on("error", (error) => {
    logOperationalFailure("queue Redis connection", error);
  });

  global.__meridianQueueRedis = connection;
  return connection;
}

export async function closeQueueRedis(): Promise<void> {
  const connection = global.__meridianQueueRedis;
  if (!connection) return;
  global.__meridianQueueRedis = undefined;
  await connection.quit().catch(() => connection.disconnect());
}
