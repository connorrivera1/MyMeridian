import { computeProfitForPeriod } from "~/engine/profit";
import type {
  AdSpendRow,
  CostRuleSet,
  EngineOrder,
} from "~/engine/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeRawCalls: unknown[][] = [];
const queryRawCalls: unknown[][] = [];
const shopFindUniqueOrThrow = vi.fn();
const shopUpdate = vi.fn();
const orderAggregate = vi.fn();

interface Slice {
  monthKey: string;
  from: Date;
  toExclusive: Date;
}

let monthSlices: Slice[] = [];
let customerRowsUpdated = 1;

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUniqueOrThrow: (...args: unknown[]) => shopFindUniqueOrThrow(...args),
      update: (...args: unknown[]) => shopUpdate(...args),
    },
    order: {
      aggregate: (...args: unknown[]) => orderAggregate(...args),
    },
    $queryRaw: (...args: unknown[]) => {
      queryRawCalls.push(args);
      return Promise.resolve(monthSlices);
    },
    $executeRaw: (...args: unknown[]) => {
      executeRawCalls.push(args);
      const [strings] = args as [readonly string[]];
      return Promise.resolve(
        strings.join("").includes("WITH aggregates") ? customerRowsUpdated : 1,
      );
    },
  },
}));

const DEFAULT_RULES: CostRuleSet = {
  paymentPercentRate: 0,
  paymentFixedPerOrderCents: 0,
  shippingDefaultPerOrderCents: 0,
  pickPackPerOrderCents: 0,
  pickPackPerItemCents: 0,
  monthlyOverheadCents: 0,
  provenance: {
    paymentFee: null,
    shippingDefault: null,
    pickPack: null,
    monthlyOverhead: null,
  },
};

const loadEngineOrders = vi.fn<
  (shopId: string, range: { from: Date; to: Date }) => Promise<EngineOrder[]>
>();
const loadAdSpend = vi.fn<
  (shopId: string, range: { from: Date; to: Date }) => Promise<AdSpendRow[]>
>();
const loadCostRules = vi.fn(async () => DEFAULT_RULES);
const assertEngineOrderWindow = vi.fn<
  (shopId: string, range: { from: Date; to: Date }) => Promise<number>
>();

vi.mock("~/data/queries.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/data/queries.server")>();
  return {
    ...actual,
    assertEngineOrderWindow: (
      ...args: Parameters<typeof assertEngineOrderWindow>
    ) => assertEngineOrderWindow(...args),
    loadEngineOrders: (...args: Parameters<typeof loadEngineOrders>) =>
      loadEngineOrders(...args),
    loadAdSpend: (...args: Parameters<typeof loadAdSpend>) =>
      loadAdSpend(...args),
    loadCostRules: (...args: Parameters<typeof loadCostRules>) =>
      loadCostRules(...args),
  };
});

const { recomputeShopProfitability } = await import("./recompute.server");
const { WindowTooLargeError } = await import("~/data/queries.server");

const LA = "America/Los_Angeles";
const DEFAULT_ORDER: EngineOrder = {
  id: "order_1",
  orderNumber: 1001,
  processedAt: new Date("2026-03-15T02:30:00.000Z"),
  customerId: "cust_1",
  channel: "GOOGLE",
  campaignId: null,
  isFirstOrder: true,
  subtotalCents: 10_000,
  discountTotalCents: 0,
  shippingChargedCents: 0,
  taxTotalCents: 0,
  totalCents: 10_000,
  refundedTotalCents: 0,
  actualShippingCostCents: null,
  actualPickPackCostCents: null,
  lineItems: [],
};

function sqlTextOf(call: unknown[]): string {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return strings
    .map((part, i) => {
      const value = values[i];
      const nested =
        value && typeof value === "object" && "strings" in (value as object)
          ? (value as { strings: readonly string[] }).strings.join("?")
          : "";
      return part + nested;
    })
    .join("");
}

function slice(
  monthKey: string,
  from: string,
  toExclusive: string,
): Slice {
  return {
    monthKey,
    from: new Date(from),
    toExclusive: new Date(toExclusive),
  };
}

function order(
  id: string,
  processedAt: string,
  overrides: Partial<EngineOrder> = {},
): EngineOrder {
  return {
    ...DEFAULT_ORDER,
    id,
    orderNumber: 2000 + Number(id.replace(/\D/g, "") || 0),
    processedAt: new Date(processedAt),
    ...overrides,
  };
}

