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

function engineOrder(
  id: string,
  day: number,
  subtotalCents: number,
): EngineOrder {
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
  provenance: {
    paymentFee: { origin: "DEMO_SEED" as const, confirmed: true },
    shippingDefault: { origin: "DEMO_SEED" as const, confirmed: true },
    pickPack: { origin: "DEMO_SEED" as const, confirmed: true },
    monthlyOverhead: { origin: "DEMO_SEED" as const, confirmed: true },
  },
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
    const { orders: _discardedOrders, ...fullSummary } = full.period;

    // Deep equality, not a spot check on net profit: overhead proration and ad
    // attribution both depend on the reporting window being passed through, and
    // a lean path that dropped `range` would still agree on revenue.
    expect(lean).toEqual(fullSummary);
    expect(lean).not.toHaveProperty("orders");
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
    expect(lean).not.toHaveProperty("orders");
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

describe("analytics build admission", () => {
  it("deduplicates simultaneous misses for the same shop and window", async () => {
    let releaseOrders!: (orders: typeof ORDERS) => void;
    loadEngineOrders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOrders = resolve;
        }),
    );

    const first = loadShopAnalytics(SHOP, RANGE);
    const second = loadShopAnalytics(SHOP, RANGE);

    await vi.waitFor(() => expect(loadEngineOrders).toHaveBeenCalledTimes(1));
    releaseOrders(ORDERS);

    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(loadEngineOrders).toHaveBeenCalledTimes(1);
  });

  it("serializes misses for different shops", async () => {
    const releases: Array<(orders: typeof ORDERS) => void> = [];
    loadEngineOrders.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );

    const first = loadShopAnalytics(SHOP, RANGE);
    const second = loadShopAnalytics({ ...SHOP, id: "shop_2" } as Shop, RANGE);

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(loadEngineOrders).toHaveBeenCalledTimes(1);

    releases[0]!(ORDERS);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(loadEngineOrders).toHaveBeenCalledTimes(2);

    releases[1]!(ORDERS);
    await Promise.all([first, second]);
  });

  it("evicts a retained full window before a different admitted miss starts hydrating", async () => {
    const earlier = {
      from: new Date("2026-06-01T00:00:00.000Z"),
      to: new Date("2026-06-30T00:00:00.000Z"),
    };
    await loadShopAnalytics(SHOP, RANGE);

    let releaseEarlier!: (orders: typeof ORDERS) => void;
    loadEngineOrders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseEarlier = resolve;
        }),
    );

    const earlierBuild = loadShopAnalytics(SHOP, earlier);
    await vi.waitFor(() => expect(loadEngineOrders).toHaveBeenCalledTimes(2));

    let oldWindowResolved = false;
    const oldWindow = loadShopAnalytics(SHOP, RANGE).then((value) => {
      oldWindowResolved = true;
      return value;
    });
    await Promise.resolve();
    expect(oldWindowResolved).toBe(false);
    expect(loadEngineOrders).toHaveBeenCalledTimes(2);

    releaseEarlier(ORDERS);
    await earlierBuild;
    await vi.waitFor(() => expect(loadEngineOrders).toHaveBeenCalledTimes(3));
    await oldWindow;
  });

  it("skips the year-long customer query when customer access is unavailable", async () => {
    await loadShopAnalytics(
      {
        ...SHOP,
        isDemo: false,
        grantedScopes: "read_orders read_products read_inventory",
      } as Shop,
      RANGE,
    );

    expect(loadCohortRows).not.toHaveBeenCalled();
  });

  it("retains cohort analysis for the bounded demo dataset", async () => {
    await loadShopAnalytics(
      { ...SHOP, id: "demo", isDemo: true, grantedScopes: null } as Shop,
      RANGE,
    );

    expect(loadCohortRows).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cover for what the analytics cache is allowed to hold on to.
 *
 * `fly.toml` gives this app a 1024MB VM, and the cache used to bound itself by
 * counting entries: 64 windows, whatever each one weighed. A 180-day window on
 * the seeded store — twelve thousand orders — retains 14.5MB, so the old bound permitted
 * roughly 930MB of cache on a 1GB box. Nothing failed on the demo store, which
 * is exactly why it survived five passes.
 */
describe("analytics cache retention", () => {
  const monthEnding = (month: number, day: number) => ({
    from: new Date(Date.UTC(2026, month, 1)),
    to: new Date(Date.UTC(2026, month, day)),
  });

  it("does not retain the engine's raw order input", async () => {
    const analytics = await loadShopAnalytics(SHOP, RANGE);

    // The hydrated `EngineOrder[]`, line items and all, was 57% of a cached
    // entry's weight and was read by nothing outside the function that built
    // it. Every consumer reads `period.orders`, which is the per-order profit
    // row, not the engine's input.
    expect(analytics).not.toHaveProperty("orders");
    expect(analytics.period.orders).toHaveLength(ORDERS.length);
  });

  it("evicts the oldest window once the retained rows exceed the budget", async () => {
    // Three orders per window, so a two-row budget is exceeded by the first
    // entry and every entry after it. The alternative — pushing 120,000 rows
    // through the profit engine — would measure the engine, not the bound.
    vi.stubEnv("MERIDIAN_ANALYTICS_CACHE_ORDERS", "2");

    const first = monthEnding(3, 30);
    const second = monthEnding(4, 31);

    await loadShopAnalytics(SHOP, first);
    await loadShopAnalytics(SHOP, second);

    const callsBefore = loadEngineOrders.mock.calls.length;

    // The newest window is still warm — the request that built it paid for it.
    await loadShopAnalytics(SHOP, second);
    expect(loadEngineOrders.mock.calls.length).toBe(callsBefore);

    // The one before it was dropped to stay inside the budget, so asking for it
    // again is a rebuild rather than a hit.
    await loadShopAnalytics(SHOP, first);
    expect(loadEngineOrders.mock.calls.length).toBe(callsBefore + 1);

    vi.unstubAllEnvs();
  });

  it("releases a retained full build before a scalar comparison hydrates orders", async () => {
    // The scalar result retains no order rows, but producing it still creates
    // the same peak order graph. The old full window must leave the cache before
    // that work starts, not merely after the new result exists.
    vi.stubEnv("MERIDIAN_ANALYTICS_CACHE_ORDERS", "2");

    const full = monthEnding(3, 30);
    const comparison = monthEnding(4, 31);

    await loadShopAnalytics(SHOP, full);
    await loadPeriodProfit(SHOP, comparison);

    const callsBefore = loadEngineOrders.mock.calls.length;

    await loadShopAnalytics(SHOP, full);

    expect(loadEngineOrders.mock.calls.length).toBe(callsBefore + 1);

    vi.unstubAllEnvs();
  });

  it("keeps a window that alone exceeds the budget, rather than never caching", async () => {
    // A store whose single window is bigger than the whole budget would
    // otherwise rebuild on every page load: the cache would cost its
    // bookkeeping and return nothing. One window is the peak that building it
    // already required.
    vi.stubEnv("MERIDIAN_ANALYTICS_CACHE_ORDERS", "1");

    await loadShopAnalytics(SHOP, RANGE);
    const callsBefore = loadEngineOrders.mock.calls.length;
    await loadShopAnalytics(SHOP, RANGE);

    expect(loadEngineOrders.mock.calls.length).toBe(callsBefore);

    vi.unstubAllEnvs();
  });
});
