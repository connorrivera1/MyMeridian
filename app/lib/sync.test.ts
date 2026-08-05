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
const customerUpsert = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    order: {
      count: (...args: unknown[]) => orderCount(...args),
      upsert: (...args: unknown[]) => orderUpsert(...args),
    },
    customer: {
      upsert: (...args: unknown[]) => customerUpsert(...args),
    },
    orderLineItem: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    variant: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const { syncOrderFromShopify } = await import("./sync.server");

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

beforeEach(() => {
  vi.clearAllMocks();
  customerUpsert.mockResolvedValue({ id: "cust_1" });
  orderUpsert.mockImplementation(async ({ create }: any) => ({
    id: "order_1",
    ...create,
  }));
  orderCount.mockResolvedValue(0);
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