function spend(
  date: string,
  spendCents: number,
  overrides: Partial<AdSpendRow> = {},
): AdSpendRow {
  return {
    date: new Date(date),
    channel: "FACEBOOK",
    campaignId: null,
    campaignName: null,
    spendCents,
    impressions: 0,
    clicks: 0,
    platformConversions: 0,
    platformRevenueCents: 0,
    ...overrides,
  };
}

beforeEach(() => {
  executeRawCalls.length = 0;
  queryRawCalls.length = 0;
  customerRowsUpdated = 1;
  monthSlices = [
    slice(
      "2026-03",
      "2026-03-01T08:00:00.000Z",
      "2026-04-01T07:00:00.000Z",
    ),
  ];

  shopFindUniqueOrThrow.mockReset();
  shopFindUniqueOrThrow.mockResolvedValue({
    id: "shop_1",
    timezone: LA,
  });
  shopUpdate.mockReset();
  shopUpdate.mockResolvedValue({});
  orderAggregate.mockReset();
  orderAggregate.mockResolvedValue({
    _min: { processedAt: DEFAULT_ORDER.processedAt },
  });

  loadEngineOrders.mockReset();
  loadEngineOrders.mockResolvedValue([DEFAULT_ORDER]);
  loadAdSpend.mockReset();
  loadAdSpend.mockResolvedValue([]);
  loadCostRules.mockReset();
  loadCostRules.mockResolvedValue(DEFAULT_RULES);
  assertEngineOrderWindow.mockReset();
  assertEngineOrderWindow.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
});

async function runRecompute() {
  const result = await recomputeShopProfitability("shop_1");
  return {
    result,
    statements: executeRawCalls.map(sqlTextOf),
    monthQuery: queryRawCalls.map(sqlTextOf).join("\n"),
  };
}

