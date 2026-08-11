import crypto from "node:crypto";

import {
  Prisma,
  RecalcJobKind,
  RecalcJobStatus,
  type RecalcJob,
} from "@prisma/client";

import prisma from "~/db.server";

/**
 * Durable queue for recalculation work.
 *
 * Restating a quarter rewrites line items across months and then recomputes the
 * whole shop. On a large store that is minutes, which rules out doing it inside
 * a form action, and an in-process promise is no better: a Fly deploy landing
 * mid-restatement would leave half a quarter rewritten with nothing anywhere
 * recording that it had started.
 *
 * The claim/lease/backoff shape is lifted deliberately from the webhook outbox
 * rather than invented again. Same fencing token, same compare-and-set on the
 * lease, same exponential retry — one durable-work pattern in this codebase to
 * reason about, not two that drift apart.
 */

export const RECALC_LEASE_MS = 5 * 60 * 1000;
export const RECALC_HEARTBEAT_MS = 60 * 1000;
export const RECALC_POLL_MS = 15 * 1000;
export const RECALC_BATCH_SIZE = 4;
export const RECALC_MAX_ATTEMPTS = 6;

const MAX_ERROR_LENGTH = 2_000;

export interface EnqueueRecalcJob {
  shopId: string;
  kind: RecalcJobKind;
  payload: Prisma.InputJsonValue;
  /**
   * Collapses duplicate enqueues of identical outstanding work. A merchant
   * correcting six costs in one sitting wants one restatement, not six queued
   * behind each other rewriting the same months over and over.
   */
  dedupeKey?: string;
  /** Delay before the job first becomes eligible. */
  availableAt?: Date;
}

/**
 * Enqueue, collapsing onto an identical job that has not run yet.
 *
 * Only a QUEUED job absorbs a duplicate. Once work is RUNNING its inputs are
 * already read, so a later edit genuinely needs its own job — silently folding
 * it into a run that will never see it is how a merchant ends up staring at a
 * correction that appears to have been applied and was not.
 */
export async function enqueueRecalcJob(
  input: EnqueueRecalcJob,
): Promise<RecalcJob> {
  const availableAt = input.availableAt ?? new Date();

  if (input.dedupeKey) {
    const existing = await prisma.recalcJob.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });

    if (existing && existing.status === RecalcJobStatus.QUEUED) {
      // Keep the earliest eligibility: a coalesced burst should not push the
      // work later every time another edit lands on it.
      return prisma.recalcJob.update({
        where: { id: existing.id },
        data: {
          payload: input.payload,
          availableAt:
            existing.availableAt < availableAt ? existing.availableAt : availableAt,
        },
      });
    }

    if (existing) {
      // The key is held by a job that has already read its inputs — in
      // practice a RUNNING one. That job cannot absorb this request, so the
      // key is handed to the new job instead. Without this the unique index
      // turns a merchant saving a cost during a restatement into a 500, which
      // is the single most likely moment for them to be saving one.
      //
      // Releasing the key changes nothing about the running work: the lease
      // token, not the key, is what fences its writes, and its own completion
      // updates by id.
      await prisma.recalcJob.updateMany({
        where: { id: existing.id, dedupeKey: input.dedupeKey },
        data: { dedupeKey: null },
      });
    }
  }

  try {
    return await prisma.recalcJob.create({
      data: {
        shopId: input.shopId,
        kind: input.kind,
        payload: input.payload,
        dedupeKey: input.dedupeKey ?? null,
        availableAt,
      },
    });
  } catch (error) {
    // Two processes releasing and re-claiming the same key can still collide.
    // Dropping the key is the right losing move: the work is genuinely queued,
    // and a duplicate run of an idempotent restatement is a wasted sweep,
    // whereas losing the enqueue is a correction that never happens.
    if (
      input.dedupeKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return prisma.recalcJob.create({
        data: {
          shopId: input.shopId,
          kind: input.kind,
          payload: input.payload,
          dedupeKey: null,
          availableAt,
        },
      });
    }
    throw error;
  }
}

export interface LeasedRecalcJob {
  job: RecalcJob;
  leaseToken: string;
  attempt: number;
}

