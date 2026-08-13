import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `loadDashboard` is the loader every dashboard screen goes through
 * (`app.overview.tsx`, `app.orders.tsx`, `app.products.tsx`, `app.fulfilment.tsx`,
 * `app.acquisition.tsx`, `app.pricing.tsx`) and had no test of its own —
 * SUBMISSION.md's "known gaps" list called this out by name. Its pieces are
 * each tested elsewhere (`resolveRange`/`RANGE_PRESETS` in
 * `app/data/ranges.test.ts`, `capabilitiesForShop` in `app/lib/scopes.test.ts`,
 * `loadShopAnalytics`/`loadPeriodProfit` in `app/data/analytics.test.ts`), so
 * this test is only about the wiring: does `loadDashboard` build the right
 * previous-period window, pass the right range to each loader, and assemble
 * the result correctly. It does not re-verify any of those pieces' internals.
 */

const requireShopContext = vi.fn();
vi.mock("~/lib/auth.server", () => ({
  requireShopContext: (...args: unknown[]) => requireShopContext(...args),
  withShopContext: async (
    request: Request,
    work: (context: unknown) => unknown,
  ) => work(await requireShopContext(request)),
}));

const requireActivePlan = vi.fn();
vi.mock("~/lib/plan.server", () => ({
  requireActivePlan: (...args: unknown[]) => requireActivePlan(...args),
}));

const loadAdSpendCoverage = vi.fn();
vi.mock("~/lib/ad-spend-coverage.server", () => ({
  loadAdSpendCoverage: (...args: unknown[]) => loadAdSpendCoverage(...args),
}));

const loadShopAnalytics = vi.fn();
const loadPeriodProfit = vi.fn();
vi.mock("~/data/analytics.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/data/analytics.server")>()),
  loadShopAnalytics: (...args: unknown[]) => loadShopAnalytics(...args),
  loadPeriodProfit: (...args: unknown[]) => loadPeriodProfit(...args),
}));

const findDismissals = vi.fn();
vi.mock("~/db.server", () => ({
  default: { actionDismissal: { findMany: (...args: unknown[]) => findDismissals(...args) } },
}));

const { loadDashboard, change } = await import("./route-data.server");

const SHOP = { id: "shop_1", domain: "meridian-test.myshopify.com" } as Shop;

function shopContext(overrides: Partial<{ shop: Shop; isDemo: boolean }> = {}) {
  return {
    shop: SHOP,
    admin: null,
    billing: null,
    session: null,
    isDemo: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireShopContext.mockResolvedValue(shopContext());
  requireActivePlan.mockResolvedValue({
    planId: "growth",
    status: "active",
    trialEndsAt: null,
    isDemo: false,
  });
  loadShopAnalytics.mockResolvedValue({
    analytics: "stub",
    period: { orders: [] },
    rules: {
      paymentPercentRate: 0,
      paymentFixedPerOrderCents: 0,
      shippingDefaultPerOrderCents: 0,
      pickPackPerOrderCents: 0,
      pickPackPerItemCents: 0,
      monthlyOverheadCents: 0,
      provenance: { paymentFee: null, shippingDefault: null, pickPack: null, monthlyOverhead: null },
    },
  });
  loadPeriodProfit.mockResolvedValue({ profit: "stub" });
  loadAdSpendCoverage.mockResolvedValue({
    mode: "unavailable",
    syncedSourceCount: 0,
  });
  findDismissals.mockResolvedValue([]);
});

