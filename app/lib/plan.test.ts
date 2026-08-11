import { describe, expect, it } from "vitest";

process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-shopify-api-secret";
process.env.SHOPIFY_APP_URL = "https://meridian-test.example.com";
process.env.SCOPES = "read_orders,read_products";

const { FEATURE_MIN_PLAN, planAllows, planFor } = await import("./plan.server");
const { PLANS } = await import("~/lib/plans");
type PlanState = Parameters<typeof planAllows>[0];

const on = (plan: PlanState["planId"]): PlanState => ({
  planId: plan,
  status: plan ? "active" : "none",
  trialEndsAt: null,
  isDemo: false,
});

/**
 * The gates and the pricing page are two descriptions of the same promise. If
 * they drift, the app either sells something it does not deliver or gives away
 * something it charges for, and neither shows up as a failure anywhere else.
 */
describe("feature gating", () => {
  it("grants a feature at the plan that advertises it, and above", () => {
    expect(planAllows(on("growth"), "pricing")).toBe(true);
    expect(planAllows(on("scale"), "pricing")).toBe(true);
  });

  it("withholds a feature from plans below it", () => {
    expect(planAllows(on("starter"), "pricing")).toBe(false);
    expect(planAllows(on("starter"), "capacity")).toBe(false);
    expect(planAllows(on("starter"), "anomalyAlerts")).toBe(false);
    expect(planAllows(on("growth"), "scheduledReports")).toBe(false);
    expect(planAllows(on("growth"), "exports")).toBe(false);
  });

  it("grants nothing without an active plan", () => {
    // The Billing API's trial belongs to a subscription rather than preceding
    // one, so "no plan" is genuinely no access — not a trial tier.
    for (const feature of Object.keys(FEATURE_MIN_PLAN) as Array<
      keyof typeof FEATURE_MIN_PLAN
    >) {
      expect(planAllows(on(null), feature)).toBe(false);
    }
  });

  it("names the cheapest plan that includes a feature", () => {
    expect(planFor("pricing").id).toBe("growth");
  });

  it("gates only on plans that exist", () => {
    for (const minimum of Object.values(FEATURE_MIN_PLAN)) {
      expect(PLANS[minimum]).toBeDefined();
    }
  });
});

/**
 * Each gate has to be findable in the feature list of the plan that owns it,
 * otherwise a merchant is refused a screen they were never told they had to
 * pay for.
 */
describe("gates match what the plans advertise", () => {
  const advertised = (planId: keyof typeof PLANS) =>
    [PLANS[planId].blurb, ...PLANS[planId].features].join(" ").toLowerCase();

  it("Growth advertises pricing recommendations and capacity alerts", () => {
    expect(advertised("growth")).toContain("pricing recommendations");
    expect(advertised("growth")).toContain("capacity");
    expect(FEATURE_MIN_PLAN.pricing).toBe("growth");
    expect(FEATURE_MIN_PLAN.capacity).toBe("growth");
    expect(advertised("growth")).toContain("anomaly alerts");
    expect(FEATURE_MIN_PLAN.anomalyAlerts).toBe("growth");
    expect(advertised("growth")).toContain("meta");
    expect(advertised("growth")).toContain("google");
    expect(advertised("growth")).toContain("tiktok");
    expect(FEATURE_MIN_PLAN.adConnections).toBe("growth");
    expect(advertised("growth")).toContain("shipstation");
    expect(FEATURE_MIN_PLAN.carrierConnections).toBe("growth");
  });

  it("Scale advertises the reporting capabilities it gates", () => {
    expect(advertised("scale")).toContain("weekly profit summaries");
    expect(advertised("scale")).toContain("csv exports");
    expect(advertised("scale")).toContain("multi-store");
    expect(FEATURE_MIN_PLAN.scheduledReports).toBe("scale");
    expect(FEATURE_MIN_PLAN.exports).toBe("scale");
    expect(FEATURE_MIN_PLAN.multiStore).toBe("scale");
  });

  it("Starter advertises channel revenue and profit, which need no ad platform", () => {
    // Attribution comes from each order's UTM parameters and referring site in
    // `sync.server.ts`, and the profit is `ChannelPerformance.contributionProfitCents`,
    // computed from orders. Neither needs a platform token, so both are true on
    // the cheapest plan and are sold there.
    expect(advertised("starter")).toContain("channel");
  });

  it("no plan sells protected-customer analysis it cannot obtain", () => {
    const forbidden = [
      "cac",
      "roas",
      "blended",
      "return on ad spend",
      "cohort",
      "ltv",
      "payback",
      "loss leader",
      "loss-leader",
      "multi-location",
      "multi location",
    ];
    for (const planId of Object.keys(PLANS) as Array<keyof typeof PLANS>) {
      for (const claim of forbidden) {
        expect(
          advertised(planId),
          `${PLANS[planId].name} may not advertise "${claim}" without the required protected data`,
        ).not.toContain(claim);
      }
    }
  });

  it("gates nothing it cannot deliver", () => {
    // `multiChannelAds` had no implementation. `cohorts` had an engine and a
    // call site, but no real install can satisfy its unrequested
    // `read_customers` prerequisite. Every gate that remains has to be one a
    // subscriber can genuinely use with the requested scopes.
    expect(FEATURE_MIN_PLAN).not.toHaveProperty("multiChannelAds");
    expect(FEATURE_MIN_PLAN).not.toHaveProperty("cohorts");
  });

  it("does not sell per-location capacity while the rebuild is store-wide", () => {
    // `rebuildCapacityDays` currently aggregates every fulfilment into a single
    // `primary` row. Keep location-specific language out of the merchant-facing
    // catalogue until the rebuild and query path preserve locations end to end.
    for (const planId of Object.keys(PLANS) as Array<keyof typeof PLANS>) {
      expect(advertised(planId)).not.toMatch(/multi[- ]location|per[- ]location/);
    }
  });

  it("does not advertise order limits the billing gate never enforces", () => {
    for (const planId of Object.keys(PLANS) as Array<keyof typeof PLANS>) {
      expect(advertised(planId)).not.toMatch(
        /orders?\s*\/\s*month|unlimited orders?|order volume/,
      );
    }
  });
});
