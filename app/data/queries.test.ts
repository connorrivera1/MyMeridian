import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostRuleKind, CostRuleOrigin, type CostRule } from "@prisma/client";

/**
 * Cover for the Prisma → engine boundary, specifically the fulfilment cost
 * totals.
 *
 * `loadEngineOrders` used to hydrate every fulfilment row of every order in the
 * window purely to add two columns up in JavaScript. A store that splits
 * shipments pays for that per parcel, on every page load, on a query that has
 * no `take`. The sum now happens in Postgres, so these tests exist to prove the
 * numbers that come back are the same ones and that the aggregate is scoped as
 * tightly as the row query was — an aggregate that forgot the window filter
 * would read the whole table and still look correct on a small store.
 */

const orderFindMany = vi.fn();
const orderCount = vi.fn(async (..._args: unknown[]) => 0);
const fulfillmentGroupBy = vi.fn();
const adjustmentGroupBy = vi.fn(
  async (..._args: unknown[]): Promise<unknown[]> => [],
);
const costRuleFindMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    order: {
      findMany: (...args: unknown[]) => orderFindMany(...args),
      // The guard that refuses an oversized window counts before hydrating.
      // Default to a count these tests are comfortably under; the guard has
      // its own cases below.
      count: (...args: unknown[]) => orderCount(...args),
    },
    fulfillment: {
      groupBy: (...args: unknown[]) => fulfillmentGroupBy(...args),
    },
    shippingLabelAdjustment: {
      groupBy: (...args: unknown[]) => adjustmentGroupBy(...args),
    },
    costRule: {
      findMany: (...args: unknown[]) => costRuleFindMany(...args),
    },
  },
}));

const {
  loadCohortRows,
  loadCostRules,
  loadEngineOrders,
  toCostRuleSet,
  WindowTooLargeError,
} = await import("./queries.server");

const RANGE = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-31T23:59:59.999Z"),
};

function orderRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    orderNumber: 1001,
    processedAt: new Date("2026-07-10T09:00:00.000Z"),
    customerId: "cust_1",
    channel: "GOOGLE",
    campaignId: null,
    isFirstOrder: true,
    subtotal: "100.00",
    discountTotal: "0.00",
    shippingCharged: "0.00",
    taxTotal: "0.00",
    total: "100.00",
    refundedTotal: "0.00",
    lineItems: [],
    ...overrides,
  };
}

beforeEach(() => {
  orderFindMany.mockReset();
  orderCount.mockClear();
  fulfillmentGroupBy.mockReset();
  adjustmentGroupBy.mockReset();
  adjustmentGroupBy.mockResolvedValue([]);
  costRuleFindMany.mockReset();
});

function costRule(
  kind: CostRuleKind,
  values: Partial<CostRule> = {},
): CostRule {
  return {
    id: `rule_${kind}`,
    shopId: "shop_1",
    kind,
    label: kind,
    percentRate: null,
    fixedPerOrder: null,
    fixedPerItem: null,
    monthlyAmount: null,
    appliesToChannel: null,
    active: true,
    origin: CostRuleOrigin.INSTALL_DEFAULT,
    confirmedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...values,
  } as CostRule;
}

describe("loadCostRules provenance", () => {
  it("carries install-default confirmation state into the engine", async () => {
    costRuleFindMany.mockResolvedValue([
      costRule(CostRuleKind.PAYMENT_FEE, {
        percentRate: "0.029" as never,
        fixedPerOrder: "0.30" as never,
      }),
      costRule(CostRuleKind.SHIPPING_DEFAULT, {
        fixedPerOrder: "8.50" as never,
        confirmedAt: new Date("2026-08-02T00:00:00.000Z"),
      }),
    ]);

    const result = await loadCostRules("shop_1");

    expect(costRuleFindMany).toHaveBeenCalledWith({
      where: { shopId: "shop_1" },
    });
    expect(result.paymentPercentRate).toBe(0.029);
    expect(result.provenance.paymentFee).toEqual({
      origin: "INSTALL_DEFAULT",
      confirmed: false,
    });
    expect(result.provenance.shippingDefault).toEqual({
      origin: "INSTALL_DEFAULT",
      confirmed: true,
    });
  });

  it("does not let an inactive unconfirmed rule taint the active rule", () => {
    const result = toCostRuleSet([
      costRule(CostRuleKind.PICK_PACK, {
        fixedPerOrder: "99.00" as never,
        active: false,
      }),
      costRule(CostRuleKind.PICK_PACK, {
        id: "active_pick_pack",
        fixedPerOrder: "1.75" as never,
        origin: CostRuleOrigin.MERCHANT_CONFIGURED,
        confirmedAt: new Date("2026-08-02T00:00:00.000Z"),
      }),
    ]);

    expect(result.pickPackPerOrderCents).toBe(175);
    expect(result.provenance.pickPack).toEqual({
      origin: "MERCHANT_CONFIGURED",
      confirmed: true,
    });
  });
});

