import { describe, expect, it } from "vitest";

process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-shopify-api-secret";
process.env.SHOPIFY_APP_URL = "https://meridian-test.example.com";
process.env.SCOPES = "read_orders,read_products";

const { FEATURE_MIN_PLAN, planAllows, planFor } = await import("./plan.server");
const { PLANS } = await import("~/shopify.server");
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
    expect(planAllows(on("scale"), "cohorts")).toBe(true);
  });

  it("withholds a feature from plans below it", () => {
    expect(planAllows(on("starter"), "pricing")).toBe(false);
    expect(planAllows(on("starter"), "capacity")).toBe(false);
    expect(planAllows(on("growth"), "cohorts")).toBe(false);
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
    expect(planFor("cohorts").id).toBe("scale");
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
    PLANS[planId].features.join(" ").toLowerCase();

  it("Growth advertises pricing recommendations and capacity alerts", () => {
    expect(advertised("growth")).toContain("pricing recommendations");
    expect(advertised("growth")).toContain("capacity");
    expect(FEATURE_MIN_PLAN.pricing).toBe("growth");
    expect(FEATURE_MIN_PLAN.capacity).toBe("growth");
  });

  it("Growth advertises multiple ad channels", () => {
    expect(advertised("growth")).toContain("ad channels");
    expect(FEATURE_MIN_PLAN.multiChannelAds).toBe("growth");
  });

  it("Scale advertises cohort LTV and payback", () => {
    expect(advertised("scale")).toContain("cohort ltv");
    expect(advertised("scale")).toContain("payback");
    expect(FEATURE_MIN_PLAN.cohorts).toBe("scale");
  });
});
