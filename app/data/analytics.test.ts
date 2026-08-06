import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineOrder } from "~/engine/types";

/**
 * Cover for the comparison-window load.
 *
 * Every headline carries a change against the preceding window of the same
 * length, and `loadDashboard` used to build a second complete `ShopAnalytics`
 * to get it — a second 365-day cohort scan, a second capacity query, a second
 * product-meta query and four engine passes, on every page load, for eight
 * scalars. The lean path must produce the *same* scalars: a comparison computed
 * a second way would be a second definition of profit, which is worse than the
 * cost it saves.
 */

const loadEngineOrders = vi.fn();
const loadAdSpend = vi.fn();
const loadCostRules = vi.fn();
const loadProductMeta = vi.fn();
const loadCapacityDays = vi.fn();
const loadCohortRows = vi.fn();

vi.mock("./queries.server", () => ({
  loadEngineOrders: (...args: unknown[]) => loadEngineOrders(...args),
  loadAdSpend: (...args: unknown[]) => loadAdSpend(...args),
  loadCostRules: (...args: unknown[]) => loadCostRules(...args),
  loadProductMeta: (...args: unknown[]) => loadProductMeta(...args),
  loadCapacityDays: (...args: unknown[]) => loadCapacityDays(...args),
  loadCohortRows: (...args: unknown[]) => loadCohortRows(...args),
}));

vi.mock("~/db.server", () => ({ default: {} }));

const { invalidateAnalyticsCache, loadPeriodProfit, loadShopAnalytics } =
  await import("./analytics.server");

const RANGE = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-31T00:00:00.000Z"),
};

const SHOP = {
  id: "shop_1",
  timezone: "UTC",
  fulfillmentSlaDays: 2,
  lastComputedAt: new Date("2026-07-31T01:00:00.000Z"),
} as unknown as Shop;

function engineOrder(id: string, day: number, subtotalCents: number): EngineOrder {
  return {
    id,
    orderNumber: 1000 + day,
    processedAt: new Date(Date.UTC(2026, 6, day, 9, 0, 0)),
    customerId: `cust_${id}`,
    channel: "GOOGLE",
    campaignId: "camp_1",
    isFirstOrder: true,
    subtotalCents,
    discountTotalCents: 0,
    shippingChargedCents: 500,
    taxTotalCents: 0,
    totalCents: subtotalCents + 500,
    refundedTotalCents: 0,
    actualShippingCostCents: null,
    actualPickPackCostCents: null,
    lineItems: [
      {
        id: `${id}_li`,
        productId: "prod_1",
        variantId: "var_1",
        title: "Alpine Shell Jacket",
        quantity: 2,
        refundedQty: 0,
        unitPriceCents: Math.round(subtotalCents / 2),
        discountCents: 0,
        unitCostMicros: 4_500_000,
      },
    ],
  };
}

const ORDERS = [
  engineOrder("order_1", 3, 28_900),
  engineOrder("order_2", 11, 16_500),
  engineOrder("order_3", 24, 8_400),
];

const SPEND = [
  {
    date: new Date(Date.UTC(2026, 6, 3)),
    channel: "GOOGLE" as const,
    campaignId: "camp_1",
    campaignName: "Search — brand",
    spendCents: 4_200,
    impressions: 10_000,
    clicks: 300,
    platformConversions: 4,
    platformRevenueCents: 60_000,
  },
  {
    // Deliberately on a day with no orders, so the roll-up has to carry
    // unattributed spend through as well.
    date: new Date(Date.UTC(2026, 6, 18)),
    channel: "GOOGLE" as const,
    campaignId: "camp_1",
    campaignName: "Search — brand",
    spendCents: 1_100,
    impressions: 2_000,
    clicks: 40,
    platformConversions: 0,
    platformRevenueCents: 0,
  },
];

const RULES = {
  paymentPercentRate: 0.029,
  paymentFixedPerOrderCents: 30,
  shippingDefaultPerOrderCents: 850,
  pickPackPerOrderCents: 175,
  pickPackPerItemCents: 35,
  monthlyOverheadCents: 300_000,
};