describe("loadDashboard", () => {
  it("builds a previous period immediately preceding the reporting range, of the same length", async () => {
    const request = new Request("https://example.com/app/overview?range=30d");
    const result = await loadDashboard(request);

    const [, rangeArg] = loadShopAnalytics.mock.calls[0]!;
    const [, previousRangeArg] = loadPeriodProfit.mock.calls[0]!;

    const spanMs = rangeArg.to.getTime() - rangeArg.from.getTime();

    // Immediately before: the previous window ends 1ms before the current one
    // starts, so the two windows tile the timeline with no gap and no overlap.
    expect(previousRangeArg.to.getTime()).toBe(rangeArg.from.getTime() - 1);
    // Same length: `previousRange.from` sits exactly one current-window span
    // before `range.from`, so a comparison isn't against a differently-sized
    // window (which would be noise, not a comparison).
    expect(previousRangeArg.from.getTime()).toBe(
      rangeArg.from.getTime() - spanMs,
    );
    expect(result.range).toBe(rangeArg);
  });

  it("defaults to the 30-day preset when ?range= is absent", async () => {
    const request = new Request("https://example.com/app/overview");
    const result = await loadDashboard(request);

    expect(result.preset).toBe("30d");
    expect(result.rangeLabel).toBe("30 days");
  });

  it("defaults to the 30-day preset when ?range= is not a known preset", async () => {
    const request = new Request("https://example.com/app/overview?range=bogus");
    const result = await loadDashboard(request);

    expect(result.preset).toBe("30d");
  });

  it("honours a valid, non-default preset", async () => {
    const request = new Request("https://example.com/app/overview?range=180d");
    const result = await loadDashboard(request);

    expect(result.preset).toBe("180d");
    expect(result.rangeLabel).toBe("6 months");
  });

  it("passes each loader the range it owns: current to loadShopAnalytics, previous to loadPeriodProfit", async () => {
    const request = new Request("https://example.com/app/overview?range=30d");
    await loadDashboard(request);

    expect(loadShopAnalytics).toHaveBeenCalledTimes(1);
    expect(loadShopAnalytics).toHaveBeenCalledWith(SHOP, expect.any(Object));
    expect(loadPeriodProfit).toHaveBeenCalledTimes(1);
    expect(loadPeriodProfit).toHaveBeenCalledWith(SHOP, expect.any(Object));

    const [, currentRange] = loadShopAnalytics.mock.calls[0]!;
    const [, previousRange] = loadPeriodProfit.mock.calls[0]!;
    // The two loaders must not be handed the same window — that would compare
    // the period against itself and silently report zero change forever.
    expect(previousRange.to.getTime()).not.toBe(currentRange.to.getTime());
  });

  it("finishes the current analytics build before starting the previous window", async () => {
    let releaseCurrent!: (value: {
      analytics: string;
      period: { orders: never[] };
      rules: {
        paymentPercentRate: number;
        paymentFixedPerOrderCents: number;
        shippingDefaultPerOrderCents: number;
        pickPackPerOrderCents: number;
        pickPackPerItemCents: number;
        monthlyOverheadCents: number;
        provenance: { paymentFee: null; shippingDefault: null; pickPack: null; monthlyOverhead: null };
      };
    }) => void;
    loadShopAnalytics.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCurrent = resolve;
        }),
    );

    const pending = loadDashboard(
      new Request("https://example.com/app/overview?range=30d"),
    );

    await vi.waitFor(() => expect(loadShopAnalytics).toHaveBeenCalledTimes(1));
    expect(loadPeriodProfit).not.toHaveBeenCalled();
    // The lightweight coverage aggregate is still allowed to overlap.
    expect(loadAdSpendCoverage).toHaveBeenCalledTimes(1);

    releaseCurrent({
      analytics: "current",
      period: { orders: [] },
      rules: {
        paymentPercentRate: 0,
        paymentFixedPerOrderCents: 0,
        shippingDefaultPerOrderCents: 0,
        pickPackPerOrderCents: 0,
        pickPackPerItemCents: 0,
        monthlyOverheadCents: 0,
        provenance: { paymentFee: null, shippingDefault: null, pickPack: null, monthlyOverhead: null },
      },
    });
    await pending;

    expect(loadPeriodProfit).toHaveBeenCalledTimes(1);
  });

  it("does not anchor to stored data for a real (non-demo) shop", async () => {
    // `resolveRange`'s own anchoring behaviour is covered in
    // app/data/ranges.test.ts; what belongs to loadDashboard is only that it
    // passes `isDemo` through as `anchorToData` rather than a fixed value —
    // anchoring a live store's dashboard to the last sync freezes it in place
    // for every order that lands afterwards.
    requireShopContext.mockResolvedValue(shopContext({ isDemo: false }));
    const request = new Request("https://example.com/app/overview?range=30d");
    const result = await loadDashboard(request);

    // A live shop's range should track "now", not any fixed point in the
    // seeded past — the seeded demo's data is what anchoring exists for.
    expect(result.range.to.getTime()).toBeGreaterThan(
      Date.now() - 24 * 60 * 60 * 1000,
    );
  });

  it("enforces the active plan through the shared child-loader guard", async () => {
    const request = new Request("https://example.com/app/overview?range=30d");
    const result = await loadDashboard(request);

    expect(requireActivePlan).toHaveBeenCalledTimes(1);
    expect(requireActivePlan).toHaveBeenCalledWith(
      expect.objectContaining({ shop: SHOP, isDemo: false }),
      request,
    );
    expect(result.plan).toEqual({
      planId: "growth",
      status: "active",
      trialEndsAt: null,
      isDemo: false,
    });
  });

  it("loads no analytics when a selective child request has no active plan", async () => {
    requireActivePlan.mockRejectedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "/app/plan?shop=meridian-test.myshopify.com" },
      }),
    );
    const request = new Request(
      "https://example.com/app.data?_routes=routes/app.overview&shop=meridian-test.myshopify.com",
    );

    await expect(loadDashboard(request)).rejects.toMatchObject({ status: 302 });
    expect(loadShopAnalytics).not.toHaveBeenCalled();
    expect(loadPeriodProfit).not.toHaveBeenCalled();
    expect(loadAdSpendCoverage).not.toHaveBeenCalled();
  });

  it("assembles shop, isDemo, capabilities, spend coverage and both analytics results onto the returned object", async () => {
    requireShopContext.mockResolvedValue(
      shopContext({
        shop: { ...SHOP, grantedScopes: "read_orders,read_products" } as Shop,
        isDemo: false,
      }),
    );
    const request = new Request("https://example.com/app/overview?range=30d");
    const result = await loadDashboard(request);

    expect(result.shop.id).toBe("shop_1");
    expect(result.isDemo).toBe(false);
    expect(result.analytics).toMatchObject({ analytics: "stub" });
    expect(result.previous.period).toEqual({ profit: "stub" });
    expect(result.adSpendCoverage).toEqual({
      mode: "unavailable",
      syncedSourceCount: 0,
    });
    expect(loadAdSpendCoverage).toHaveBeenCalledWith("shop_1", false);
    expect(result.capabilities).toBeDefined();
  });

  it("grants every capability for the demo shop regardless of granted scopes", async () => {
    requireShopContext.mockResolvedValue(
      shopContext({
        shop: { ...SHOP, grantedScopes: null, isDemo: true } as Shop,
        isDemo: true,
      }),
    );
    const request = new Request("https://example.com/app/overview?range=30d");
    const result = await loadDashboard(request);

    // capabilitiesForShop short-circuits to ALL_CAPABILITIES for a demo shop —
    // this is the one branch loadDashboard's own wiring could get backwards
    // (e.g. by forgetting to pass isDemo through on the shop object).
    expect(Object.values(result.capabilities).every(Boolean)).toBe(true);
    expect(loadAdSpendCoverage).toHaveBeenCalledWith("shop_1", true);
  });
});

describe("change", () => {
  it("returns null rather than dividing by zero when the prior value was zero", () => {
    expect(change(100, 0)).toBeNull();
  });

  it("computes a positive fractional change", () => {
    expect(change(150, 100)).toBeCloseTo(0.5);
  });

  it("computes a negative fractional change", () => {
    expect(change(50, 100)).toBeCloseTo(-0.5);
  });
});
