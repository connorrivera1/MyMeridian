import prisma from "~/db.server";
import type { ShopContext } from "~/lib/auth.server";
import { planIdForSubscriptionName } from "~/lib/billing.server";
import { PLANS, type PlanId } from "~/shopify.server";

/**
 * Which plan a store is on, and what that entitles it to.
 *
 * Meridian bills through the Shopify **Billing API**, not Shopify App Pricing.
 * That choice is forced rather than stylistic: as of 28 April 2026 App Pricing
 * no longer sends `app_subscriptions/update`, and the only way to read a plan
 * under it is the Partner API — a separate organisation-level credential the
 * app does not hold and cannot obtain at runtime. The Billing API keeps the
 * plan readable from the same Admin session the rest of the app already has.
 *
 * The app previously declared both models at once and enforced neither: three
 * Billing API plans in `shopify.server.ts`, managed-pricing wording in the toml
 * and the subscription webhook, and no `billing.check` anywhere. Every feature
 * sold as Growth- or Scale-only was served to every store.
 */

/** Ordering, so a check is "at least this plan" rather than an equality test. */
const PLAN_RANK: Record<PlanId, number> = {
  starter: 1,
  growth: 2,
  scale: 3,
};

/**
 * Gated capabilities, each naming the lowest plan that includes it.
 *
 * These mirror the feature lists in `PLANS` exactly. If the two disagree the
 * app is selling something it does not deliver, so `plan.test.ts` asserts that
 * every gate here appears in the marketing copy of the plan it belongs to.
 */
export const FEATURE_MIN_PLAN = {
  /** Pricing recommendations from fitted demand curves. */
  pricing: "growth",
  /** Fulfilment capacity modelling and backlog alerts. */
  capacity: "growth",
  /** More than one connected ad channel, and blended CAC across them. */
  multiChannelAds: "growth",
  /** Cohort lifetime value and payback curves. */
  cohorts: "scale",
} as const satisfies Record<string, PlanId>;

export type Feature = keyof typeof FEATURE_MIN_PLAN;

export interface PlanState {
  /**
   * Null when the store has no active charge. The app is not usable in that
   * state — every dashboard route sends the merchant to the plan picker.
   */
  planId: PlanId | null;
  /** Raw Shopify status, for display. */
  status: string;
  trialEndsAt: Date | null;
  /**
   * True for the seeded demo, which has no Shopify subscription to read and is
   * shown at the top plan so the demo exercises every screen.
   */
  isDemo: boolean;
}

export function planAllows(state: PlanState, feature: Feature): boolean {
  if (!state.planId) return false;
  return PLAN_RANK[state.planId] >= PLAN_RANK[FEATURE_MIN_PLAN[feature]];
}

/** The cheapest plan that includes a feature, for "upgrade to X" copy. */
export function planFor(feature: Feature): (typeof PLANS)[PlanId] {
  return PLANS[FEATURE_MIN_PLAN[feature]];
}

/**
 * Charges are only real in production. A test charge on a development store
 * shows the full approval screen without ever taking money, which is what a
 * Shopify reviewer needs; a real charge against a dev store is rejected by
 * Shopify outright.
 */
export const billingIsTest = process.env.NODE_ENV !== "production";

/**
 * How long a stored plan is trusted before it is re-read from Shopify.
 *
 * `app_subscriptions/update` normally keeps the row current, so this only
 * covers a missed or undelivered webhook. Short enough that a merchant who
 * just paid is not locked out for long, long enough that a busy dashboard is
 * not making a Billing API call per page view.
 */
const PLAN_CACHE_MS = 10 * 60 * 1000;

/**
 * Resolve the current plan, reading Shopify only when the stored answer is
 * missing or stale.
 */
export async function resolvePlan(ctx: ShopContext): Promise<PlanState> {
  if (ctx.isDemo) {
    return {
      planId: "scale",
      status: "demo",
      trialEndsAt: null,
      isDemo: true,
    };
  }

  const stored = await prisma.subscription.findUnique({
    where: { shopId: ctx.shop.id },
  });

  const fresh =
    stored && Date.now() - stored.updatedAt.getTime() < PLAN_CACHE_MS;

  if (fresh) return fromRow(stored);

  // No billing context means no Shopify session to ask — fall back to whatever
  // was last recorded rather than locking a merchant out on a transient gap.
  if (!ctx.billing) return stored ? fromRow(stored) : emptyState();

  let planId: PlanId | null = null;
  let status = "none";

  try {
    const result = await ctx.billing.check({ isTest: billingIsTest });

    // A store can technically hold more than one active charge — take the most
    // generous, so a merchant mid-upgrade is never gated below what they pay.
    for (const subscription of result.appSubscriptions ?? []) {
      const candidate = planIdForSubscriptionName(subscription.name);
      if (!candidate) continue;
      if (!planId || PLAN_RANK[candidate] > PLAN_RANK[planId]) {
        planId = candidate;
        status = "active";
      }
    }

    if (!planId && result.appSubscriptions?.length) {
      console.error(
        `[billing] ${ctx.shop.domain}: active subscriptions ` +
          `${result.appSubscriptions.map((s) => `"${s.name}"`).join(", ")} ` +
          `match no plan in PLANS — the Partner Dashboard names have drifted`,
      );
    }
  } catch (error) {
    // Shopify being unreachable must not lock a paying merchant out of the app
    // they have already been charged for.
    console.error(`[billing] check failed for ${ctx.shop.domain}:`, error);
    return stored ? fromRow(stored) : emptyState();
  }

  const data = {
    plan: planId ?? "none",
    status,
    trialEndsAt: stored?.trialEndsAt ?? null,
  };

  const row = await prisma.subscription.upsert({
    where: { shopId: ctx.shop.id },
    create: { shopId: ctx.shop.id, ...data },
    update: data,
  });

  return fromRow(row);
}

function fromRow(row: {
  plan: string;
  status: string;
  trialEndsAt: Date | null;
}): PlanState {
  const planId = row.plan in PLANS ? (row.plan as PlanId) : null;

  return {
    // "trial" and "none" are both stored as non-plans; neither grants access,
    // because the Billing API's trial is part of a subscription rather than a
    // state that precedes one.
    planId,
    status: row.status,
    trialEndsAt: row.trialEndsAt,
    isDemo: false,
  };
}

function emptyState(): PlanState {
  return { planId: null, status: "none", trialEndsAt: null, isDemo: false };
}