/**
 * Atomically lease one due job.
 *
 * The bounded contention loop matters on more than one machine: two workers can
 * select the same candidate, and without it the loser would return "nothing to
 * do" while other due jobs sat waiting.
 */
export async function leaseNextRecalcJob(
  now = new Date(),
): Promise<LeasedRecalcJob | null> {
  for (let contention = 0; contention < 8; contention += 1) {
    const candidate = await prisma.recalcJob.findFirst({
      where: {
        status: { in: [RecalcJobStatus.QUEUED, RecalcJobStatus.RUNNING] },
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    });
    if (!candidate) return null;

    const leaseToken = crypto.randomUUID();
    const leased = await prisma.recalcJob.updateMany({
      where: {
        id: candidate.id,
        status: { in: [RecalcJobStatus.QUEUED, RecalcJobStatus.RUNNING] },
        availableAt: { lte: now },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        status: RecalcJobStatus.RUNNING,
        attempts: { increment: 1 },
        startedAt: candidate.startedAt ?? now,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + RECALC_LEASE_MS),
      },
    });
    if (leased.count !== 1) continue;

    return {
      job: { ...candidate, status: RecalcJobStatus.RUNNING },
      leaseToken,
      attempt: candidate.attempts + 1,
    };
  }

  return null;
}

/**
 * Keep a long restatement's lease alive while it works.
 *
 * A restatement spends most of its time inside one SQL statement, so without a
 * heartbeat a second worker would lease it out from underneath at five minutes
 * and both would rewrite the same line items.
 */
