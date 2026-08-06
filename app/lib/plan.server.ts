import prisma from "~/db.server";
import type { ShopContext } from "~/lib/auth.server";
import { planIdForSubscriptionName } from "~/lib/billing.server";
import { PLANS, type PlanId } from "~/shopify.server";

/**
 * Which plan a store is on, and what that entitles it to.
 *
 * Meridian bills through the Shopify **Billing API**, not Shopify App Pricing.
 * Requirement 1.2.1 permits either — "Your app must use Shopify App Pricing or
 * the Shopify Billing API for any app charges" — so this is a deliberate choice
 * and not a forced one. App Pricing is Shopify's default at submission, and the
 * Billing API is documented as legacy; both were re-verified against live docs
 * on 6 August 2026 and neither carries a deadline. `SUBMISSION.md` § "Billing"
 * has the quotes and the URLs.
 *
 * What the Billing API buys: `billing.check` reads the plan from the same Admin
 * session as everything else here, and `app_subscriptions/update` is still
 * delivered for Billing API charges. Under App Pricing both of those go away —
 * as of 28 April 2026 it sends no subscription webhooks, and plan reads move to
 * the Partner API, which is our own Partner org's credential held as a backend
 * secret, plus the `plan_handle` redirect parameter for changes between polls.
 *
 * That is a second credential and a non-Admin-API dependency for no requirement
 * gain, which is the reason not to migrate. It is *not* that App Pricing cannot
 * be read from a merchant session — an earlier version of this comment said so
 * and it was wrong.
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
 *
 * `multiChannelAds: "growth"` used to sit here, and it was the same defect this
 * module was written to fix, one layer down: it was advertised on `/app/plan`,
 * asserted by a test, and passed to `planAllows` from nowhere at all — the
 * other three gates each have a real call site. It could not have had one,
 * because no code path in the repo connects an ad platform or writes `AdSpend`
 * outside `prisma/seed.ts`. A gate over a capability that cannot exist is not a
 * gate; removing it is what makes the remaining three mean something. See the
 * header of `plans.ts` for what has to ship before it comes back.
 */
export const FEATURE_MIN_PLAN = {
  /** Pricing recommendations from fitted demand curves. */
  pricing: "growth",
  /** Fulfilment capacity modelling and backlog alerts. */
  capacity: "growth",
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
