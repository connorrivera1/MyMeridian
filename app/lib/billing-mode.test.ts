import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShopContext } from "./auth.server";

process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-shopify-api-secret";
process.env.SHOPIFY_APP_URL = "https://meridian-test.example.com";
process.env.SCOPES = "read_orders,read_products";

const refreshShopPlanSignal = vi.fn();
const subscriptionFindUnique = vi.fn();
const subscriptionUpsert = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    subscription: {
      findUnique: (...args: unknown[]) => subscriptionFindUnique(...args),
      upsert: (...args: unknown[]) => subscriptionUpsert(...args),
    },
  },
}));

vi.mock("~/lib/shop-plan.server", () => ({
  refreshShopPlanSignal: (...args: unknown[]) =>
    refreshShopPlanSignal(...args),
}));

const {
  billingIsTestForShop,
  requireActivePlan,
  resolveBillingChargeMode,
  resolvePlan,
} = await import("./plan.server");

function context(
  shop: Record<string, unknown>,
  admin: ShopContext["admin"] = { graphql: vi.fn() } as unknown as ShopContext["admin"],
): ShopContext {
  return {
    shop: { id: "shop-1", ...shop } as unknown as ShopContext["shop"],
    admin,
    billing: {} as ShopContext["billing"],
    session: { shop: String(shop.domain), id: "session-1" },
    isDemo: false,
    user: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("billing charge mode", () => {
  it("uses Shopify's durable signal for development stores in production", () => {
    expect(
      billingIsTestForShop(
        {
          domain: "review-store.myshopify.com",
          partnerDevelopment: true,
        },
        { NODE_ENV: "production" },
      ),
    ).toBe(true);
  });

  it("does not trust a stale development display label after conversion", () => {
    const convertedStore = {
      domain: "converted.myshopify.com",
      partnerDevelopment: false,
      // A stale label deliberately remains on the wider Shop row. Structural
      // typing lets this prove the billing function ignores it entirely.
      planName: "Development",
    };
    expect(
      billingIsTestForShop(
        convertedStore,
        { NODE_ENV: "production" },
      ),
    ).toBe(false);
  });

  it("uses real charges for a production merchant store by default", () => {
    expect(
      billingIsTestForShop(
        { domain: "merchant.myshopify.com", partnerDevelopment: false },
        { NODE_ENV: "production" },
      ),
    ).toBe(false);
  });

  it("refreshes the durable signal before every production charge", async () => {
    const ctx = context({
      domain: "converted.myshopify.com",
      partnerDevelopment: true,
    });
    refreshShopPlanSignal.mockResolvedValue(false);

    await expect(
      resolveBillingChargeMode(ctx, {
        NODE_ENV: "production",
      }),
    ).resolves.toBe(false);
    expect(refreshShopPlanSignal).toHaveBeenCalledWith("shop-1", ctx.admin);
  });

  it("queries a first-install review store instead of trusting an override", async () => {
    const ctx = context({
      domain: "review-store.myshopify.com",
      partnerDevelopment: null,
    });
    refreshShopPlanSignal.mockResolvedValue(true);

    await expect(
      resolveBillingChargeMode(ctx, {
        NODE_ENV: "production",
      }),
    ).resolves.toBe(true);
    expect(refreshShopPlanSignal).toHaveBeenCalledWith("shop-1", ctx.admin);
  });

  it("fails closed when production has no authenticated Admin client", async () => {
    const ctx = context(
      { domain: "merchant.myshopify.com", partnerDevelopment: null },
      null,
    );

    await expect(
      resolveBillingChargeMode(ctx, {
        NODE_ENV: "production",
      }),
    ).rejects.toThrow(/without an Admin session/);
    expect(refreshShopPlanSignal).not.toHaveBeenCalled();
  });

  it("rechecks billing after shop/update instead of trusting a cached test subscription", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const check = vi.fn().mockResolvedValue({ appSubscriptions: [] });
    const ctx = context({
      domain: "converted.myshopify.com",
      partnerDevelopment: null,
    });
    ctx.billing = { check } as unknown as ShopContext["billing"];
    refreshShopPlanSignal.mockResolvedValue(false);
    subscriptionFindUnique.mockResolvedValue({
      plan: "growth",
      status: "active",
      trialEndsAt: null,
      updatedAt: new Date(),
    });
    subscriptionUpsert.mockResolvedValue({
      plan: "none",
      status: "none",
      trialEndsAt: null,
    });

    await expect(resolvePlan(ctx)).resolves.toEqual({
      planId: null,
      status: "none",
      trialEndsAt: null,
      isDemo: false,
    });
    expect(refreshShopPlanSignal).toHaveBeenCalledWith("shop-1", ctx.admin);
    expect(ctx.shop.partnerDevelopment).toBe(false);
    expect(check).toHaveBeenCalledWith({ isTest: false });
    expect(subscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop-1" },
        update: expect.objectContaining({ plan: "none" }),
      }),
    );
  });

  it("blocks access after invalidation when the authoritative store type cannot be read", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const check = vi.fn();
    const ctx = context({
      domain: "uncertain.myshopify.com",
      partnerDevelopment: null,
    });
    ctx.billing = { check } as unknown as ShopContext["billing"];
    refreshShopPlanSignal.mockRejectedValue(new Error("Shopify unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(resolvePlan(ctx)).resolves.toEqual({
      planId: null,
      status: "none",
      trialEndsAt: null,
      isDemo: false,
    });
    expect(subscriptionFindUnique).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("does not restore a cached test plan when the post-conversion billing check fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const check = vi.fn().mockRejectedValue(new Error("billing unavailable"));
    const ctx = context({
      domain: "converted.myshopify.com",
      partnerDevelopment: null,
    });
    ctx.billing = { check } as unknown as ShopContext["billing"];
    refreshShopPlanSignal.mockResolvedValue(false);
    subscriptionFindUnique.mockResolvedValue({
      plan: "growth",
      status: "active",
      trialEndsAt: null,
      updatedAt: new Date(),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(resolvePlan(ctx)).resolves.toEqual({
      planId: null,
      status: "none",
      trialEndsAt: null,
      isDemo: false,
    });
    expect(ctx.shop.partnerDevelopment).toBe(false);
    expect(subscriptionUpsert).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("updates the in-request snapshot so a refreshed development store shows test mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const check = vi.fn().mockResolvedValue({
      appSubscriptions: [{ name: "Growth" }],
    });
    const ctx = context({
      domain: "review-store.myshopify.com",
      partnerDevelopment: null,
    });
    ctx.billing = { check } as unknown as ShopContext["billing"];
    refreshShopPlanSignal.mockResolvedValue(true);
    subscriptionFindUnique.mockResolvedValue(null);
    subscriptionUpsert.mockResolvedValue({
      plan: "growth",
      status: "active",
      trialEndsAt: null,
    });

    await expect(resolvePlan(ctx)).resolves.toMatchObject({ planId: "growth" });
    expect(check).toHaveBeenCalledWith({ isTest: true });
    expect(ctx.shop.partnerDevelopment).toBe(true);
    expect(
      billingIsTestForShop(ctx.shop, { NODE_ENV: "production" }),
    ).toBe(true);
  });

  it("rechecks Shopify instead of caching a recent cancellation", async () => {
    const check = vi.fn().mockResolvedValue({
      appSubscriptions: [{ name: "growth-change" }],
    });
    const ctx = context({
      domain: "replacement-race.myshopify.com",
      partnerDevelopment: true,
    });
    ctx.billing = { check } as unknown as ShopContext["billing"];
    subscriptionFindUnique.mockResolvedValue({
      plan: "none",
      status: "cancelled",
      trialEndsAt: null,
      updatedAt: new Date(),
    });
    subscriptionUpsert.mockResolvedValue({
      plan: "growth",
      status: "active",
      trialEndsAt: null,
    });

    await expect(resolvePlan(ctx)).resolves.toMatchObject({
      planId: "growth",
      status: "active",
    });
    expect(check).toHaveBeenCalledWith({ isTest: true });
  });

  it("redirects a selective child request before paid data can load", async () => {
    subscriptionFindUnique.mockResolvedValue(null);
    const ctx = context(
      { domain: "merchant.myshopify.com", partnerDevelopment: false },
      null,
    );
    ctx.billing = null;
    const request = new Request(
      "https://meridian.example/app.data?_routes=routes/app.overview&shop=merchant.myshopify.com",
    );

    let thrown: unknown;
    try {
      await requireActivePlan(ctx, request);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe(
      "/app/plan?shop=merchant.myshopify.com",
    );
  });
});
