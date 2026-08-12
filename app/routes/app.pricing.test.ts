import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `app.pricing.tsx`'s loader and action had no test of their own — one of the
 * "route loaders are still mostly untested" gaps `[[meridian]]`'s worklist
 * named. Two things here are worth a merchant's trust and neither was
 * previously exercised outside manual clicking:
 *
 * - the loader's `upsideCents`/`actionableCount`/`testableCount` split, which
 *   is the headline money figure and the count backing "Ready to act on";
 * - the action's per-shop scoping on `id` (`where: { id, shopId }`), which is
 *   what stops a crafted recommendation id from touching another merchant's
 *   row, and its defense-in-depth plan gate (the loader hides the screen, but
 *   a form POST does not go through the loader).
 */

// Deliberately NOT setting SHOPIFY_API_KEY/SECRET: `plan.server` real code is
// wanted below (so `planAllows`'s 402 gate is genuine, not reimplemented in
// this file), but it drags in `shopify.server`, whose eager `buildShopify()`
// would construct a `PrismaSessionStorage` against the mocked, session-less
// `db.server` below and crash at import time. Leaving the app uncredentialled
// takes the `hasShopifyCredentials` branch that skips that construction
// entirely — the same branch a fresh clone with no `.env` runs in.

const loadDashboard = vi.fn();
vi.mock("~/lib/route-data.server", () => ({
  loadDashboardForContext: (...args: unknown[]) => loadDashboard(...args),
}));

const requireShopContext = vi.fn();
vi.mock("~/lib/auth.server", () => ({
  requireShopContext: (...args: unknown[]) => requireShopContext(...args),
  withShopContext: async (
    request: Request,
    work: (context: unknown) => unknown,
  ) => work(await requireShopContext(request)),
}));

const resolvePlan = vi.fn();
vi.mock("~/lib/plan.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/plan.server")>()),
  resolvePlan: (...args: unknown[]) => resolvePlan(...args),
}));

const generatePricingRecommendations = vi.fn();
vi.mock("~/lib/pricing.server", () => ({
  generatePricingRecommendations: (...args: unknown[]) =>
    generatePricingRecommendations(...args),
}));

const findMany = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();
vi.mock("~/db.server", () => ({
  default: { pricingRecommendation: { findMany, findFirst, update } },
}));

const { loader, action } = await import("./app.pricing");

const SHOP = { id: "shop_1", currency: "USD" };
const GROWTH_PLAN = {
  planId: "growth",
  status: "active",
  trialEndsAt: null,
  isDemo: false,
};
const STARTER_PLAN = {
  planId: "starter",
  status: "active",
  trialEndsAt: null,
  isDemo: false,
};

function rec(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec_1",
    method: "ELASTICITY_REGRESSION",
    status: "PENDING",
    currentPrice: "20.00",
    suggestedPrice: "24.00",
    expectedProfitDelta: "150.00",
    expectedUnitsDeltaPct: "-3.5",
    elasticity: "-1.2",
    confidence: "HIGH",
    rationale: "demand is inelastic here",
    actionedAt: null,
    variant: { title: "Medium", sku: "SKU-1", product: { title: "Widget" } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadDashboard.mockResolvedValue({
    shop: SHOP,
    rangeLabel: "30 days",
    plan: GROWTH_PLAN,
  });
  requireShopContext.mockResolvedValue({ shop: SHOP });
  resolvePlan.mockResolvedValue(GROWTH_PLAN);
  findMany.mockResolvedValue([]);
});

