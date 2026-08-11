import prisma from "~/db.server";
import { redirect } from "react-router";
import type { ShopContext } from "~/lib/auth.server";
import { planIdForSubscriptionName } from "~/lib/billing.server";
import { PLANS, type PlanId } from "~/lib/plans";
import { refreshShopPlanSignal } from "~/lib/shop-plan.server";

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
 * other gates each have a real call site. It could not have had one,
 * because no code path in the repo connects an ad platform or writes `AdSpend`
 * outside `prisma/seed.ts`. A gate over a capability that cannot exist is not a
 * gate; removing it is what makes the remaining gates mean something. See the
 * header of `plans.ts` for what has to ship before it comes back.
 *
 * `cohorts: "scale"` was removed for the same product-truth reason. The gate
 * had a call site, but the default OAuth request has no `read_customers` scope,
 * so no real subscriber could satisfy the data prerequisite. Protected-data
 * approval, the requested scope, and a real-store verification must land before
 * cohort analysis can become a paid entitlement again.
 */
export const FEATURE_MIN_PLAN = {
  /** Pricing recommendations from fitted demand curves. */
  pricing: "growth",
  /** Fulfilment capacity modelling and backlog alerts. */
  capacity: "growth",
  /** Daily margin, refund, missing-cost and connector-health monitoring. */
  anomalyAlerts: "growth",
  /** Merchant-managed Meta, Google Ads and TikTok Ads OAuth connections. */
  adConnections: "growth",
  /** Merchant-managed ShipStation label-cost reconciliation. */
  carrierConnections: "growth",
  /** Automated weekly profit email. */
  scheduledReports: "scale",
  /** Streamed accountant-grade order profitability export. */
  exports: "scale",
  /** One web account may manage more than one connected Shopify store. */
  multiStore: "scale",
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
 * Whether Shopify should create/read test charges for this store.
 *
 * Runtime mode is not store type. Fly correctly runs with NODE_ENV=production,
 * including during App Store review, while the review install uses a
 * development store that rejects real charges. Shopify's durable
 * ShopPlan.partnerDevelopment field is the only production store-type signal;
 * display labels and operator overrides can both become stale after a store
 * conversion.
 */
export function billingIsTestForShop(
  shop: {
    domain: string;
    partnerDevelopment?: boolean | null;
    isDemo?: boolean;
  },
  env: { NODE_ENV?: string } = {
    NODE_ENV: process.env.NODE_ENV,
  },
): boolean {
  if (shop.isDemo || env.NODE_ENV !== "production") return true;
  return shop.partnerDevelopment === true;
}

/**
 * Resolve charge mode immediately before creating a subscription.
 *
 * A development store can later become a paid merchant store. The stored
 * signal is useful for read-only UI and billing checks, but is never trusted
 * for a new charge in production: every charge refreshes
 * ShopPlan.partnerDevelopment from Shopify first. A failed lookup blocks the
 * request; guessing `isTest` could either take real money from a review store
 * or create a non-paying test subscription for a live merchant.
 */
export async function resolveBillingChargeMode(
  ctx: ShopContext,
  env: { NODE_ENV?: string } = {
    NODE_ENV: process.env.NODE_ENV,
  },
): Promise<boolean> {
  if (ctx.isDemo || env.NODE_ENV !== "production") return true;

  if (!ctx.admin) {
    throw new Error("Cannot verify Shopify store type without an Admin session");
  }

  return refreshShopPlanSignal(ctx.shop.id, ctx.admin);
}

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

  let billingIsTest = billingIsTestForShop(ctx.shop);
  let forceBillingRefresh = false;

  // SHOP_UPDATE deliberately clears the signal because development stores can
  // be converted to paid stores. Before trusting a cached subscription again,
  // resolve that uncertainty and re-check the matching test/real subscription
  // namespace. Otherwise a converted store could retain app access forever on
  // its old test charge simply because the Subscription row was still fresh.
  if (
    process.env.NODE_ENV === "production" &&
    typeof ctx.shop.partnerDevelopment !== "boolean"
  ) {
    if (!ctx.admin || !ctx.billing) return emptyState();
    try {
      billingIsTest = await refreshShopPlanSignal(ctx.shop.id, ctx.admin);
      // The loader that called resolvePlan still holds this Shop object. Keep
      // its in-request snapshot aligned with the persisted row so the Plan
      // page's test-charge banner cannot contradict the mode just resolved.
      ctx.shop.partnerDevelopment = billingIsTest;
      forceBillingRefresh = true;
    } catch (error) {
      console.error(
        `[billing] could not refresh store type for ${ctx.shop.domain}:`,
        error,
      );
      return emptyState();
    }
  }

  const stored = await prisma.subscription.findUnique({
    where: { shopId: ctx.shop.id },
  });

  const fresh =
    !forceBillingRefresh &&
    stored &&
    Date.now() - stored.updatedAt.getTime() < PLAN_CACHE_MS;

  if (fresh) return fromRow(stored);

  // No billing context means no Shopify session to ask — fall back to whatever
  // was last recorded rather than locking a merchant out on a transient gap.
  if (!ctx.billing) return stored ? fromRow(stored) : emptyState();

  let planId: PlanId | null = null;
  let status = "none";

  try {
    const result = await ctx.billing.check({
      isTest: billingIsTest,
    });

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
    // This check was forced by SHOP_UPDATE invalidation. The cached row might
    // be an old test subscription on a store that just converted to paid, and
    // Subscription has no trustworthy mode marker. Fail closed until Shopify
    // can confirm a matching subscription instead of restoring stale access.
    if (forceBillingRefresh) return emptyState();
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

/**
 * Security boundary for paid child loaders/actions.
 *
 * React Router can execute a child loader without its parent during selective
 * single-fetch requests. The layout redirect is useful navigation UX, but it
 * cannot be the entitlement check. Every paid data path calls this shared
 * guard before touching analytics or merchant settings; `/app/plan` is the
 * deliberate exception and calls resolvePlan directly.
 */
export async function requireActivePlan(
  ctx: ShopContext,
  request: Request,
): Promise<PlanState & { planId: PlanId }> {
  const plan = await resolvePlan(ctx);
  if (plan.planId) return plan as PlanState & { planId: PlanId };

  const url = new URL(request.url);
  const search = new URLSearchParams(url.searchParams);
  // Internal selective-fetch controls must not survive into the browser URL.
  search.delete("_routes");
  search.delete("index");
  const suffix = search.size ? `?${search.toString()}` : "";
  throw redirect(`/app/plan${suffix}`);
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
