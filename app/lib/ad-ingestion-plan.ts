import { createHash } from "node:crypto";

/**
 * Pure planning for continuous ad-spend ingestion.
 *
 * The queue is a scheduler, not a memory. Every polling cycle re-derives the
 * set of days that *should* be synced from the Postgres ledger and the
 * calendar, so a flushed Redis, a worker killed mid-day, or an app that was
 * down for a weekend all heal the same way: the next cycle notices the holes
 * and enqueues them again. Nothing here talks to a database or a queue —
 * which is what lets the drop-proofing logic be tested exhaustively.
 */

/** "YYYY-MM-DD" for the UTC calendar day. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return isoDay(date);
}

/** Every day from `from` to `to` inclusive; empty when reversed. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
    // A reversed range must terminate rather than loop to the heat death of
    // the universe; string comparison alone guarantees that, this is a guard
    // against a malformed `from` that never equals its own increment.
    if (days.length > 5_000) break;
  }
  return days;
}

export interface SyncPlanInput {
  /** Today in the reference clock (UTC), as an ISO day. */
  today: string;
  /**
   * First day the connector is responsible for: the earlier of its first
   * recorded sync and `today - initialBackfillDays` when it has never synced.
   */
  horizonStart: string;
  /** Days whose ledger row is SYNCED. */
  syncedDays: ReadonlySet<string>;
  /**
   * Platforms restate recent days as attribution windows close, so the last
   * `lookbackDays` are re-polled every cycle even when already synced.
   */
  lookbackDays: number;
  /**
   * The deep restatement pass widens the lookback to cover the platform's
   * full attribution window (Meta restates up to 28 days).
   */
  deepLookbackDays: number;
  /** When the last deep pass ran; null means never. */
  lastDeepSyncAt: Date | null;
  /** How often the deep pass is due, in days. */
  deepCadenceDays: number;
}

export interface SyncPlan {
  /** Days to enqueue, oldest first, deduplicated. */
  days: string[];
  /** Whether this cycle counts as a deep restatement pass. */
  isDeepPass: boolean;
}

/**
 * Which days a connector needs polled right now.
 *
 * Three sources merge: gaps (any horizon day without a SYNCED ledger row —
 * this is what makes drops self-healing), the restatement lookback (recent
 * days re-polled unconditionally), and the periodic deep pass (the full
 * attribution window, so late restatements land too).
 */
export function planSyncDays(input: SyncPlanInput): SyncPlan {
  const {
    today,
    horizonStart,
    syncedDays,
    lookbackDays,
    deepLookbackDays,
    lastDeepSyncAt,
    deepCadenceDays,
  } = input;

  if (horizonStart > today) return { days: [], isDeepPass: false };

  const deepDue =
    lastDeepSyncAt === null ||
    (new Date(`${today}T00:00:00.000Z`).getTime() - lastDeepSyncAt.getTime()) /
      86_400_000 >=
      deepCadenceDays;

  const lookback = deepDue ? deepLookbackDays : lookbackDays;
  const lookbackStart = addDays(today, -Math.max(0, lookback - 1));

  const due = new Set<string>();
  for (const day of dayRange(horizonStart, today)) {
    if (!syncedDays.has(day)) due.add(day); // a gap, whatever its cause
    else if (day >= lookbackStart) due.add(day); // restatement re-poll
  }

  return { days: [...due].sort(), isDeepPass: deepDue };
}

/**
 * Stable content hash of a day's fetched rows.
 *
 * Restatement re-polls mostly return identical data. Comparing hashes lets
 * the ingester skip the delete-and-rewrite *and* the profit invalidation for
 * an unchanged day — without it, every polling cycle would dirty every
 * lookback day and recompute the shop for nothing.
 */
export function contentHashFor(rows: readonly unknown[]): string {
  const canonical = rows
    .map((row) => JSON.stringify(row, Object.keys(row as object).sort()))
    .sort();
  return createHash("sha256").update(canonical.join("\n")).digest("hex");
}

/** Deterministic job identity: one job per connector-day in flight at once. */
export function ingestJobId(connectorId: string, day: string): string {
  return `ingest:${connectorId}:${day}`;
}

/**
 * Full jitter on an exponential curve, capped. Registered as BullMQ's custom
 * backoff strategy: thundering-herd retries against an ad platform that just
 * rate-limited every shop are how a transient 429 becomes an hour of them.
 */
export function retryBackoffMs(
  attemptsMade: number,
  random: () => number = Math.random,
): number {
  const base = 30_000; // 30s
  const cap = 30 * 60_000; // 30m
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attemptsMade - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
