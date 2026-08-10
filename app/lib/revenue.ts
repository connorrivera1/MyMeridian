import { PLANS, type PlanId } from "~/lib/plans";

/**
 * Revenue metrics over Meridian's own subscriptions.
 *
 * Pure functions over rows, no Prisma — the MCP server and any future ops
 * screen feed them the same shapes, and the arithmetic is testable without a
 * database. All amounts are integer cents; the same discipline as the profit
 * engine, for the same reason.
 *
 * MRR convention: an annual subscriber contributes annualPrice / 12, rounded
 * half-away-from-zero once per subscriber. Trialling subscribers are counted
 * in `trialing` and NOT in MRR — Shopify has not charged them yet, and revenue
 * that has not been charged is a forecast, not a figure. This app's whole
 * premise is not blurring that line.
 */

export interface SubscriptionRow {
  plan: string;
  interval: string;
  status: string;
  trialEndsAt: Date | null;
}

export interface SubscriptionEventRow {
  plan: string;
  interval: string;
  status: string;
  occurredAt: Date;
}

const ACTIVE = new Set(["active", "accepted"]);
const ENDED = new Set(["cancelled", "canceled", "expired", "declined", "frozen"]);

const isPlanId = (plan: string): plan is PlanId => plan in PLANS;

function monthlyCentsFor(plan: PlanId, interval: string): number {
  const p = PLANS[plan];
  return interval === "annual"
    ? Math.round((p.annualPrice * 100) / 12)
    : p.price * 100;
}

export interface RevenueSummary {
  mrrCents: number;
  arrCents: number;
  activeSubscribers: number;
  trialing: number;
  byPlan: Record<
    PlanId,
    { monthly: number; annual: number; mrrCents: number }
  >;
}

export function summariseRevenue(
  rows: readonly SubscriptionRow[],
  now: Date,
): RevenueSummary {
  const byPlan = Object.fromEntries(
    Object.keys(PLANS).map((id) => [id, { monthly: 0, annual: 0, mrrCents: 0 }]),
  ) as RevenueSummary["byPlan"];

  let mrrCents = 0;
  let activeSubscribers = 0;
  let trialing = 0;

  for (const row of rows) {
    if (!ACTIVE.has(row.status) || !isPlanId(row.plan)) continue;

    // Trial still running: a subscriber, not yet revenue.
    if (row.trialEndsAt && row.trialEndsAt.getTime() > now.getTime()) {
      trialing += 1;
      continue;
    }

    const cents = monthlyCentsFor(row.plan, row.interval);
    mrrCents += cents;
    activeSubscribers += 1;

    const bucket = byPlan[row.plan];
    if (row.interval === "annual") bucket.annual += 1;
    else bucket.monthly += 1;
    bucket.mrrCents += cents;
  }

  return {
    mrrCents,
    arrCents: mrrCents * 12,
    activeSubscribers,
    trialing,
    byPlan,
  };
}

export interface MovementSummary {
  windowDays: number;
  started: number;
  ended: number;
  /** Ends per starting subscriber would need a cohort; this is the blunt
   *  version: ends in the window over actives now plus those ends. Honest
   *  enough for a pulse check, and labelled as what it is. */
  churnRatePct: number | null;
}

export function summariseMovement(
  events: readonly SubscriptionEventRow[],
  activeNow: number,
  windowDays: number,
  now: Date,
): MovementSummary {
  const cutoff = now.getTime() - windowDays * 86_400_000;

  let started = 0;
  let ended = 0;

  for (const event of events) {
    if (event.occurredAt.getTime() < cutoff) continue;
    if (ACTIVE.has(event.status)) started += 1;
    else if (ENDED.has(event.status)) ended += 1;
  }

  const base = activeNow + ended;

  return {
    windowDays,
    started,
    ended,
    churnRatePct: base > 0 ? Math.round((ended / base) * 1000) / 10 : null,
  };
}