export function startRecalcHeartbeat(
  jobId: string,
  leaseToken: string,
): () => void {
  const timer = setInterval(() => {
    void prisma.recalcJob
      .updateMany({
        where: { id: jobId, leaseToken },
        data: { leaseExpiresAt: new Date(Date.now() + RECALC_LEASE_MS) },
      })
      .catch((error) =>
        console.error("[recalc:%s] failed to extend job lease", jobId, error),
      );
  }, RECALC_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Publish success, and release the dedupe key.
 *
 * Clearing `dedupeKey` is what lets the same work be legitimately requested
 * again next month. Leaving it set would make the unique index a permanent
 * ban on ever restating those months a second time.
 */
export async function completeRecalcJob(
  jobId: string,
  leaseToken: string,
  result: Prisma.InputJsonValue,
): Promise<boolean> {
  const updated = await prisma.recalcJob.updateMany({
    where: { id: jobId, leaseToken },
    data: {
      status: RecalcJobStatus.COMPLETE,
      result,
      dedupeKey: null,
      error: null,
      finishedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return updated.count === 1;
}

export function recalcRetryDelayMs(attempt: number): number {
  // 10s, 20s, 40s ... capped at 15 minutes, matching the webhook outbox.
  return Math.min(15 * 60 * 1000, 10_000 * 2 ** Math.min(10, attempt - 1));
}

/**
 * Record a failure, retrying until the attempt ceiling.
 *
 * Past the ceiling the job stops rather than retrying forever. A restatement
 * that cannot succeed is a merchant-visible problem — the correction they asked
 * for has not been applied — and a job wedged in permanent retry hides that
 * behind a spinner. FAILED with the error text keeps it legible and re-runnable.
 */
export async function failRecalcJob(
  jobId: string,
  leaseToken: string,
  attempt: number,
  error: unknown,
): Promise<boolean> {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
  const exhausted = attempt >= RECALC_MAX_ATTEMPTS;

  const updated = await prisma.recalcJob.updateMany({
    where: { id: jobId, leaseToken },
    data: {
      status: exhausted ? RecalcJobStatus.FAILED : RecalcJobStatus.QUEUED,
      error: message,
      ...(exhausted
        ? { dedupeKey: null, finishedAt: new Date() }
        : { availableAt: new Date(Date.now() + recalcRetryDelayMs(attempt)) }),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return updated.count === 1;
}

export const RECALC_JOB_RETENTION_DAYS = 30;

/**
 * Delete finished job rows once they stop being useful.
 *
 * A restatement job is a receipt, not a record: the accounting trail lives in
 * `PeriodRestatement`, which survives this on purpose — its `jobId` is
 * `SetNull`, so pruning the receipt cannot take the ledger entry with it.
 * Without a sweep this table grows monotonically for the life of the install,
 * and every one of those rows is scanned by the lease query's index.
 *
 * Unfinished work is never touched, however old. A QUEUED job that has waited a
 * month is a bug to be found, not a row to be deleted.
 */
export async function purgeFinishedRecalcJobs(now = new Date()): Promise<number> {
  const cutoff = new Date(
    now.getTime() - RECALC_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  const deleted = await prisma.recalcJob.deleteMany({
    where: {
      status: { in: [RecalcJobStatus.COMPLETE, RecalcJobStatus.FAILED] },
      finishedAt: { lte: cutoff },
    },
  });

  return deleted.count;
}

export type RecalcHandler = (job: RecalcJob) => Promise<Prisma.InputJsonValue>;

const handlers = new Map<RecalcJobKind, RecalcHandler>();

/**
 * Register the worker for a job kind.
 *
 * Registration is explicit and late-bound on purpose: the restatement and
 * bundle modules both import this queue, so having the queue import them back
 * would be a cycle. It also means an unregistered kind fails loudly on its own
 * job row rather than taking the whole sweep down.
 */
export function registerRecalcHandler(
  kind: RecalcJobKind,
  handler: RecalcHandler,
): void {
  handlers.set(kind, handler);
}

export async function runRecalcJob(leased: LeasedRecalcJob): Promise<void> {
  const { job, leaseToken, attempt } = leased;
  const stopHeartbeat = startRecalcHeartbeat(job.id, leaseToken);

  try {
    const handler = handlers.get(job.kind);
    if (!handler) throw new Error(`No recalculation handler for ${job.kind}`);

    const result = await handler(job);
    await completeRecalcJob(job.id, leaseToken, result);
  } catch (error) {
    console.error(
      "[recalc:%s] %s attempt %d failed",
      job.id,
      job.kind,
      attempt,
      error,
    );
    try {
      await failRecalcJob(job.id, leaseToken, attempt, error);
    } catch (persistenceError) {
      console.error(
        "[recalc:%s] could not record job failure",
        job.id,
        persistenceError,
      );
    }
  } finally {
    stopHeartbeat();
  }
}

/** Drain a bounded batch so queue work never monopolises a server process. */
export async function drainRecalcQueue(): Promise<number> {
  let processed = 0;
  while (processed < RECALC_BATCH_SIZE) {
    const leased = await leaseNextRecalcJob();
    if (!leased) break;
    await runRecalcJob(leased);
    processed += 1;
  }
  return processed;
}

interface RecalcWorkerState {
  timer: ReturnType<typeof setInterval> | null;
  drain: Promise<void> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __meridianRecalcWorker: RecalcWorkerState | undefined;
}

const workerState = (global.__meridianRecalcWorker ??= {
  timer: null,
  drain: null,
});

function startDrain(): void {
  if (workerState.drain) return;

  const work = drainRecalcQueue()
    .then(() => undefined)
    .catch((error) =>
      console.error("[recalc] durable queue sweep failed", error),
    );
  workerState.drain = work;
  void work.then(
    () => {
      if (workerState.drain === work) workerState.drain = null;
    },
    () => {
      if (workerState.drain === work) workerState.drain = null;
    },
  );
}

/**
 * Recover in-flight jobs at process start and poll on an interval.
 *
 * A job left RUNNING by a killed process is picked up by lease expiry, not by a
 * separate reaper: `leaseNextRecalcJob` already treats an expired lease on a
 * RUNNING row as available, which is the same rule the webhook outbox uses.
 */
export function startRecalcWorker(): void {
  if (workerState.timer) return;

  startDrain();
  workerState.timer = setInterval(startDrain, RECALC_POLL_MS);
  workerState.timer.unref?.();
}

/** Stop polling during a graceful shutdown (and isolate fake-timer tests). */
export function stopRecalcWorker(): void {
  if (!workerState.timer) return;
  clearInterval(workerState.timer);
  workerState.timer = null;
}

/** Await the current sweep — used by tests and graceful shutdown. */
export async function recalcSettled(): Promise<void> {
  while (workerState.drain) await workerState.drain;
}
