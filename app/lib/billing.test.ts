import { describe, expect, it } from "vitest";

process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-shopify-api-secret";
process.env.SHOPIFY_APP_URL = "https://meridian-test.example.com";
process.env.SCOPES = "read_orders,read_products";

const { planIdForSubscriptionName } = await import("./billing.server");

/**
 * Plan selection happens on Shopify's billing screen, so the subscription name
 * in the Partner Dashboard is the only join between what a merchant pays for
 * and what this build gates on. A mismatch is silent by nature — the webhook
 * still returns 200 — so it is worth pinning the matching rules.
 */
describe("planIdForSubscriptionName", () => {
  it("matches the display names configured in the Partner Dashboard", () => {
    expect(planIdForSubscriptionName("Starter")).toBe("starter");
    expect(planIdForSubscriptionName("Growth")).toBe("growth");
    expect(planIdForSubscriptionName("Scale")).toBe("scale");
  });

  it("is tolerant of case and stray whitespace", () => {
    expect(planIdForSubscriptionName("  gROWTH ")).toBe("growth");
  });

  it("also accepts the plan id, which is what billing.request sends", () => {
    expect(planIdForSubscriptionName("scale")).toBe("scale");
  });

  it("returns null for a plan this build does not know", () => {
    // The webhook logs this loudly rather than silently billing on one plan
    // and gating on another.
    expect(planIdForSubscriptionName("Enterprise")).toBeNull();
    expect(planIdForSubscriptionName("Growth Plan")).toBeNull();
  });

  it("returns null for a missing or empty name", () => {
    expect(planIdForSubscriptionName(undefined)).toBeNull();
    expect(planIdForSubscriptionName("")).toBeNull();
    expect(planIdForSubscriptionName("   ")).toBeNull();
  });
});
