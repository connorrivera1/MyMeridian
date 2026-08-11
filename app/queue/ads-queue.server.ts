import {
  Queue,
  UnrecoverableError,
  Worker,
  type JobsOptions,
  type Processor,
} from "bullmq";
import { ConnectorProvider } from "@prisma/client";

import prisma from "~/db.server";
import {
  addDays,
  ingestJobId,
  isoDay,
  planSyncDays,
  retryBackoffMs,
} from "~/lib/ad-ingestion-plan";
import {
  ensureSyncWindows,
  ingestConnectorDay,
  listPollableConnectors,
  listShopsWithStaleProfit,
  loadConnectorSyncState,
} from "~/lib/ad-ingestion.server";
import {
  AdProviderAuthError,
  AdProviderRateLimitError,
} from "~/lib/ad-platforms/types.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";
import {
  closeQueueRedis,
  getQueueRedis,
  queueRedisConfigured,
} from "~/queue/redis.server";

/**
 * The BullMQ topology for continuous ad-account polling.
 *
 * Three ingestion queues — one per platform, because rate limits are a
 * per-platform fact and BullMQ's limiter is per-queue. One scheduler queue
 * whose single repeatable job re-plans every connector each cycle from the
 * Postgres ledger; the plan, not the queue, is the source of truth, so Redis
 * can be flushed wholesale and the next cycle repairs everything. One
 * recompute queue that debounces profit materialisation behind spend changes.
 *
 * Division of labour with the Postgres outbox patterns already in this
 * codebase (webhooks, recalc jobs): those make *received events* durable.
 * This work is time-driven — nothing arrives to persist; the job is to keep
 * asking. BullMQ carries the asking (repeatable scheduling, per-provider rate
 * governance, jittered retries); Postgres carries the memory of what has been
 * answered.
 */

const SCHEDULE_QUEUE = "ads-schedule";
const RECOMPUTE_QUEUE = "ads-recompute";

const PROVIDER_QUEUES: Record<
  (typeof PROVIDERS)[number],
  string
> = {
  [ConnectorProvider.FACEBOOK_ADS]: "ads-meta",
  [ConnectorProvider.GOOGLE_ADS]: "ads-google",
  [ConnectorProvider.TIKTOK_ADS]: "ads-tiktok",
};

const PROVIDERS = [
  ConnectorProvider.FACEBOOK_ADS,
  ConnectorProvider.GOOGLE_ADS,
  ConnectorProvider.TIKTOK_ADS,
] as const;

/**
 * Conservative per-platform request budgets. Each unit is one connector-day
 * job (one insights/report request plus pagination). Deliberately far under
 * every platform's documented ceiling — polling is background work and must
 * never crowd out an interactive reconnect.
 */
const PROVIDER_LIMITERS: Record<string, { max: number; duration: number }> = {
  "ads-meta": { max: 20, duration: 60_000 },
  "ads-google": { max: 15, duration: 60_000 },
  "ads-tiktok": { max: 20, duration: 60_000 },
};

const WORKER_CONCURRENCY = 3;

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function adsIngestionConfig() {
  return {
    pollMinutes: intFromEnv("MERIDIAN_ADS_POLL_MINUTES", 30),
    lookbackDays: intFromEnv("MERIDIAN_ADS_LOOKBACK_DAYS", 3),
    deepLookbackDays: intFromEnv("MERIDIAN_ADS_DEEP_LOOKBACK_DAYS", 28),
    deepCadenceDays: intFromEnv("MERIDIAN_ADS_DEEP_CADENCE_DAYS", 7),
    initialBackfillDays: intFromEnv("MERIDIAN_ADS_INITIAL_BACKFILL_DAYS", 90),
    recomputeDebounceMs: intFromEnv("MERIDIAN_ADS_RECOMPUTE_DEBOUNCE_MS", 60_000),
  };
}

interface IngestJobData {
  connectorId: string;
  shopId: string;
  day: string;
}

/**
 * Jobs vanish from Redis the moment they finish, in either direction. This is
 * load-bearing, not housekeeping: BullMQ's jobId dedup spans every retained
 * state, so a completed job kept "for an hour" silently swallows every
 * restatement re-poll of that day for an hour, and a retained failure blocks
 * the ledger's gap-repair re-enqueue exactly when it is needed. The durable
 * record of outcomes is the AdSyncWindow ledger (attempts, lastError,
 * contentHash), which survives Redis entirely. Found live: injected failures
 * sat unconsumed while every cycle's re-adds deduped against old completions.
 */
