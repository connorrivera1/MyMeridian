/**
 * The plan catalogue, client-safe.
 *
 * This is deliberately not in `shopify.server.ts`, even though that is where
 * `shopifyApp()` consumes it. A route module may only export `loader`,
 * `action`, `middleware` and `headers` if it wants its server imports stripped
 * from the client bundle — so a component that renders a price list while
 * importing from `~/shopify.server` drags the whole Shopify server config into
 * the browser build and fails it outright with "Server-only module referenced
 * by client". The plan screen and the settings screen both do exactly that.
 *
 * Nothing here touches `process.env` or any Node API, so it is safe on both
 * sides. `shopify.server.ts` imports it to build the Billing API config.
 *
 * Every plan may connect the sources that make profitability honest. Growth is
 * the decision layer, not a paywall around the merchant's own cost data. It
 * still may not promise cohort/LTV analysis because the app does not request
 * the protected customer scope that analysis requires.
 *
 * What survives is what the code actually does without a platform token:
   * orders are attributed to a channel from their UTM parameters and referring
   * site (`sync.server.ts`), and each channel carries order-derived revenue plus
   * contribution from the available cost inputs (`ChannelPerformance`). Missing
   * COGS and modeled costs remain visibly qualified. That is true on Starter, so
   * it is sold there.
 *
 * Cohort LTV and payback are equally real engine capabilities and equally
 * unavailable to a normal install: both need `read_customers`, which is not in
 * the requested scope set and must not be added before Shopify approves the
 * protected-customer-data request. Scale used to sell those curves anyway.
 * The engine remains ready for an approved future release, but no paid plan may
 * promise the feature before that scope is both approved and requested.
 */
export const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    price: 49,
    annualPrice: 490,
    blurb: "Know what you actually kept.",
    features: [
      "Overview, order, product and channel profitability",
      "Costs, bundles and configured-estimate controls",
      "Meta, Google and TikTok ad-spend connections",
      "ShipStation and available Shopify Shipping costs",
      "Profit data quality and missing-data alerts",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    price: 129,
    annualPrice: 1290,
    blurb: "Know what deserves attention next.",
    features: [
      "Everything in Starter",
      "Evidence-backed pricing recommendations and outcome history",
      "What Should I Do? diagnosis and proactive alerts",
      "Fulfilment forecast and capacity warnings",
      "Advanced acquisition economics when authorised data is available",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    price: 299,
    annualPrice: 2990,
    blurb: "Operate profitability across a larger business.",
    features: [
      "Everything in Growth",
      "Scheduled weekly profitability summaries",
      "Advanced CSV and accountant-ready exports",
      "Multi-store portfolio and rollup access",
    ],
  },
} as const;

export type PlanId = keyof typeof PLANS;

/**
 * Annual billing.
 *
 * Annual is 10x monthly — two months free, about 17% — matching the convention
 * Connor settled on for RankForge. Kept as whole dollars: an annual price with
 * cents reads as calculated at the buyer, not for them.
 *
 * Each plan has a second Billing API key, `<id>-annual`. The SUFFIX is load
 * bearing in three places that must agree: the billing config in
 * shopify.server.ts is keyed by it, the plan page submits it, and
 * planIdForSubscriptionName() strips it when Shopify hands the subscription
 * name back through billing.check and the subscription webhook.
 */
export const ANNUAL_SUFFIX = "-annual";
/**
 * Billing keys with this suffix tell Shopify to preserve the merchant's
 * current subscription until its current billing period ends. The separate
 * key is deliberate: Shopify's replacement behaviour belongs to the billing
 * configuration, while the selection route must choose it dynamically based
 * on whether a merchant is moving down a tier.
 */
export const NEXT_CYCLE_SUFFIX = "-next-cycle";
/** A normal mid-cycle plan replacement. Plan changes never restart a trial. */
export const CHANGE_SUFFIX = "-change";
/** A server-authorised, monthly-only founding benefit. This is not a public
 * code: the plan key is accepted only after an entitlement reservation. */
export const FOUNDING_SUFFIX = "-founding";

