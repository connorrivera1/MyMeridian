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
 * **Nothing here may promise ad spend, CAC, ROAS or connected ad platforms.**
 * There is a `Connector` model, encrypted token storage and a settings row for
 * Meta, Google and TikTok, but no OAuth flow and no platform API client
 * anywhere in the tree — `provision.server.ts` creates every connector
 * `NOT_CONFIGURED` and nothing ever configures one. The seed no longer writes
 * `AdSpend` either, so both demo and real stores disclose spend as unavailable
 * unless a future connector or explicit import creates measured rows.
 *
 * Starter used to sell "One ad channel connected" and Growth "Unlimited ad
 * channels + blended CAC". A reviewer walks `/app/plan` during billing review
 * and compares the listing against a real install, so that was a bounce waiting
 * to happen rather than a wording preference. `plan.test.ts` now fails if the
 * claim is put back; lift that test when the connectors ship, not before.
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
    blurb: "Core profitability reporting",
    features: [
      "Order profit after configured costs",
      "Product margin analysis",
      "Revenue and profit by channel",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    price: 149,
    annualPrice: 1490,
    blurb: "Pricing and fulfilment tools",
    features: [
      "Everything in Starter",
      "Pricing recommendations",
      "Fulfilment capacity alerts",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    price: 399,
    annualPrice: 3990,
    blurb: "Growth tools with priority support",
    features: [
      "Everything in Growth",
      "Priority support",
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

export type BillingKey = PlanId | `${PlanId}${typeof ANNUAL_SUFFIX}`;

export function annualKey(id: PlanId): BillingKey {
  return `${id}${ANNUAL_SUFFIX}`;
}

/** The plan a billing key belongs to, whichever interval it names. */
export function basePlanId(key: string): PlanId | null {
  const base = key.endsWith(ANNUAL_SUFFIX)
    ? key.slice(0, -ANNUAL_SUFFIX.length)
    : key;
  return base in PLANS ? (base as PlanId) : null;
}

/** Length of the free trial attached to every Billing API subscription. */
export const TRIAL_DAYS = 14;