const INGEST_JOB_OPTS: JobsOptions = {
  attempts: 6,
  backoff: { type: "custom" },
  removeOnComplete: true,
  removeOnFail: true,
};

interface AdsIngestionHandle {
  queues: Queue[];
  workers: Worker[];
}

declare global {
  // eslint-disable-next-line no-var
  var __meridianAdsIngestion: AdsIngestionHandle | undefined;
}

/**
 * One full scheduling pass: for every pollable connector, derive the due days
 * from the ledger and enqueue them. Runs as the repeatable job's processor and
 * is safe to run concurrently with itself — job ids dedupe the enqueues and
 * the ledger writes are idempotent.
 */
export async function runSchedulingCycle(
  queues: Map<string, Queue>,
  now = new Date(),
): Promise<{ connectors: number; enqueued: number }> {
  const config = adsIngestionConfig();
  const today = isoDay(now);
  const connectors = await listPollableConnectors();

  let enqueued = 0;
  for (const summary of connectors) {
    const state = await loadConnectorSyncState(summary.id);
    if (!state) continue;

    const horizonStart =
      state.earliestWindowDay ??
      addDays(today, -(config.initialBackfillDays - 1));

    const plan = planSyncDays({
      today,
      horizonStart,
      syncedDays: state.syncedDays,
      lookbackDays: config.lookbackDays,
      deepLookbackDays: config.deepLookbackDays,
      lastDeepSyncAt: state.connector.lastDeepSyncAt,
      deepCadenceDays: config.deepCadenceDays,
    });
    if (plan.days.length === 0) continue;

    await ensureSyncWindows(state.connector, plan.days);

    const queue = queues.get(PROVIDER_QUEUES[summary.provider as (typeof PROVIDERS)[number]]);
    if (!queue) continue;

    for (const day of plan.days) {
      await queue.add(
        "ingest-day",
        {
          connectorId: summary.id,
          shopId: summary.shopId,
          day,
        } satisfies IngestJobData,
        { ...INGEST_JOB_OPTS, jobId: ingestJobId(summary.id, day) },
      );
      enqueued += 1;
    }

    if (plan.isDeepPass) {
      await prisma.connector.update({
        where: { id: summary.id },
        data: { lastDeepSyncAt: now },
      });
    }
  }

  // The durable half of the recompute contract. The fast path fires straight
  // after a changed ingest; this sweep re-derives lost enqueues from the
  // ledger, so a crash or Redis flush between "spend committed" and "recompute
  // queued" costs one polling cycle, never the recompute itself.
  const recomputeQueue = queues.get(RECOMPUTE_QUEUE);
  let recomputesQueued = 0;
  if (recomputeQueue) {
    for (const shopId of await listShopsWithStaleProfit()) {
      await recomputeQueue.add(
        "recompute-shop",
        { shopId },
        {
          jobId: `recompute_${shopId}`,
          delay: adsIngestionConfig().recomputeDebounceMs,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      recomputesQueued += 1;
    }
  }

  if (enqueued > 0 || recomputesQueued > 0) {
    console.info(
      `[ads] scheduling cycle: ${enqueued} day(s) across ${connectors.length} connector(s), ` +
        `${recomputesQueued} stale-profit recompute(s)`,
    );
  }
  return { connectors: connectors.length, enqueued };
}

function ingestProcessor(
  worker: () => Worker,
  recomputeQueue: Queue,
): Processor<IngestJobData> {
  return async (job) => {
    const { connectorId, day, shopId } = job.data;
    try {
      const outcome = await ingestConnectorDay(connectorId, day);
      if (outcome.kind === "synced" && outcome.changed) {
        // Debounced: one recompute absorbs a whole backfill burst. The stable
        // job id makes later enqueues no-ops while one is already waiting.
        await recomputeQueue.add(
          "recompute-shop",
          { shopId },
          {
            // Underscore, not colon: BullMQ rejects `:` in custom job ids.
            jobId: `recompute_${shopId}`,
            delay: adsIngestionConfig().recomputeDebounceMs,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      }
      return outcome;
    } catch (error) {
      if (error instanceof AdProviderRateLimitError) {
        // Delay the whole provider queue — the limit is the platform's, not
        // this job's — and put the job back without consuming an attempt.
        await worker().rateLimit(error.retryAfterMs);
        throw Worker.RateLimitError();
      }
      if (error instanceof AdProviderAuthError) {
        // Retrying an expired token six times cannot un-expire it. The
        // connector is already marked ERROR; the ledger row stays unsynced
        // and will re-enqueue automatically once the merchant reconnects.
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}

/**
 * Start queues, workers and the repeatable scheduler. Idempotent per process.
 * Returns null when Redis is not configured — the caller logs and moves on.
 */
export async function startAdIngestion(): Promise<AdsIngestionHandle | null> {
  if (global.__meridianAdsIngestion) return global.__meridianAdsIngestion;
  if (!queueRedisConfigured()) {
    console.info(
      "[ads] MERIDIAN_REDIS_URL not set — ad-spend ingestion queues are offline.",
    );
    return null;
  }
  if (process.env.MERIDIAN_ADS_WORKER_DISABLED === "true") {
    console.info("[ads] ingestion workers disabled in this process.");
    return null;
  }

  const connection = getQueueRedis();
  const config = adsIngestionConfig();

  const queues = new Map<string, Queue>();
  for (const name of [
    ...Object.values(PROVIDER_QUEUES),
    SCHEDULE_QUEUE,
    RECOMPUTE_QUEUE,
  ]) {
    queues.set(name, new Queue(name, { connection }));
  }

  const workers: Worker[] = [];
  const recomputeQueue = queues.get(RECOMPUTE_QUEUE)!;

  for (const providerQueueName of Object.values(PROVIDER_QUEUES)) {
    // eslint-disable-next-line prefer-const
    let worker: Worker;
    const processor = ingestProcessor(() => worker, recomputeQueue);
    worker = new Worker(providerQueueName, processor, {
      connection,
      concurrency: WORKER_CONCURRENCY,
      limiter: PROVIDER_LIMITERS[providerQueueName],
      settings: {
        backoffStrategy: (attemptsMade: number) => retryBackoffMs(attemptsMade),
      },
    });
    worker.on("failed", (job, error) => {
      console.error(
        `[ads] ${providerQueueName} job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}): ${error.message}`,
      );
    });
    workers.push(worker);
  }

  const scheduleWorker = new Worker(
    SCHEDULE_QUEUE,
    async () => {
      await runSchedulingCycle(queues);
    },
    { connection, concurrency: 1 },
  );
  scheduleWorker.on("failed", (_job, error) => {
    console.error(`[ads] scheduling cycle failed: ${error.message}`);
  });
  workers.push(scheduleWorker);

  const recomputeWorker = new Worker<{ shopId: string }>(
    RECOMPUTE_QUEUE,
    async (job) => {
      const result = await recomputeShopProfitability(job.data.shopId);
      console.info(
        `[ads] recompute for ${job.data.shopId}: ${result.ordersUpdated} orders in ${result.durationMs}ms`,
      );
    },
    { connection, concurrency: 1 },
  );
  recomputeWorker.on("failed", (job, error) => {
    console.error(
      `[ads] recompute for ${job?.data?.shopId ?? "?"} failed: ${error.message}`,
    );
  });
  workers.push(recomputeWorker);

  // The repeatable cycle. Upsert is idempotent across processes and deploys;
  // an immediate first run makes a fresh boot poll now rather than in N
  // minutes.
  const scheduleQueue = queues.get(SCHEDULE_QUEUE)!;
  await scheduleQueue.upsertJobScheduler(
    "ads-poll-cycle",
    { every: config.pollMinutes * 60_000 },
    { name: "plan-and-enqueue" },
  );

  const handle: AdsIngestionHandle = {
    queues: [...queues.values()],
    workers,
  };
  global.__meridianAdsIngestion = handle;
  console.info(
    `[ads] ingestion online: polling every ${config.pollMinutes}m, ` +
      `lookback ${config.lookbackDays}d, deep ${config.deepLookbackDays}d/${config.deepCadenceDays}d.`,
  );
  return handle;
}

/** Graceful shutdown: finish active jobs, close queues, drop the connection. */
export async function stopAdIngestion(): Promise<void> {
  const handle = global.__meridianAdsIngestion;
  if (!handle) return;
  global.__meridianAdsIngestion = undefined;

  await Promise.allSettled(handle.workers.map((worker) => worker.close()));
  await Promise.allSettled(handle.queues.map((queue) => queue.close()));
  await closeQueueRedis();
  console.info("[ads] ingestion stopped.");
}