describe("loader", () => {
  it("locks the screen below Growth instead of querying recommendations", async () => {
    loadDashboard.mockResolvedValue({
      shop: SHOP,
      rangeLabel: "30 days",
      plan: STARTER_PLAN,
    });

    const result = await loader({
      request: new Request("https://example.com/app/pricing"),
    } as never);

    expect(result).toEqual({
      locked: { name: expect.any(String), price: expect.any(Number) },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("sums upsideCents only across ELASTICITY_REGRESSION and MARGIN_TARGET, excluding hold/below-cost/insufficient-data", async () => {
    findMany.mockImplementation((args) => {
      if (args.where.status === "PENDING") {
        return Promise.resolve([
          rec({
            id: "a",
            method: "ELASTICITY_REGRESSION",
            expectedProfitDelta: "100.00",
          }),
          rec({
            id: "b",
            method: "MARGIN_TARGET",
            expectedProfitDelta: "50.00",
          }),
          rec({
            id: "c",
            method: "STRATEGIC_HOLD",
            expectedProfitDelta: "9999.00",
          }),
          rec({
            id: "d",
            method: "BELOW_COST",
            expectedProfitDelta: "9999.00",
          }),
          rec({
            id: "e",
            method: "INSUFFICIENT_DATA",
            expectedProfitDelta: "0.00",
          }),
        ]);
      }
      return Promise.resolve([]);
    });

    const result = (await loader({
      request: new Request("https://example.com/app/pricing"),
    } as never)) as {
      locked: null;
      upsideCents: number;
      actionableCount: number;
      testableCount: number;
    };

    // Only "a" ($100) and "b" ($50) are actionable; the hold and below-cost
    // rows must not leak into the merchant-facing upside figure even though
    // their stubbed deltas are far larger.
    expect(result.upsideCents).toBe(15_000);
    expect(result.actionableCount).toBe(2);
    expect(result.testableCount).toBe(1);
  });

  it("queries actioned recommendations separately, capped at 20 and newest-first", async () => {
    await loader({
      request: new Request("https://example.com/app/pricing"),
    } as never);

    const actionedCall = findMany.mock.calls.find(
      (call) => call[0].where.status?.in !== undefined,
    );
    expect(actionedCall).toBeDefined();
    expect(actionedCall![0]).toMatchObject({
      where: { shopId: SHOP.id, status: { in: ["APPLIED", "DISMISSED"] } },
      orderBy: { actionedAt: "desc" },
      take: 20,
    });
  });

  it("converts Decimal fields to cents/numbers rather than passing Prisma Decimals to the client", async () => {
    findMany.mockImplementation((args) => {
      if (args.where.status === "PENDING") {
        return Promise.resolve([
          rec({ currentPrice: "20.00", suggestedPrice: "24.50" }),
        ]);
      }
      return Promise.resolve([]);
    });

    const result = (await loader({
      request: new Request("https://example.com/app/pricing"),
    } as never)) as {
      recommendations: {
        currentPriceCents: number;
        suggestedPriceCents: number;
      }[];
    };

    expect(result.recommendations[0]!.currentPriceCents).toBe(2000);
    expect(result.recommendations[0]!.suggestedPriceCents).toBe(2450);
  });
});

describe("action", () => {
  function post(fields: Record<string, string>) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return { request: { formData: () => Promise.resolve(form) } } as never;
  }

  it("rejects a form post below Growth even though the loader already hides the screen", async () => {
    resolvePlan.mockResolvedValue(STARTER_PLAN);

    await expect(action(post({ intent: "regenerate" }))).rejects.toMatchObject({
      status: 402,
    });
    expect(generatePricingRecommendations).not.toHaveBeenCalled();
  });

  it("regenerates and pluralises the count correctly", async () => {
    generatePricingRecommendations.mockResolvedValue(1);
    const result = await action(post({ intent: "regenerate" }));
    expect(result).toMatchObject({ ok: true });
    expect((result as { message: string }).message).toContain("1 suggestion ");
    expect((result as { message: string }).message).not.toContain(
      "suggestions",
    );

    generatePricingRecommendations.mockResolvedValue(3);
    const plural = await action(post({ intent: "regenerate" }));
    expect((plural as { message: string }).message).toContain("3 suggestions");
  });

  it("refuses an action with no id rather than throwing", async () => {
    const result = await action(post({ intent: "dismiss" }));
    expect(result).toEqual({
      ok: false,
      message: "No recommendation was selected.",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("scopes the lookup to this shop so a crafted id from another merchant cannot be actioned", async () => {
    findFirst.mockResolvedValue(null);
    await action(post({ intent: "dismiss", id: "someone_elses_rec" }));

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "someone_elses_rec", shopId: SHOP.id },
      }),
    );
  });

  it("reports a missing recommendation rather than silently doing nothing", async () => {
    findFirst.mockResolvedValue(null);
    const result = await action(post({ intent: "dismiss", id: "gone" }));

    expect(result).toEqual({
      ok: false,
      message: "That recommendation no longer exists. Recalculate to refresh.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("dismisses a recommendation, stamping actionedAt and the DISMISSED status", async () => {
    findFirst.mockResolvedValue(rec());
    const result = await action(post({ intent: "dismiss", id: "rec_1" }));

    expect(update).toHaveBeenCalledWith({
      where: { id: "rec_1" },
      data: { status: "DISMISSED", actionedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({
      ok: true,
      message: "Dismissed the suggestion for Widget.",
    });
  });

  it("restores a dismissed recommendation back to PENDING with actionedAt cleared", async () => {
    findFirst.mockResolvedValue(
      rec({ status: "DISMISSED", actionedAt: new Date() }),
    );
    const result = await action(post({ intent: "restore", id: "rec_1" }));

    expect(update).toHaveBeenCalledWith({
      where: { id: "rec_1" },
      data: { status: "PENDING", actionedAt: null },
    });
    expect(result).toMatchObject({
      ok: true,
      message: "Restored the suggestion for Widget.",
    });
  });

  it("applies a recommendation and says Meridian cannot write the price itself", async () => {
    findFirst.mockResolvedValue(rec());
    const result = await action(post({ intent: "apply", id: "rec_1" }));

    expect(update).toHaveBeenCalledWith({
      where: { id: "rec_1" },
      data: { status: "APPLIED", actionedAt: expect.any(Date) },
    });
    expect((result as { message: string }).message).toContain(
      "Accepted for Widget",
    );
    expect((result as { message: string }).message).toContain(
      "It has no permission to change prices",
    );
  });

  it("rejects an unrecognised intent without touching the database", async () => {
    findFirst.mockResolvedValue(rec());
    const result = await action(
      post({ intent: "delete-everything", id: "rec_1" }),
    );

    expect(result).toEqual({ ok: false, message: "Unrecognised action." });
    expect(update).not.toHaveBeenCalled();
  });
});
