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

  it("Starter advertises channel revenue and profit, which need no ad platform", () => {
    // Attribution comes from each order's UTM parameters and referring site in
    // `sync.server.ts`, and the profit is `ChannelPerformance.contributionProfitCents`,
    // computed from orders. Neither needs a platform token, so both are true on
    // the cheapest plan and are sold there.
    expect(advertised("starter")).toContain("channel");
  });

  it("no plan sells ad spend, CAC or ROAS", () => {
    // Growth sold "Unlimited ad channels + blended CAC" and Starter "One ad
    // channel connected", and the app cannot do either: there is no ad-platform
    // OAuth flow and no platform API client in the tree, connectors are created
    // NOT_CONFIGURED and never configured, and the only writer of `AdSpend` is
    // `prisma/seed.ts`. The seeded demo therefore shows spend while every real
    // store shows $0.00 — and `/app/plan` is a screen the Shopify reviewer walks
    // during billing review, comparing it against a real install.
    //
    // This is the guard, not the fix: the fix was deleting the claims. Lift this
    // test in the same change that ships a real connector, and not before.
    const forbidden = [
      "ad channel",
      "ad channels",
      "ad spend",
      "cac",
      "roas",
      "blended",
      "return on ad spend",
    ];
    for (const planId of Object.keys(PLANS) as Array<keyof typeof PLANS>) {
      for (const claim of forbidden) {
        expect(
          advertised(planId),
          `${PLANS[planId].name} may not advertise "${claim}" — nothing in the repo can produce it on a real store`,
        ).not.toContain(claim);
      }
    }
  });

  it("gates nothing it cannot deliver", () => {
    // `multiChannelAds` lived in FEATURE_MIN_PLAN with no `planAllows` call site
    // anywhere, gating a capability that has no implementation. Every gate that
    // remains has to be one a plan genuinely buys.
    expect(FEATURE_MIN_PLAN).not.toHaveProperty("multiChannelAds");
  });

  it("Scale advertises cohort LTV and payback", () => {
    expect(advertised("scale")).toContain("cohort ltv");
    expect(advertised("scale")).toContain("payback");
    expect(FEATURE_MIN_PLAN.cohorts).toBe("scale");
  });
});
