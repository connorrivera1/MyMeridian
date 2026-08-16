import { beforeEach, describe, expect, it, vi } from "vitest";

const shopFindFirst = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    shop: { findFirst: (...args: unknown[]) => shopFindFirst(...args) },
  },
}));

const {
  loadOperatorStore,
  latestChurnedShopIds,
  subscriptionRevenueCents,
  summarizeSubscriptions,
} = await import("./operator-data.server");

beforeEach(() => vi.clearAllMocks());

describe("operator business metrics", () => {
  it("uses the canonical monthly and annual prices", () => {
    expect(subscriptionRevenueCents({ plan: "starter", interval: "monthly" })).toEqual({
      mrrCents: 4_900,
      arrCents: 58_800,
    });
    expect(subscriptionRevenueCents({ plan: "starter", interval: "annual" })).toEqual({
      mrrCents: 49_000 / 12,
      arrCents: 49_000,
    });
    expect(subscriptionRevenueCents({ plan: "growth", interval: "annual" })?.mrrCents).toBeCloseTo(10_750);
    expect(subscriptionRevenueCents({ plan: "scale", interval: "annual" })?.mrrCents).toBeCloseTo(24_916.67, 2);
  });

  it("counts only the latest 30-day subscription transition as churn", () => {
    // Input is newest-first, matching the database query.
    expect(
      [...latestChurnedShopIds([
        { shopId: "reactivated", status: "ACTIVE" },
        { shopId: "reactivated", status: "CANCELLED" },
        { shopId: "churned", status: "CANCELLED" },
        { shopId: "churned", status: "ACTIVE" },
      ])],
    ).toEqual(["churned"]);
  });

  it("separates trials from paying stores and excludes demos/uninstalls", () => {
    const now = new Date("2026-08-11T00:00:00Z");
    const result = summarizeSubscriptions([
      { plan: "starter", interval: "monthly", status: "active", trialEndsAt: null, shop: { isDemo: false, uninstalledAt: null } },
      { plan: "growth", interval: "annual", status: "active", trialEndsAt: new Date("2026-08-20"), shop: { isDemo: false, uninstalledAt: null } },
      { plan: "scale", interval: "annual", status: "active", trialEndsAt: new Date("2026-08-01"), shop: { isDemo: false, uninstalledAt: null } },
      { plan: "scale", interval: "monthly", status: "active", trialEndsAt: null, shop: { isDemo: true, uninstalledAt: null } },
      { plan: "starter", interval: "monthly", status: "active", trialEndsAt: null, shop: { isDemo: false, uninstalledAt: now } },
    ], now);
    expect(result.activePayingStores).toBe(2);
    expect(result.trials).toBe(1);
    expect(result.planDistribution).toEqual({ starter: 1, growth: 0, scale: 1 });
    expect(result.mrrCents).toBe(29_817);
    expect(result.arrCents).toBe(357_800);
    expect(result.trialConversionRate).toBe(1);
  });
});

describe("operator store projection", () => {
  it("selects operational fields but never protected/default-hidden fields", async () => {
    shopFindFirst.mockResolvedValue(null);
    await loadOperatorStore("shop_1");
    const query = shopFindFirst.mock.calls[0]![0] as { select: unknown };
    const serialized = JSON.stringify(query.select);

    for (const forbidden of [
      "email",
      "name",
      "customer",
      "lineItems",
      "orderNumber",
      "payload",
      "recipient",
      "accessTokenEnc",
      "refreshTokenEnc",
      "webhookSecretEnc",
      "externalAccountId",
      "displayName",
      "syncError",
      "lastError",
    ]) {
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    }
    for (const required of [
      "domain",
      "subscription",
      "installedAt",
      "lastSyncedAt",
      "syncStatus",
      "grantedScopes",
      "connectors",
      "healthStatus",
    ]) {
      expect(serialized).toContain(`\"${required}\"`);
    }
  });
});