describe("bounded whole-history recompute", () => {
  it("takes only a shop id and holds the public whole-history contract", () => {
    expect(recomputeShopProfitability.length).toBe(1);
  });

  it("discovers order and spend months in the merchant timezone", async () => {
    const { monthQuery } = await runRecompute();

    expect(monthQuery).toContain('FROM "Order"');
    expect(monthQuery).toContain('FROM "AdSpend"');
    expect(monthQuery).toContain("AT TIME ZONE");
    expect(monthQuery).toContain("ORDER BY month_key ASC");
  });

  it("loads complete LA calendar months, including the DST boundary", async () => {
    monthSlices = [
      slice(
        "2026-02",
        "2026-02-01T08:00:00.000Z",
        "2026-03-01T08:00:00.000Z",
      ),
      slice(
        "2026-03",
        "2026-03-01T08:00:00.000Z",
        "2026-04-01T07:00:00.000Z",
      ),
    ];
    loadEngineOrders.mockResolvedValue([]);

    await runRecompute();

    const ranges = loadEngineOrders.mock.calls.map(([, range]) => range);
    expect(ranges[0]).toEqual({
      from: new Date("2026-02-01T08:00:00.000Z"),
      to: new Date("2026-03-01T07:59:59.999Z"),
    });
    // March is 743 hours in Los Angeles because clocks spring forward. A UTC
    // month would end at 08:00 and overlap April's first local hour.
    expect(ranges[1]).toEqual({
      from: new Date("2026-03-01T08:00:00.000Z"),
      to: new Date("2026-04-01T06:59:59.999Z"),
    });
  });

  it("is scalar-equivalent to one-shot computation across partial boundaries, DST, attribution, and pennies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));

    monthSlices = [
      slice(
        "2026-01",
        "2026-01-01T08:00:00.000Z",
        "2026-02-01T08:00:00.000Z",
      ),
      // Deliberately spend-only: a month query derived only from Order would
      // silently drop this money from net profit.
      slice(
        "2026-02",
        "2026-02-01T08:00:00.000Z",
        "2026-03-01T08:00:00.000Z",
      ),
      slice(
        "2026-03",
        "2026-03-01T08:00:00.000Z",
        "2026-04-01T07:00:00.000Z",
      ),
    ];

    const orders = [
      order("order_1", "2026-01-15T20:00:00.000Z", {
        channel: "FACEBOOK",
        campaignId: "campaign-a",
        subtotalCents: 12_345,
        totalCents: 13_580,
        taxTotalCents: 1_235,
        refundedTotalCents: 101,
      }),
      order("order_2", "2026-01-20T20:00:00.000Z", {
        channel: "FACEBOOK",
      }),
      // Both instants are March 8 in LA, on opposite sides of the DST jump.
      order("order_3", "2026-03-08T09:30:00.000Z", {
        channel: "GOOGLE",
      }),
      order("order_4", "2026-03-08T10:30:00.000Z", {
        channel: "GOOGLE",
      }),
    ];
    const spendRows = [
      spend("2026-01-15T12:00:00.000Z", 101, {
        campaignId: "campaign-a",
      }),
      spend("2026-01-20T12:00:00.000Z", 37),
      spend("2026-01-22T12:00:00.000Z", 19), // unattributed
      spend("2026-02-12T12:00:00.000Z", 777), // spend-only month
      // One indivisible cent split across two same-day orders.
      spend("2026-03-08T12:00:00.000Z", 1, { channel: "GOOGLE" }),
    ];
    const rules: CostRuleSet = {
      ...DEFAULT_RULES,
      paymentPercentRate: 0.029,
      paymentFixedPerOrderCents: 30,
      monthlyOverheadCents: 1_001,
    };
    const earliest = orders[0]!.processedAt;
    const globalRange = {
      from: earliest,
      to: new Date("2026-03-21T12:00:00.000Z"),
    };

    orderAggregate.mockResolvedValue({ _min: { processedAt: earliest } });
    loadCostRules.mockResolvedValue(rules);
    loadEngineOrders.mockImplementation(async (_shopId, range) =>
      orders.filter(
        (row) => row.processedAt >= range.from && row.processedAt <= range.to,
      ),
    );
    loadAdSpend.mockImplementation(async (_shopId, range) =>
      spendRows.filter((row) => row.date >= range.from && row.date <= range.to),
    );

    const expected = computeProfitForPeriod(
      orders,
      spendRows,
      rules,
      LA,
      globalRange,
    );
    const { result } = await runRecompute();

    expect(result).toMatchObject({
      ordersUpdated: expected.orderCount,
      netProfitCents: expected.netProfitCents,
      unattributedAdSpendCents: expected.unattributedAdCostCents,
    });
    expect(loadEngineOrders).toHaveBeenCalledTimes(3);
    expect(loadAdSpend).toHaveBeenCalledTimes(3);
    // Row reads freeze at the run start; only overhead proration reaches the
    // following day. A late order cannot slip into the current-month query.
    expect(loadEngineOrders.mock.calls.at(-1)![1].to).toEqual(
      new Date("2026-03-20T12:00:00.000Z"),
    );
    // February was not skipped merely because it had no orders.
    expect(
      loadAdSpend.mock.calls.some(([, range]) =>
        (range.from as Date) < new Date("2026-02-15T00:00:00.000Z") &&
        (range.to as Date) > new Date("2026-02-15T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("admits more than 60k lifetime orders when no single month exceeds the guard", async () => {
    monthSlices = [
      slice(
        "2026-01",
        "2026-01-01T08:00:00.000Z",
        "2026-02-01T08:00:00.000Z",
      ),
      slice(
        "2026-02",
        "2026-02-01T08:00:00.000Z",
        "2026-03-01T08:00:00.000Z",
      ),
    ];
    // Represent 40k in each month without allocating 80k object graphs.
    assertEngineOrderWindow
      .mockResolvedValueOnce(40_000)
      .mockResolvedValueOnce(40_000);
    loadEngineOrders.mockResolvedValue([]);

    await expect(recomputeShopProfitability("shop_1")).resolves.toMatchObject({
      ordersUpdated: 0,
    });
    expect(assertEngineOrderWindow).toHaveBeenCalledTimes(2);
    expect(loadEngineOrders).toHaveBeenCalledTimes(2);
  });

  it("preflights every month so a later oversized month cannot leave partial writes", async () => {
    monthSlices = [
      slice(
        "2026-01",
        "2026-01-01T08:00:00.000Z",
        "2026-02-01T08:00:00.000Z",
      ),
      slice(
        "2026-02",
        "2026-02-01T08:00:00.000Z",
        "2026-03-01T08:00:00.000Z",
      ),
    ];
    assertEngineOrderWindow
      .mockResolvedValueOnce(40_000)
      .mockRejectedValueOnce(new WindowTooLargeError(60_001, 60_000));

    await expect(recomputeShopProfitability("shop_1")).rejects.toBeInstanceOf(
      WindowTooLargeError,
    );
    expect(assertEngineOrderWindow).toHaveBeenCalledTimes(2);
    expect(loadEngineOrders).not.toHaveBeenCalled();
    expect(shopUpdate).not.toHaveBeenCalled();
    // Not even January's order UPDATE ran before February refused admission.
    expect(executeRawCalls).toHaveLength(0);
  });

  it("deduplicates concurrent recomputes and admits the whole run only once", async () => {
    let releaseOrders!: (orders: EngineOrder[]) => void;
    loadEngineOrders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOrders = resolve;
        }),
    );

    const first = recomputeShopProfitability("shop_1");
    const second = recomputeShopProfitability("shop_1");

    expect(first).toBe(second);
    await vi.waitFor(() => expect(loadEngineOrders).toHaveBeenCalledTimes(1));
    releaseOrders([]);
    await Promise.all([first, second]);
    expect(loadEngineOrders).toHaveBeenCalledTimes(1);
  });
});

