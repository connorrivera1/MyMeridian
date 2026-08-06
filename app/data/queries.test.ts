import { beforeEach, describe, expect, it, vi } from "vitest";

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
const fulfillmentGroupBy = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    order: { findMany: (...args: unknown[]) => orderFindMany(...args) },
    fulfillment: { groupBy: (...args: unknown[]) => fulfillmentGroupBy(...args) },
  },
}));

const { loadEngineOrders } = await import("./queries.server");

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
  fulfillmentGroupBy.mockReset();
});

describe("loadEngineOrders fulfilment costs", () => {
  it("adds up every parcel of a split shipment into one order total", async () => {
    orderFindMany.mockResolvedValue([orderRow("order_1")]);
    // Three parcels, already summed by Postgres.
    fulfillmentGroupBy.mockResolvedValue([
      { orderId: "order_1", _sum: { shippingCost: "18.75", pickPackCost: "4.20" } },
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
      { orderId: "order_1", _sum: { shippingCost: "0.00", pickPackCost: "0.00" } },
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
      { orderId: "order_3", _sum: { shippingCost: "9.00", pickPackCost: "1.00" } },
      { orderId: "order_1", _sum: { shippingCost: "7.50", pickPackCost: "2.00" } },
    ]);

    const orders = await loadEngineOrders("shop_1", RANGE);

    expect(orders.map((o) => o.actualShippingCostCents)).toEqual([750, null, 900]);
    expect(orders.map((o) => o.actualPickPackCostCents)).toEqual([200, null, 100]);
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

    const [args] = orderFindMany.mock.calls[0] as [{ include: Record<string, unknown> }];
    expect(args.include).toEqual({ lineItems: true });
    expect(args.include.fulfillments).toBeUndefined();
  });
});