describe("loadEngineOrders fulfilment costs", () => {
  it("adds up every parcel of a split shipment into one order total", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    // Three parcels, already summed by Postgres.
    fulfillmentGroupBy.mockResolvedValue([
      {
        orderId: "order_1",
        _sum: { shippingCost: "18.75", pickPackCost: "4.20" },
      },
    ]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    expect(order.actualShippingCostCents).toBe(1875);
    expect(order.actualPickPackCostCents).toBe(420);
  });

  it("leaves an order with no fulfilment on the merchant's cost rule", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    fulfillmentGroupBy.mockResolvedValue([]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    // null, not 0 — 0 would be read as "shipped for free" and would suppress
    // the fallback to the shipping cost rule entirely.
    expect(order.actualShippingCostCents).toBeNull();
    expect(order.actualPickPackCostCents).toBeNull();
  });

  it("treats a zero total as not-known-yet rather than free", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    // A fulfilment exists but carries no carrier cost: Shopify's own webhooks
    // never populate one, it arrives from the 3PL connector.
    fulfillmentGroupBy.mockResolvedValue([
      {
        orderId: "order_1",
        _sum: { shippingCost: "0.00", pickPackCost: "0.00" },
      },
    ]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    expect(order.actualShippingCostCents).toBeNull();
    expect(order.actualPickPackCostCents).toBeNull();
  });

  it("keeps each order's totals on its own order", async () => {
    orderFindMany.mockResolvedValue([
      orderRow("order_1"),
      orderRow("order_2", { orderNumber: 1002 }),
      orderRow("order_3", { orderNumber: 1003 }),
    ]);
    fulfillmentGroupBy.mockResolvedValue([
      // Deliberately not in the same order as the orders themselves — the join
      // is by id, and a positional match would pass on sorted input only.
      {
        orderId: "order_3",
        _sum: { shippingCost: "9.00", pickPackCost: "1.00" },
      },
      {
        orderId: "order_1",
        _sum: { shippingCost: "7.50", pickPackCost: "2.00" },
      },
    ]);

    const orders = await loadEngineOrders("shop_1", RANGE);

    expect(orders.map((o) => o.actualShippingCostCents)).toEqual([
      750,
      null,
      900,
    ]);
    expect(orders.map((o) => o.actualPickPackCostCents)).toEqual([
      200,
      null,
      100,
    ]);
  });

  it("handles a null sum, which is what Postgres returns for no rows", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    fulfillmentGroupBy.mockResolvedValue([
      { orderId: "order_1", _sum: { shippingCost: null, pickPackCost: null } },
    ]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    expect(order.actualShippingCostCents).toBeNull();
    expect(order.actualPickPackCostCents).toBeNull();
  });

  it("folds a carrier correction into the actual outbound cost", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    fulfillmentGroupBy.mockResolvedValue([
      {
        orderId: "order_1",
        _sum: { shippingCost: "10.00", pickPackCost: null },
      },
    ]);
    adjustmentGroupBy.mockResolvedValue([
      { orderId: "order_1", kind: "CARRIER_ADJUSTMENT", _sum: { amount: "4.20" } },
    ]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    expect(order.actualShippingCostCents).toBe(1420);
    expect(order.returnShippingCostCents).toBe(0);
  });

  it("treats a recorded label purchase as known cost even with no fulfilment cost", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    fulfillmentGroupBy.mockResolvedValue([]);
    adjustmentGroupBy.mockResolvedValue([
      { orderId: "order_1", kind: "LABEL_PURCHASE", _sum: { amount: "6.10" } },
    ]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    // Not null: a bought label is real evidence, so the modeled shipping rule
    // must not also be charged on top of it.
    expect(order.actualShippingCostCents).toBe(610);
  });

  it("keeps return labels on their own line, not inside outbound cost", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    fulfillmentGroupBy.mockResolvedValue([
      {
        orderId: "order_1",
        _sum: { shippingCost: "10.00", pickPackCost: null },
      },
    ]);
    adjustmentGroupBy.mockResolvedValue([
      { orderId: "order_1", kind: "RETURN_LABEL", _sum: { amount: "7.25" } },
    ]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    expect(order.actualShippingCostCents).toBe(1000);
    expect(order.returnShippingCostCents).toBe(725);
  });

  it("lets a carrier credit reduce the actual cost below the quote", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    fulfillmentGroupBy.mockResolvedValue([
      {
        orderId: "order_1",
        _sum: { shippingCost: "10.00", pickPackCost: null },
      },
    ]);
    adjustmentGroupBy.mockResolvedValue([
      {
        orderId: "order_1",
        kind: "CARRIER_ADJUSTMENT",
        _sum: { amount: "-3.40" },
      },
    ]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    expect(order.actualShippingCostCents).toBe(660);
  });

  it("maps retained return fees onto the engine order", async () => {
    orderFindMany.mockResolvedValue([
      orderRow("order_1", { returnFeesRetained: "12.50" }),
    ]);
    fulfillmentGroupBy.mockResolvedValue([]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    expect(order.returnFeesRetainedCents).toBe(1250);
  });

  it("scopes the aggregate to the same shop and window as the rows", async () => {
    orderFindMany.mockResolvedValue([]);
    fulfillmentGroupBy.mockResolvedValue([]);

    await loadEngineOrders("shop_1", RANGE);

    expect(fulfillmentGroupBy).toHaveBeenCalledWith({
      by: ["orderId"],
      where: {
        shopId: "shop_1",
        order: { processedAt: { gte: RANGE.from, lte: RANGE.to } },
      },
      _sum: { shippingCost: true, pickPackCost: true },
    });
  });

  it("no longer hydrates fulfilment rows alongside the orders", async () => {
    orderFindMany.mockResolvedValue([]);
    fulfillmentGroupBy.mockResolvedValue([]);

    await loadEngineOrders("shop_1", RANGE);

    const [args] = orderFindMany.mock.calls[0] as [
      { select: Record<string, unknown>; include?: unknown },
    ];
    expect(args.include).toBeUndefined();
    expect(args.select.fulfillments).toBeUndefined();
  });
});

/**
 * The order query is a projection, not a whole-row read.
 *
 * `EngineOrder` uses thirteen of `Order`'s columns and the mapping discards the
 * rest, so reading the whole row spent the transfer and the parse on columns
 * nothing downstream could see — including eight materialised profit `Decimal`s
 * that Prisma inflates into `Decimal.js` instances on the way to being ignored.
 *
 * These pin the column list itself. A `select` is the one kind of query where
 * adding a field is silent and subtracting one is a crash much later, in a
 * mapping that reads `undefined` as zero money, so the list is asserted exactly
 * rather than sampled.
 */
describe("loadEngineOrders column projection", () => {
  async function selectArg() {
    orderFindMany.mockResolvedValue([]);
    fulfillmentGroupBy.mockResolvedValue([]);
    await loadEngineOrders("shop_1", RANGE);
    const [args] = orderFindMany.mock.calls[0] as [
      { select: Record<string, unknown> },
    ];
    return args.select;
  }

  it("asks for exactly the order columns the engine reads", async () => {
    const select = await selectArg();

    expect(Object.keys(select).sort()).toEqual(
      [
        "campaignId",
        "channel",
        "customerId",
        "discountTotal",
        "id",
        "isFirstOrder",
        "lineItems",
        "orderNumber",
        "processedAt",
        "refundedTotal",
        "returnFeesRetained",
        "shippingCharged",
        "subtotal",
        "taxTotal",
        "total",
      ].sort(),
    );
  });

  it("asks for exactly the line item columns the engine reads", async () => {
    const select = await selectArg();
    const lineItems = select.lineItems as { select: Record<string, unknown> };

    expect(Object.keys(lineItems.select).sort()).toEqual(
      [
        "discount",
        "id",
        "productId",
        "quantity",
        "refundedQty",
        "title",
        "unitCost",
        "unitPrice",
        "variantId",
      ].sort(),
    );
  });

  it("leaves the materialised profit columns unread", async () => {
    const select = await selectArg();

    // `recompute` writes these; every dashboard figure is computed on the fly
    // from the columns above. Reading them here would be pure transfer cost,
    // and worse, would make a stale cache look like an input.
    for (const column of [
      "cogsTotal",
      "shippingCost",
      "paymentFee",
      "adCostAttributed",
      "overheadAllocated",
      "contributionProfit",
      "netProfit",
      "computedAt",
    ]) {
      expect(select[column]).toBeUndefined();
    }
  });

  it("still filters the same rows and gives penny allocation a total order", async () => {
    orderFindMany.mockResolvedValue([]);
    fulfillmentGroupBy.mockResolvedValue([]);

    await loadEngineOrders("shop_1", RANGE);

    const [args] = orderFindMany.mock.calls[0] as [Record<string, unknown>];
    expect(args.where).toEqual({
      shopId: "shop_1",
      processedAt: { gte: RANGE.from, lte: RANGE.to },
    });
    expect(args.orderBy).toEqual([{ processedAt: "asc" }, { id: "asc" }]);
  });

  it("maps a projected row to the same EngineOrder the whole row produced", async () => {
    // The row shape here is exactly what the projection returns — no extra
    // columns — so this fails if the mapping ever reaches for one that is no
    // longer selected.
    orderFindMany.mockResolvedValue([
      {
        id: "order_1",
        orderNumber: 1001,
        processedAt: new Date("2026-07-10T09:00:00.000Z"),
        customerId: "cust_1",
        channel: "GOOGLE",
        campaignId: "camp_1",
        isFirstOrder: true,
        subtotal: "100.00",
        discountTotal: "5.00",
        shippingCharged: "7.50",
        taxTotal: "8.25",
        total: "110.75",
        refundedTotal: "10.00",
        lineItems: [
          {
            id: "li_1",
            productId: "prod_1",
            variantId: "var_1",
            title: "Alpine Shell Jacket",
            quantity: 2,
            refundedQty: 1,
            unitPrice: "50.00",
            discount: "5.00",
            unitCost: "21.5000",
          },
        ],
      },
    ]);
    fulfillmentGroupBy.mockResolvedValue([]);

    const [order] = await loadEngineOrders("shop_1", RANGE);
    if (!order) throw new Error("expected one order back");

    expect(order).toEqual({
      id: "order_1",
      orderNumber: 1001,
      processedAt: new Date("2026-07-10T09:00:00.000Z"),
      customerId: "cust_1",
      channel: "GOOGLE",
      campaignId: "camp_1",
      isFirstOrder: true,
      subtotalCents: 10000,
      discountTotalCents: 500,
      shippingChargedCents: 750,
      taxTotalCents: 825,
      totalCents: 11075,
      refundedTotalCents: 1000,
      returnFeesRetainedCents: 0,
      actualShippingCostCents: null,
      actualPickPackCostCents: null,
      returnShippingCostCents: 0,
      lineItems: [
        {
          id: "li_1",
          productId: "prod_1",
          variantId: "var_1",
          title: "Alpine Shell Jacket",
          quantity: 2,
          refundedQty: 1,
          unitPriceCents: 5000,
          discountCents: 500,
          unitCostMicros: 215000,
        },
      ],
    });
  });
});

/**
 * The cohort query is where a missing column changes an answer instead of
 * breaking a build.
 *
 * It feeds CAC, the LTV curve, payback and each channel's verdict. Drop
 * `isFirstOrder` and none of that fails — every customer who merely reordered
 * inside the lookback silently reads as a fresh acquisition, and the channel's
 * spend gets divided by more customers than it bought. Pinned here for the same
 * reason the projection above is, and because the failure is invisible.
 */
describe("loadCohortRows column projection", () => {
  async function selectArg() {
    orderFindMany.mockResolvedValue([]);
    await loadCohortRows("shop_1", RANGE);
    const [args] = orderFindMany.mock.calls[0] as [
      { select: Record<string, unknown> },
    ];
    return args.select;
  }

  it("reads the acquisition flag the cohort maths depends on", async () => {
    expect((await selectArg()).isFirstOrder).toBe(true);
  });

  it("asks for exactly the columns a journey needs", async () => {
    expect(Object.keys(await selectArg()).sort()).toEqual(
      [
        "adCostAttributed",
        "campaignId",
        "channel",
        "contributionProfit",
        "customerId",
        "isFirstOrder",
        "processedAt",
      ].sort(),
    );
  });

  it("scopes to the shop, the window, and orders that have a customer", async () => {
    orderFindMany.mockResolvedValue([]);
    await loadCohortRows("shop_1", RANGE);

    const [args] = orderFindMany.mock.calls[0] as [Record<string, unknown>];
    expect(args.where).toEqual({
      shopId: "shop_1",
      processedAt: { gte: RANGE.from, lte: RANGE.to },
      customerId: { not: null },
    });
  });

  it("carries the flag through to the row the engine consumes", async () => {
    orderFindMany.mockResolvedValue([
      {
        customerId: "cust_1",
        processedAt: new Date("2026-07-10T09:00:00.000Z"),
        channel: "GOOGLE",
        campaignId: null,
        isFirstOrder: false,
        contributionProfit: "12.34",
        adCostAttributed: "5.00",
      },
    ]);

    expect(await loadCohortRows("shop_1", RANGE)).toEqual([
      {
        customerId: "cust_1",
        processedAt: new Date("2026-07-10T09:00:00.000Z"),
        channel: "GOOGLE",
        campaignId: null,
        isFirstOrder: false,
        contributionProfitCents: 1234,
        adCostCents: 500,
      },
    ]);
  });

  it("refuses an oversized year before hydrating customer rows", async () => {
    orderCount.mockResolvedValueOnce(60_001);

    await expect(loadCohortRows("shop_1", RANGE)).rejects.toBeInstanceOf(
      WindowTooLargeError,
    );
    expect(orderFindMany).not.toHaveBeenCalled();
    expect(orderCount).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        processedAt: { gte: RANGE.from, lte: RANGE.to },
        customerId: { not: null },
      },
    });
  });
});

