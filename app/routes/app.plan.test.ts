import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShopContext } from "~/lib/auth.server";

const requireShopContext = vi.fn();
const resolveBillingChargeMode = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  requireShopContext: (...args: unknown[]) => requireShopContext(...args),
  withShopContext: async (
    request: Request,
    work: (context: unknown) => unknown,
  ) => work(await requireShopContext(request)),
}));

vi.mock("~/lib/plan.server", () => ({
  billingIsTestForShop: vi.fn(() => false),
  resolveBillingChargeMode: (...args: unknown[]) =>
    resolveBillingChargeMode(...args),
  resolvePlan: vi.fn(),
}));

const { action } = await import("./app.plan");

function request(plan = "growth") {
  return new Request(
    "https://meridian.example/app/plan?shop=store.myshopify.com",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ plan }),
    },
  );
}

function context() {
  const billingRequest = vi.fn();
  const ctx = {
    shop: { id: "shop-1", domain: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
    billing: { request: billingRequest },
    session: { id: "session-1", shop: "store.myshopify.com" },
    isDemo: false,
  } as unknown as ShopContext;
  return { ctx, billingRequest };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_URL", "");
  vi.stubEnv("SHOPIFY_APP_URL", "");
});

describe("plan charge action", () => {
  it("uses the freshly resolved store type for the charge", async () => {
    const { ctx, billingRequest } = context();
    requireShopContext.mockResolvedValue(ctx);
    resolveBillingChargeMode.mockResolvedValue(false);
    billingRequest.mockResolvedValue(new Response(null, { status: 302 }));

    await action({ request: request("growth") } as never);

    expect(resolveBillingChargeMode).toHaveBeenCalledWith(ctx);
    expect(billingRequest).toHaveBeenCalledWith({
      plan: "growth",
      isTest: false,
      returnUrl: "https://meridian.example/app/plan?shop=store.myshopify.com",
    });
  });

  it("creates no charge when Shopify store-type verification fails", async () => {
    const { ctx, billingRequest } = context();
    requireShopContext.mockResolvedValue(ctx);
    resolveBillingChargeMode.mockRejectedValue(
      new Error("Shopify unavailable"),
    );

    const result = await action({ request: request("starter") } as never);

    expect(result).toEqual({
      error:
        "Could not verify whether this store can accept a real charge. " +
        "No charge was created; retry in a moment.",
    });
    expect(billingRequest).not.toHaveBeenCalled();
  });

  it("rejects an invalid plan before querying store type", async () => {
    const { ctx, billingRequest } = context();
    requireShopContext.mockResolvedValue(ctx);

    await expect(
      action({ request: request("growth-weekly") } as never),
    ).resolves.toEqual({ error: "That plan does not exist." });
    expect(resolveBillingChargeMode).not.toHaveBeenCalled();
    expect(billingRequest).not.toHaveBeenCalled();
  });
});