describe("SQL customer lifetime reset", () => {
  it("aggregates every shop customer and resets customers with no orders", async () => {
    loadEngineOrders.mockResolvedValue([]);
    orderAggregate.mockResolvedValue({ _min: { processedAt: null } });
    customerRowsUpdated = 7;

    const { result, statements } = await runRecompute();
    const customerWrite = statements.find((sql) =>
      sql.includes("WITH aggregates"),
    )!;

    expect(result.customersUpdated).toBe(7);
    expect(customerWrite).toContain('FROM "Customer" AS c');
    expect(customerWrite).toContain('LEFT JOIN "Order" AS o');
    expect(customerWrite).toContain("COUNT(o.id)");
    expect(customerWrite).toContain('MIN(o."processedAt")');
    expect(customerWrite).toContain('c."shopId"');
  });

  it("applies JavaScript rounding to each ex-tax refund before summing revenue", async () => {
    const { statements } = await runRecompute();
    const customerWrite = statements.find((sql) =>
      sql.includes("WITH aggregates"),
    )!;

    const roundAt = customerWrite.indexOf("FLOOR(");
    const sumAt = customerWrite.indexOf("SUM(");
    // FLOOR(x + 0.5), JavaScript's Math.round rule, is nested inside SUM rather
    // than applied to the customer total.
    expect(sumAt).toBeGreaterThanOrEqual(0);
    expect(roundAt).toBeGreaterThan(sumAt);
    expect(customerWrite).toContain('o."refundedTotal" * 100');
    expect(customerWrite).toContain('o.total - o."taxTotal"');
    expect(customerWrite).toContain("+ 0.5");
  });

  it("keeps post-cutoff orders out of customer totals without losing empty customers", async () => {
    const { statements } = await runRecompute();
    const customerWrite = statements.find((sql) =>
      sql.includes("WITH aggregates"),
    )!;

    const joinAt = customerWrite.indexOf('LEFT JOIN "Order" AS o');
    const cutoffAt = customerWrite.indexOf('o."processedAt" <=');
    const whereAt = customerWrite.indexOf('WHERE c."shopId"');
    expect(joinAt).toBeGreaterThanOrEqual(0);
    expect(cutoffAt).toBeGreaterThan(joinAt);
    // In the JOIN predicate, not WHERE: otherwise the LEFT JOIN collapses and
    // stale customers with no eligible orders never receive their reset.
    expect(cutoffAt).toBeLessThan(whereAt);
    expect(customerWrite).toContain("::timestamptz AT TIME ZONE 'UTC'");
  });

  it("updates the shop stamp only after every order and customer write", async () => {
    vi.useFakeTimers();
    const cutoff = new Date("2026-08-10T17:45:00.000Z");
    vi.setSystemTime(cutoff);
    await runRecompute();

    expect(shopUpdate).toHaveBeenCalledWith({
      where: { id: "shop_1" },
      data: { lastComputedAt: cutoff },
    });
    expect(executeRawCalls.map(sqlTextOf).at(-1)).toContain("WITH aggregates");
  });
});
