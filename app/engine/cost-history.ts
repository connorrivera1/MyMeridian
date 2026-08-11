import type { Micros } from "./money";

/**
 * Effective-dated cost resolution.
 *
 * A variant's cost is not a number, it is a step function over time. Everything
 * downstream — what an order's COGS should have been, whether a correction
 * actually changes anything, how far back a restatement has to reach — is a
 * question about that function, and all of them are answered here rather than
 * in SQL, so they can be tested without a database.
 *
 * No Prisma types cross this boundary. `source` is a plain string precisely so
 * the engine does not learn about `CostSource`.
 */

export interface CostVersion {
  /** Landed unit cost at 4dp, matching Shopify's own cost precision. */
  unitCostMicros: Micros;
  /** The instant this cost became true. Open-ended until the next version. */
  effectiveAt: Date;
  source: string;
}

function timeOf(version: CostVersion): number {
  return version.effectiveAt.getTime();
}

/**
 * Ascending, de-duplicated, and safe to binary-search.
 *
 * Two versions sharing an instant is not a merchant error worth failing on —
 * an import and a webhook can legitimately observe the same second — but it
 * does have to resolve to one answer. The later entry in the input wins, which
 * makes the database's `(variantId, effectiveAt)` upsert and this function
 * agree about what "the same instant" means.
 *
 * Rows with an unusable instant are dropped rather than sorted to the front,
 * where they would silently become the opening cost basis for all history.
 */
export function normaliseCostTimeline(
  versions: readonly CostVersion[],
): CostVersion[] {
  const byInstant = new Map<number, CostVersion>();

  for (const version of versions) {
    const at = timeOf(version);
    if (!Number.isFinite(at)) continue;
    byInstant.set(at, version);
  }

  return [...byInstant.values()].sort((a, b) => timeOf(a) - timeOf(b));
}

/**
 * The cost in effect at `at`, or null if the timeline had not started yet.
 *
 * Null is a real answer and deliberately not zero: "we did not know this
 * variant's cost then" and "it cost nothing" produce the same profit number but
 * demand opposite responses, and the caller is the only one that can tell which
 * of the two it is looking at.
 *
 * `effectiveAt` is inclusive — a cost effective at noon applies to an order
 * processed at noon. Half-open the other way would make a cost recorded from an
 * invoice timestamp miss the very order that invoice covers.
 */
export function costEffectiveAt(
  timeline: readonly CostVersion[],
  at: Date,
): CostVersion | null {
  const target = at.getTime();
  if (!Number.isFinite(target)) return null;

  // Binary search for the last version at or before `at`. A restatement
  // resolves this once per line item across a whole quarter, so the linear
  // scan this replaces was the difference between seconds and minutes.
  let low = 0;
  let high = timeline.length - 1;
  let found: CostVersion | null = null;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = timeline[mid]!;
    if (timeOf(candidate) <= target) {
      found = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found;
}

/**
 * The earliest instant at which two timelines disagree, or null if they never do.
 *
 * This is what keeps a restatement proportionate. A merchant correcting last
 * March's freight cost has changed nothing about February, and rewriting
 * February anyway would burn minutes of work and, worse, stamp a restatement on
 * a period whose numbers did not move — which is exactly the kind of noise that
 * makes an audit trail useless.
 *
 * Both functions are piecewise-constant and change value only at a breakpoint,
 * so comparing them at the union of their breakpoints is exhaustive rather than
 * a sample. Before the first breakpoint both resolve to null, so that region
 * needs no check.
 */
export function costDivergenceFrom(
  before: readonly CostVersion[],
  after: readonly CostVersion[],
): Date | null {
  const left = normaliseCostTimeline(before);
  const right = normaliseCostTimeline(after);

  const breakpoints = [
    ...new Set([...left, ...right].map((version) => timeOf(version))),
  ].sort((a, b) => a - b);

  for (const instant of breakpoints) {
    const at = new Date(instant);
    const a = costEffectiveAt(left, at);
    const b = costEffectiveAt(right, at);

    // A version appearing or disappearing is a divergence even when the number
    // is unchanged, because "unknown" and "zero" are not the same claim.
    if ((a === null) !== (b === null)) return at;
    if (a && b && a.unitCostMicros !== b.unitCostMicros) return at;
  }

  return null;
}

export interface CostSegment {
  unitCostMicros: Micros;
  source: string;
  from: Date;
  /** Null means still in effect. */
  toExclusive: Date | null;
}

/**
 * The timeline as closed intervals, which is the shape a history table wants.
 *
 * Adjacent versions carrying the same cost are merged: a re-observed identical
 * cost is evidence that nothing changed, and rendering it as a "change" invites
 * a merchant to go looking for an edit that never happened.
 */
export function costSegments(
  versions: readonly CostVersion[],
): CostSegment[] {
  const timeline = normaliseCostTimeline(versions);
  const segments: CostSegment[] = [];

  for (const version of timeline) {
    const open = segments[segments.length - 1];
    if (open && open.unitCostMicros === version.unitCostMicros) continue;

    if (open) open.toExclusive = version.effectiveAt;
    segments.push({
      unitCostMicros: version.unitCostMicros,
      source: version.source,
      from: version.effectiveAt,
      toExclusive: null,
    });
  }

  return segments;
}