/*
 * The window guard.
 *
 * `loadEngineOrders` deliberately has no `take` — a profit total computed from
 * a truncated set of orders is a wrong answer, not a smaller one. So the only
 * safe response to a window too large to hydrate is to refuse it, because the
 * alternative is an OOM, and with one machine running that takes the app down
 * for every merchant rather than for the one who picked the range.
 */
describe("loadEngineOrders window guard", () => {
  it("refuses a window with more orders than it will hydrate", async () => {
    orderCount.mockResolvedValueOnce(60_001);

    await expect(loadEngineOrders("shop_1", RANGE)).rejects.toBeInstanceOf(
      WindowTooLargeError,
    );

    // Refused before hydrating, which is the entire point — a guard that runs
    // after the findMany has already spent the memory it was guarding.
    expect(orderFindMany).not.toHaveBeenCalled();
  });

  it("carries the numbers a merchant needs to act on", async () => {
    orderCount.mockResolvedValueOnce(75_000);

    const failure = await loadEngineOrders("shop_1", RANGE).catch((e) => e);

    expect(failure).toBeInstanceOf(WindowTooLargeError);
    expect(failure.orderCount).toBe(75_000);
    expect(failure.limit).toBe(60_000);
    // Says what to do, not just that something is wrong.
    expect(failure.message).toMatch(/75,000/);
    expect(failure.message).toMatch(/shorter range/i);
  });

  it("counts against the same shop and window it would hydrate", async () => {
    orderCount.mockResolvedValueOnce(0);
    orderFindMany.mockResolvedValueOnce([]);
    fulfillmentGroupBy.mockResolvedValueOnce([]);

    await loadEngineOrders("shop_1", RANGE);

    // A count scoped more loosely than the row query would refuse windows that
    // are actually fine, and one scoped more tightly would let a big one past.
    expect(orderCount).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        processedAt: { gte: RANGE.from, lte: RANGE.to },
      },
    });
  });

  it("lets a window at the limit through", async () => {
    orderCount.mockResolvedValueOnce(60_000);
    orderFindMany.mockResolvedValueOnce([]);
    fulfillmentGroupBy.mockResolvedValueOnce([]);

    await expect(loadEngineOrders("shop_1", RANGE)).resolves.toEqual([]);
  });
});