beforeEach(() => {
  invalidateAnalyticsCache();
  for (const fn of [
    loadEngineOrders,
    loadAdSpend,
    loadCostRules,
    loadProductMeta,
    loadCapacityDays,
    loadCohortRows,
  ]) {
    fn.mockReset();
  }

  loadEngineOrders.mockResolvedValue(ORDERS);
  loadAdSpend.mockResolvedValue(SPEND);
  loadCostRules.mockResolvedValue(RULES);
  loadProductMeta.mockResolvedValue(new Map());
  loadCapacityDays.mockResolvedValue([]);
  loadCohortRows.mockResolvedValue([]);
});

describe("loadPeriodProfit", () => {
  it("produces exactly the roll-up the full build produces", async () => {
    const full = await loadShopAnalytics(SHOP, RANGE);
    invalidateAnalyticsCache();
    const lean = await loadPeriodProfit(SHOP, RANGE);

    // Deep equality, not a spot check on net profit: overhead proration and ad
    // attribution both depend on the reporting window being passed through, and
    // a lean path that dropped `range` would still agree on revenue.
    expect(lean).toEqual(full.period);
  });

  it("carries unattributed ad spend, which needs the window", async () => {
    const lean = await loadPeriodProfit(SHOP, RANGE);

    expect(lean.unattributedAdCostCents).toBe(1_100);
    expect(lean.totalAdCostCents).toBe(5_300);
    // The window covers all 31 days of July, so the whole month's overhead is
    // charged. See the straddling case below for the half that matters.
    expect(lean.overheadCents).toBe(300_000);
  });

  it("prorates overhead across a straddling window, so `range` is threaded through", async () => {
    // 20 of July's 31 days. A lean path that forgot to pass the reporting
    // window would bill the full month's rent against three orders and put the
    // error straight onto the headline the comparison is drawn against —
    // silently, because revenue and COGS would still agree.
    const straddling = {
      from: new Date("2026-06-20T00:00:00.000Z"),
      to: new Date("2026-07-20T00:00:00.000Z"),
    };

    const lean = await loadPeriodProfit(SHOP, straddling);

    expect(lean.overheadCents).toBe(Math.round((300_000 * 20) / 31));
    expect(lean.overheadCents).toBe(193_548);
  });

  it("skips the cohort, capacity and product-meta queries entirely", async () => {
    await loadPeriodProfit(SHOP, RANGE);

    expect(loadEngineOrders).toHaveBeenCalledTimes(1);
    expect(loadAdSpend).toHaveBeenCalledTimes(1);
    expect(loadCostRules).toHaveBeenCalledTimes(1);

    // These three are the reason the second build was expensive. The 365-day
    // cohort scan in particular is unbounded by the reporting window.
    expect(loadCohortRows).not.toHaveBeenCalled();
    expect(loadCapacityDays).not.toHaveBeenCalled();
    expect(loadProductMeta).not.toHaveBeenCalled();
  });

  it("reuses a warm full build of the same window rather than re-querying", async () => {
    await loadShopAnalytics(SHOP, RANGE);
    const callsAfterFull = loadEngineOrders.mock.calls.length;

    const lean = await loadPeriodProfit(SHOP, RANGE);

    expect(loadEngineOrders.mock.calls.length).toBe(callsAfterFull);
    expect(lean.netProfitCents).toBeDefined();
  });

  it("caches its own result", async () => {
    await loadPeriodProfit(SHOP, RANGE);
    await loadPeriodProfit(SHOP, RANGE);

    expect(loadEngineOrders).toHaveBeenCalledTimes(1);
  });

  it("is invalidated with the rest of the analytics cache", async () => {
    await loadPeriodProfit(SHOP, RANGE);
    invalidateAnalyticsCache();
    await loadPeriodProfit(SHOP, RANGE);

    // A recompute changes every figure here; a comparison window that survived
    // it would show a delta against numbers that no longer exist.
    expect(loadEngineOrders).toHaveBeenCalledTimes(2);
  });

  it("keys the cache on the window, not just the shop", async () => {
    const earlier = {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-30T00:00:00.000Z"),
    };

    await loadPeriodProfit(SHOP, RANGE);
    await loadPeriodProfit(SHOP, earlier);

    expect(loadEngineOrders).toHaveBeenCalledTimes(2);
    expect(loadEngineOrders).toHaveBeenLastCalledWith(SHOP.id, earlier);
  });
});
