import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for the webhook order sync.
 *
 * Prisma is mocked rather than hit: these assertions are about the *decision*
 * `syncOrderFromShopify` makes, and that decision is fully described by the
 * query it issues. Keeping it in-process also keeps `npm test` runnable
 * without a database, which every other suite here already assumes.
 */

const orderCount = vi.fn();
const orderUpsert = vi.fn();
const orderFindUnique = vi.fn();
const orderUpdate = vi.fn();
const customerUpsert = vi.fn();
const fulfillmentFindUnique = vi.fn();
const fulfillmentFindFirst = vi.fn();
const fulfillmentCreate = vi.fn();
const fulfillmentUpdate = vi.fn();
const fulfillmentCount = vi.fn();
let fulfillmentRows: any[] = [];

vi.mock("~/db.server", () => ({
  default: {
    order: {
      count: (...args: unknown[]) => orderCount(...args),
      upsert: (...args: unknown[]) => orderUpsert(...args),
      findUnique: (...args: unknown[]) => orderFindUnique(...args),
      update: (...args: unknown[]) => orderUpdate(...args),
    },
    customer: {
      upsert: (...args: unknown[]) => customerUpsert(...args),
    },
    orderLineItem: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    fulfillment: {
      findUnique: (...args: unknown[]) => fulfillmentFindUnique(...args),
      findFirst: (...args: unknown[]) => fulfillmentFindFirst(...args),
      create: (...args: unknown[]) => fulfillmentCreate(...args),
      update: (...args: unknown[]) => fulfillmentUpdate(...args),
      count: (...args: unknown[]) => fulfillmentCount(...args),
    },
    variant: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const { syncOrderFromShopify, syncFulfillmentFromShopify } = await import("./sync.server");

const SHOP_ID = "shop_1";
const PROCESSED_AT = "2026-07-01T10:00:00Z";

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 99900001,
    order_number: 1001,
    processed_at: PROCESSED_AT,
    created_at: PROCESSED_AT,
    currency: "USD",
    subtotal_price: "100.00",
    total_discounts: "0.00",
    total_tax: "0.00",
    total_price: "100.00",
    financial_status: "paid",
    customer: { id: 55500001, email: "buyer@example.com" },
    line_items: [],
    ...overrides,
  };
}

function fulfillmentPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 77700001,
    order_id: 99900001,
    created_at: "2026-07-02T09:00:00Z",
    status: "success",
    tracking_company: "UPS",
    service: "ground",
    location_id: 4001,
    line_items: [{ quantity: 2 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  customerUpsert.mockResolvedValue({ id: "cust_1" });
  orderUpsert.mockImplementation(async ({ create }: any) => ({
    id: "order_1",
    ...create,
  }));
  orderCount.mockResolvedValue(0);

  orderFindUnique.mockResolvedValue({ id: "order_1" });
  orderUpdate.mockResolvedValue({ id: "order_1" });

  // A fake table rather than a flat `null`: the defect being covered is that
  // two lookups which differ only in their `where` returned the same row, so a
  // mock that answers the same thing to every query cannot see it.
  fulfillmentRows = [];
  fulfillmentFindUnique.mockImplementation(async ({ where }: any) => {
    const key = where.shopId_shopifyId;
    return (
      fulfillmentRows.find(
        (row) => row.shopId === key.shopId && row.shopifyId === key.shopifyId,
      ) ?? null
    );
  });
  fulfillmentFindFirst.mockImplementation(async ({ where }: any) => {
    return (
      fulfillmentRows.find(
        (row) =>
          row.shopId === where.shopId &&
          row.orderId === where.orderId &&
          row.createdAt.getTime() === new Date(where.createdAt).getTime() &&
          (where.shopifyId === undefined || row.shopifyId === where.shopifyId),
      ) ?? null
    );
  });
  fulfillmentCreate.mockImplementation(async ({ data }: any) => {
    const row = { id: `ful_${fulfillmentRows.length + 1}`, ...data };
    fulfillmentRows.push(row);
    return row;
  });
  fulfillmentUpdate.mockImplementation(async ({ where, data }: any) => {
    const row = fulfillmentRows.find((candidate) => candidate.id === where.id);
    if (row) return Object.assign(row, data);
    return { id: where.id, ...data };
  });
  fulfillmentCount.mockResolvedValue(1);
});

describe("syncOrderFromShopify — isFirstOrder", () => {
  it("excludes the order being written from its own first-order test", async () => {
    // Shopify redelivers the same order as orders/created, orders/updated and
    // again inside refunds/create. If the count includes the order itself,
    // every redelivery flips a genuine first order to false.
    await syncOrderFromShopify(SHOP_ID, orderPayload());

    expect(orderCount).toHaveBeenCalledTimes(1);
    const where = orderCount.mock.calls[0]![0].where;

    expect(where.customerId).toBe("cust_1");
    expect(where.shopifyId).toEqual({
      not: "gid://shopify/Order/99900001",
    });
  });

  it("only counts orders that genuinely precede this one", async () => {
    // Backfill and webhooks can write a customer's orders out of order. A
    // later order arriving first must not permanently claim the flag.
    await syncOrderFromShopify(SHOP_ID, orderPayload());

    const where = orderCount.mock.calls[0]![0].where;
    expect(where.processedAt).toEqual({ lt: new Date(PROCESSED_AT) });
  });

  it("stays true on redelivery of a genuine first order", async () => {
    // No earlier order exists, so both deliveries must agree.
    const first = await syncOrderFromShopify(SHOP_ID, orderPayload());
    const redelivered = await syncOrderFromShopify(SHOP_ID, orderPayload());

    expect(first.isFirstOrder).toBe(true);
    expect(redelivered.isFirstOrder).toBe(true);
  });

  it("is false when the customer has an genuinely earlier order", async () => {
    orderCount.mockResolvedValue(1);

    const order = await syncOrderFromShopify(SHOP_ID, orderPayload());

    expect(order.isFirstOrder).toBe(false);
  });

  it("is false for a guest checkout with no customer", async () => {
    // No customer means no acquisition to attribute; it must not count as a
    // new customer or CAC is divided by an inflated denominator.
    const order = await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({ customer: undefined }),
    );

    expect(order.isFirstOrder).toBe(false);
    expect(orderCount).not.toHaveBeenCalled();
  });
});

describe("syncFulfillmentFromShopify", () => {
  it("stores Shopify's fulfilment id so an update has something to match on", async () => {
    await syncFulfillmentFromShopify(SHOP_ID, fulfillmentPayload());

    const data = fulfillmentCreate.mock.calls[0]![0].data;
    expect(data.shopifyId).toBe("gid://shopify/Fulfillment/77700001");
    expect(data.itemCount).toBe(2);
  });

  it("applies a status and carrier change instead of dropping it", async () => {
    // fulfillments/update repeats the original created_at. Matching on time
    // alone read this as a duplicate and returned early, so a cancellation or
    // a carrier correction never reached the row.
    fulfillmentFindUnique.mockResolvedValue({
      id: "ful_1",
      shopifyId: "gid://shopify/Fulfillment/77700001",
      status: "success",
      carrier: "UPS",
    });
    fulfillmentCount.mockResolvedValue(0);

    await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload({ status: "cancelled", tracking_company: "FedEx" }),
    );

    expect(fulfillmentCreate).not.toHaveBeenCalled();
    const { where, data } = fulfillmentUpdate.mock.calls[0]![0];
    expect(where.id).toBe("ful_1");
    expect(data.status).toBe("cancelled");
    expect(data.carrier).toBe("FedEx");
    // A cancelled fulfilment never shipped; leaving shippedAt set would count
    // it against the warehouse's throughput.
    expect(data.shippedAt).toBeNull();
  });

  it("keeps two shipments created in the same second apart", async () => {
    // Both carry the same created_at, so the old triple match collapsed the
    // second into the first and lost a shipment from the capacity series.
    await syncFulfillmentFromShopify(SHOP_ID, fulfillmentPayload({ id: 77700001 }));
    await syncFulfillmentFromShopify(SHOP_ID, fulfillmentPayload({ id: 77700002 }));

    expect(fulfillmentCreate).toHaveBeenCalledTimes(2);
    expect(fulfillmentUpdate).not.toHaveBeenCalled();
  });

  it("adopts a pre-migration row by timestamp rather than duplicating it", async () => {
    // Rows imported before shopifyId existed carry none. The first update to
    // one of them must claim it, not write a second row beside it.
    fulfillmentFindUnique.mockResolvedValue(null);
    fulfillmentFindFirst.mockResolvedValue({ id: "ful_legacy", shopifyId: null });

    await syncFulfillmentFromShopify(SHOP_ID, fulfillmentPayload());

    expect(fulfillmentFindFirst.mock.calls[0]![0].where.shopifyId).toBeNull();
    expect(fulfillmentCreate).not.toHaveBeenCalled();
    const { where, data } = fulfillmentUpdate.mock.calls[0]![0];
    expect(where.id).toBe("ful_legacy");
    expect(data.shopifyId).toBe("gid://shopify/Fulfillment/77700001");
  });

  it("stops claiming an order is fulfilled once its only shipment is cancelled", async () => {
    fulfillmentCount.mockResolvedValue(0);

    await syncFulfillmentFromShopify(SHOP_ID, fulfillmentPayload({ status: "cancelled" }));

    expect(orderUpdate.mock.calls[0]![0].data.fulfillmentStatus).toBe("unfulfilled");
    expect(fulfillmentCount.mock.calls[0]![0].where.status.notIn).toContain("cancelled");
  });

  it("still reports fulfilled while another shipment is active", async () => {
    fulfillmentCount.mockResolvedValue(1);

    await syncFulfillmentFromShopify(SHOP_ID, fulfillmentPayload({ status: "cancelled" }));

    expect(orderUpdate.mock.calls[0]![0].data.fulfillmentStatus).toBe("fulfilled");
  });

  it("ignores a fulfilment for an order it has never seen", async () => {
    orderFindUnique.mockResolvedValue(null);

    const result = await syncFulfillmentFromShopify(SHOP_ID, fulfillmentPayload());

    expect(result).toBeNull();
    expect(fulfillmentCreate).not.toHaveBeenCalled();
  });
});