export type StandardBillingKey =
  | PlanId
  | `${PlanId}${typeof ANNUAL_SUFFIX}`;
export type FoundingBillingKey = `${PlanId}${typeof FOUNDING_SUFFIX}`;
export type BillingKey =
  | StandardBillingKey
  | FoundingBillingKey
  | `${StandardBillingKey}${typeof CHANGE_SUFFIX}`
  | `${StandardBillingKey}${typeof NEXT_CYCLE_SUFFIX}`;

export type BillingKeyKind = "initial" | "change" | "downgrade";

export function annualKey(id: PlanId): StandardBillingKey {
  return `${id}${ANNUAL_SUFFIX}`;
}

/** A deferred-replacement key for a lower tier selected mid-cycle. */
export function nextCycleKey(key: StandardBillingKey): BillingKey {
  return `${key}${NEXT_CYCLE_SUFFIX}`;
}

/** A mid-cycle replacement key that does not grant a second free trial. */
export function changeKey(key: StandardBillingKey): BillingKey {
  return `${key}${CHANGE_SUFFIX}`;
}

/** A discounted monthly key that the server issues only for a reserved offer. */
export function foundingKey(id: PlanId): FoundingBillingKey {
  return `${id}${FOUNDING_SUFFIX}`;
}

/** Parse only the exact billing-key shapes declared in Shopify config. */
export function billingKeyInfo(
  key: string,
): { planId: PlanId; kind: BillingKeyKind; founding: boolean } | null {
  let kind: BillingKeyKind = "initial";
  const withoutDeferral = key.endsWith(NEXT_CYCLE_SUFFIX)
    ? key.slice(0, -NEXT_CYCLE_SUFFIX.length)
    : key.endsWith(CHANGE_SUFFIX)
      ? key.slice(0, -CHANGE_SUFFIX.length)
      : key;
  if (withoutDeferral !== key) {
    kind = key.endsWith(NEXT_CYCLE_SUFFIX) ? "downgrade" : "change";
  }
  const founding = withoutDeferral.endsWith(FOUNDING_SUFFIX);
  const withoutFounding = founding
    ? withoutDeferral.slice(0, -FOUNDING_SUFFIX.length)
    : withoutDeferral;
  // The benefit is explicitly monthly and is only granted to a new
  // subscription. No "annual-founding" or plan-change variant exists.
  if (founding && (kind !== "initial" || withoutFounding.endsWith(ANNUAL_SUFFIX))) {
    return null;
  }

  const base = withoutFounding.endsWith(ANNUAL_SUFFIX)
    ? withoutFounding.slice(0, -ANNUAL_SUFFIX.length)
    : withoutFounding;

  if (!(base in PLANS)) return null;

  if (
    withoutFounding !== base &&
    withoutFounding !== `${base}${ANNUAL_SUFFIX}`
  ) {
    return null;
  }

  return { planId: base as PlanId, kind, founding };
}

/** Whether this is one of the exact keys declared in Shopify billing config. */
export function isBillingKey(key: string): key is BillingKey {
  return billingKeyInfo(key) !== null;
}

/** The plan a billing key belongs to, whichever interval it names. */
export function basePlanId(key: string): PlanId | null {
  return billingKeyInfo(key)?.planId ?? null;
}

/** Whether a billing key is for an annual subscription interval. */
export function billingKeyIsAnnual(key: string): boolean {
  const info = billingKeyInfo(key);
  if (!info) return false;

  const withoutSuffix = key
    .replace(NEXT_CYCLE_SUFFIX, "")
    .replace(CHANGE_SUFFIX, "")
    .replace(FOUNDING_SUFFIX, "");
  return withoutSuffix.endsWith(ANNUAL_SUFFIX);
}

/** Length of the free trial attached to every Billing API subscription. */
export const TRIAL_DAYS = 14;

/** Shopify usage line-item terms for soft order overage. The meter's order
 * thresholds are plan-specific; this is the maximum Shopify can collect in a
 * billing period, not a hard application stop. */
export const USAGE_CAP_AMOUNT = 50;
export const USAGE_TERMS =
  "$0.05 per order above MyMeridian's soft monthly order threshold; capped at $50";
