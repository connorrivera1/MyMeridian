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
 */
export const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    price: 49,
    blurb: "Up to 1,000 orders / month",
    features: [
      "True profit per order",
      "Product margin analysis",
      "One ad channel connected",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    price: 149,
    blurb: "Up to 10,000 orders / month",
    features: [
      "Everything in Starter",
      "Unlimited ad channels + blended CAC",
      "Pricing recommendations",
      "Fulfilment capacity alerts",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    price: 399,
    blurb: "Unlimited orders",
    features: [
      "Everything in Growth",
      "Multi-location capacity modelling",
      "Cohort LTV and payback curves",
      "Priority support",
    ],
  },
} as const;

export type PlanId = keyof typeof PLANS;

/** Length of the free trial attached to every Billing API subscription. */
export const TRIAL_DAYS = 14;
