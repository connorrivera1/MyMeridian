import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShopContext } from "~/lib/auth.server";

const requireShopContext = vi.fn();
const resolveBillingChargeMode = vi.fn();
const resolvePlan = vi.fn();
const firstDeniedRequestLimit = vi.fn();
const recordSensitiveAction = vi.fn();

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
  resolvePlan: (...args: unknown[]) => resolvePlan(...args),
}));
vi.mock("~/lib/rate-limit.server", () => ({
  firstDeniedRequestLimit: (...args: unknown[]) =>
    firstDeniedRequestLimit(...args),
  RATE_LIMIT_MESSAGE: "Too many requests. Wait a little while and try again.",
  rateLimitHeaders: () => ({ "retry-after": "60" }),
}));
vi.mock("~/lib/security-audit.server", () => ({
  recordSensitiveAction: (...args: unknown[]) => recordSensitiveAction(...args),
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
  resolvePlan.mockReset();
  resolvePlan.mockResolvedValue({ planId: null, isDemo: false });
  firstDeniedRequestLimit.mockResolvedValue(null);
  recordSensitiveAction.mockResolvedValue(undefined);
  vi.stubEnv("APP_URL", "");
  vi.stubEnv("SHOPIFY_APP_URL", "");
});

describe("plan charge action", () => {
  it("uses the freshly resolved store type for the charge", async () => {
    const { ctx, billingRequest } = context();
    requireShopContext.mockResolvedValue(ctx);
  resolveBillingChargeMode.mockResolvedValue(false);
  resolvePlan.mockResolvedValue({ planId: null, isDemo: false });
    billingRequest.mockResolvedValue(new Response(null, { status: 302 }));

    await action({ request: request("growth") } as never);

    expect(resolveBillingChargeMode).toHaveBeenCalledWith(ctx);
    expect(billingRequest).toHaveBeenCalledWith({
      plan: "growth",
      isTest: false,
      returnUrl: "https://meridian.example/app/plan?shop=store.myshopify.com",
    });
    expect(firstDeniedRequestLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "billing_plan_change",
        subject: "shop-1",
        subjectLimit: 5,
      }),
    );
    expect(recordSensitiveAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BILLING_PLAN_CHANGE_REQUESTED",
        resource: "plan:growth",
      }),
    );
  });

  it("accepts a downgrade that Shopify applies on the next billing cycle", async () => {
    const { ctx, billingRequest } = context();
    requireShopContext.mockResolvedValue(ctx);
    resolvePlan.mockResolvedValue({ planId: "scale", isDemo: false });
    resolveBillingChargeMode.mockResolvedValue(false);
    billingRequest.mockResolvedValue(new Response(null, { status: 302 }));

    await action({ request: request("starter-next-cycle") } as never);

    expect(billingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: "starter-next-cycle",
        isTest: false,
      }),
    );
    expect(recordSensitiveAction).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "plan:starter-next-cycle",
      }),
    );
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

  it("refuses a limited billing request without creating a charge or audit event", async () => {
    const { ctx, billingRequest } = context();
    requireShopContext.mockResolvedValue(ctx);
    firstDeniedRequestLimit.mockResolvedValue({ retryAfterSeconds: 60 });

    const result = await action({ request: request("growth") } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(429);
    expect(resolveBillingChargeMode).not.toHaveBeenCalled();
    expect(recordSensitiveAction).not.toHaveBeenCalled();
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

  it("rejects malformed deferred billing keys", async () => {
    const { ctx, billingRequest } = context();
    requireShopContext.mockResolvedValue(ctx);

    await expect(
      action({ request: request("growth-next-cycle-annual") } as never),
    ).resolves.toEqual({ error: "That plan does not exist." });
    expect(resolveBillingChargeMode).not.toHaveBeenCalled();
    expect(billingRequest).not.toHaveBeenCalled();
  });
});
