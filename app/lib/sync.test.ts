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
const orderFindFirst = vi.fn();
const orderUpdate = vi.fn();
const orderUpdateMany = vi.fn();
const customerUpsert = vi.fn();
const customerUpdate = vi.fn();
const customerErasureFindFirst = vi.fn();
const lineItemDeleteMany = vi.fn();
const lineItemCreateMany = vi.fn();
const orderTaxComponentDeleteMany = vi.fn();
const orderTaxComponentCreateMany = vi.fn();
let orderRows: any[] = [];
let customerRows: any[] = [];
const fulfillmentFindUnique = vi.fn();
const fulfillmentFindFirst = vi.fn();
const fulfillmentCreate = vi.fn();
const fulfillmentUpdate = vi.fn();
const fulfillmentCount = vi.fn();
let fulfillmentRows: any[] = [];

vi.mock("~/db.server", () => {
  /*
   * `withOrderLock` wraps the line-item rewrite in a transaction that takes a
   * Postgres advisory lock. A mock has neither isolation nor contention, so the
   * callback receives this same client and the lock statement is a no-op —
   * which keeps these tests asserting what they were written to assert: the
   * queries the sync issues.
   *
   * The serialisation itself is therefore NOT covered here, and cannot be
   * without a real database. See order-lock.server.ts.
   */
  const client: Record<string, unknown> = {
    order: {
      count: (...args: unknown[]) => orderCount(...args),
      upsert: (...args: unknown[]) => orderUpsert(...args),
      findUnique: (...args: unknown[]) => orderFindUnique(...args),
      findFirst: (...args: unknown[]) => orderFindFirst(...args),
      update: (...args: unknown[]) => orderUpdate(...args),
      updateMany: (...args: unknown[]) => orderUpdateMany(...args),
    },
    customer: {
      upsert: (...args: unknown[]) => customerUpsert(...args),
      update: (...args: unknown[]) => customerUpdate(...args),
    },
    customerErasure: {
      findFirst: (...args: unknown[]) => customerErasureFindFirst(...args),
    },
    orderLineItem: {
      deleteMany: (...args: unknown[]) => lineItemDeleteMany(...args),
      createMany: (...args: unknown[]) => lineItemCreateMany(...args),
    },
    orderTaxComponent: {
      deleteMany: (...args: unknown[]) => orderTaxComponentDeleteMany(...args),
      createMany: (...args: unknown[]) => orderTaxComponentCreateMany(...args),
    },
    fulfillment: {
      findUnique: (...args: unknown[]) => fulfillmentFindUnique(...args),
      findFirst: (...args: unknown[]) => fulfillmentFindFirst(...args),
      create: (...args: unknown[]) => fulfillmentCreate(...args),
      update: (...args: unknown[]) => fulfillmentUpdate(...args),
      count: (...args: unknown[]) => fulfillmentCount(...args),
    },
    variant: { findMany: vi.fn().mockResolvedValue([]) },
  };

  client.$transaction = (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(client)
      : Promise.all(arg as unknown[]);
  client.$executeRaw = vi.fn(async () => 0);

  return { default: client };
});

const { deriveChannel, syncOrderFromShopify, syncFulfillmentFromShopify } =
  await import("./sync.server");

describe("Shop Campaigns order attribution", () => {
  it("requires an explicit paid Shop Campaign UTM and leaves other channels alone", () => {
    expect(
      deriveChannel({
        utmSource: "shop_campaign",
        utmMedium: "cpc",
        utmCampaign: "autumn",
      }).channel,
    ).toBe("SHOP_CAMPAIGNS");
    expect(
      deriveChannel({
        utmSource: "shop",
        utmMedium: "organic",
        utmCampaign: "catalog",
      }).channel,
    ).toBe("DIRECT");
    expect(
      deriveChannel({
        utmSource: "facebook",
        utmMedium: "cpc",
        utmCampaign: "shop_campaign",
      }).channel,
    ).toBe("FACEBOOK");
  });
});

const SHOP_ID = "shop_1";
const PROCESSED_AT = "2026-07-01T10:00:00Z";
const EARLIER = "2026-06-01T10:00:00Z";

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 99900001,
    order_number: 1001,
    processed_at: PROCESSED_AT,
    created_at: PROCESSED_AT,
    updated_at: "2026-07-01T10:05:00Z",
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
    updated_at: "2026-07-02T09:05:00Z",
    status: "success",
    tracking_company: "UPS",
    service: "ground",
    location_id: 4001,
    line_items: [{ quantity: 2 }],
    ...overrides,
  };
}

/** Sorts a fake table the way Prisma's `orderBy` array would. */
function byOrderBy(orderBy: any) {
  const keys: Record<string, "asc" | "desc">[] = Array.isArray(orderBy)
    ? orderBy
    : [orderBy];
  return (a: any, b: any) => {
    for (const key of keys) {
      const [field, direction] = Object.entries(key)[0]!;
      const left = a[field] instanceof Date ? a[field].getTime() : a[field];
      const right = b[field] instanceof Date ? b[field].getTime() : b[field];
      if (left < right) return direction === "desc" ? 1 : -1;
      if (left > right) return direction === "desc" ? -1 : 1;
    }
    return 0;
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Order and customer are fake tables rather than fixed answers. The defect
  // this file covers is that the first-order decision depends on which rows
  // already exist — a mock that answers the same thing regardless of what has
  // been written cannot see it, and would pass against the bug.
  orderRows = [];
  customerRows = [];
  customerErasureFindFirst.mockResolvedValue(null);
  lineItemDeleteMany.mockResolvedValue({ count: 0 });
  lineItemCreateMany.mockResolvedValue({ count: 0 });
  orderTaxComponentDeleteMany.mockResolvedValue({ count: 0 });
  orderTaxComponentCreateMany.mockResolvedValue({ count: 0 });

  customerUpsert.mockImplementation(async ({ where, create, update }: any) => {
    const key = where.shopId_shopifyId;
    const existing = customerRows.find(
      (row) => row.shopId === key.shopId && row.shopifyId === key.shopifyId,
    );
    if (existing) {
      for (const [field, value] of Object.entries(update ?? {})) {
        if (value !== undefined) existing[field] = value;
      }
      return existing;
    }
    const row = { id: `cust_${customerRows.length + 1}`, ...create };
    customerRows.push(row);
    return row;
  });
  customerUpdate.mockImplementation(async ({ where, data }: any) => {
    const row = customerRows.find((candidate) => candidate.id === where.id);
    if (row) return Object.assign(row, data);
    return { id: where.id, ...data };
  });

  orderUpsert.mockImplementation(async ({ where, create, update }: any) => {
    const key = where.shopId_shopifyId;
    const existing = orderRows.find(
      (row) => row.shopId === key.shopId && row.shopifyId === key.shopifyId,
    );
    if (existing) return Object.assign(existing, update);
    const row = { id: `order_${orderRows.length + 1}`, ...create };
    orderRows.push(row);
    return row;
  });
  orderCount.mockImplementation(
    async ({ where }: any) =>
      orderRows.filter(
        (row) =>
          row.shopId === where.shopId &&
          row.customerId === where.customerId &&
          (where.shopifyId?.not === undefined ||
            row.shopifyId !== where.shopifyId.not) &&
          (where.processedAt?.lt === undefined ||
            row.processedAt < where.processedAt.lt),
      ).length,
  );
  orderFindFirst.mockImplementation(async ({ where, orderBy }: any) => {
    const matched = orderRows
      .filter(
        (row) =>
          row.shopId === where.shopId && row.customerId === where.customerId,
      )
      .sort(byOrderBy(orderBy));
    return matched[0] ?? null;
  });
  orderUpdateMany.mockImplementation(async ({ where, data }: any) => {
    const matched = orderRows.filter(
      (row) =>
        row.shopId === where.shopId &&
        row.customerId === where.customerId &&
        (where.isFirstOrder === undefined ||
          row.isFirstOrder === where.isFirstOrder) &&
        (where.id?.not === undefined || row.id !== where.id.not),
    );
    for (const row of matched) Object.assign(row, data);
    return { count: matched.length };
  });

  orderFindUnique.mockResolvedValue({ id: "order_1" });
  orderUpdate.mockImplementation(async ({ where, data }: any) => {
    const row = orderRows.find((candidate) => candidate.id === where.id);
    if (row) return Object.assign(row, data);
    return { id: where.id, ...data };
  });

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
  it("imports a post-redaction delivery anonymously instead of recreating the customer", async () => {
    customerErasureFindFirst.mockResolvedValue({ id: "erased_1" });

    const order = await syncOrderFromShopify(SHOP_ID, orderPayload());

    expect(customerUpsert).not.toHaveBeenCalled();
    expect(order.customerId).toBeNull();
    expect(order.isFirstOrder).toBe(false);
  });

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

  it("is false when the customer has a genuinely earlier order", async () => {
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        id: 99900000,
        order_number: 1000,
        processed_at: EARLIER,
        created_at: EARLIER,
      }),
    );

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
    expect(orderFindFirst).not.toHaveBeenCalled();
  });

  it("demotes an order that claimed the flag before the real first arrived", async () => {
    // Webhook delivery is not ordered. A second order arriving first finds no
    // earlier order and takes the flag; the genuine first order arriving later
    // also finds nothing earlier — they differ in age, not in what each can
    // see — so both end up flagged and every new-customer count, and the CAC
    // divided by it, is wrong until someone notices.
    const second = await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({ id: 99900002, order_number: 1002 }),
    );
    expect(second.isFirstOrder).toBe(true);

    const first = await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        id: 99900001,
        order_number: 1001,
        processed_at: EARLIER,
        created_at: EARLIER,
      }),
    );

    expect(first.isFirstOrder).toBe(true);
    expect(orderRows.filter((row) => row.isFirstOrder)).toHaveLength(1);
    expect(
      orderRows.find((row) => row.shopifyId.endsWith("/99900002")).isFirstOrder,
    ).toBe(false);
  });

  it("corrects the customer's firstOrderAt when the earlier order lands second", async () => {
    // firstOrderAt is stamped when the customer row is created — the first
    // order delivered, not the first placed. The GDPR export reads it.
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({ id: 99900002, order_number: 1002 }),
    );
    expect(customerRows[0].firstOrderAt).toEqual(new Date(PROCESSED_AT));

    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        id: 99900001,
        order_number: 1001,
        processed_at: EARLIER,
        created_at: EARLIER,
      }),
    );

    expect(customerRows[0].firstOrderAt).toEqual(new Date(EARLIER));
  });

  it("repoints the acquisition channel at the genuine first order", async () => {
    // The customer row is stamped from whichever order created it, so a
    // misordered delivery credits the wrong channel — and CAC is reported per
    // channel, so the spend and the customer land in different columns.
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        id: 99900002,
        order_number: 1002,
        landing_site:
          "/?utm_source=facebook&utm_medium=cpc&utm_campaign=retarget",
      }),
    );
    expect(customerRows[0].acquisitionChannel).toBe("FACEBOOK");

    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        id: 99900001,
        order_number: 1001,
        processed_at: EARLIER,
        created_at: EARLIER,
        landing_site: "/?utm_source=google&utm_medium=cpc&utm_campaign=launch",
      }),
    );

    expect(customerRows[0].acquisitionChannel).toBe("GOOGLE");
    expect(customerRows[0].acquisitionCampaignId).toBe("launch");
  });

  it("breaks a same-instant tie on the order number, not on arrival", async () => {
    // Two orders can share a processed_at to the millisecond. Something has to
    // decide, and it must not be which webhook won the race.
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({ id: 99900002, order_number: 1002 }),
    );
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({ id: 99900001, order_number: 1001 }),
    );

    const flagged = orderRows.filter((row) => row.isFirstOrder);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].orderNumber).toBe(1001);
  });

  it("does not flip back when the later order is redelivered", async () => {
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({ id: 99900002, order_number: 1002 }),
    );
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        id: 99900001,
        order_number: 1001,
        processed_at: EARLIER,
        created_at: EARLIER,
      }),
    );

    const redelivered = await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({ id: 99900002, order_number: 1002 }),
    );

    expect(redelivered.isFirstOrder).toBe(false);
    expect(orderRows.filter((row) => row.isFirstOrder)).toHaveLength(1);
  });

  it("ignores a delayed older snapshot before touching header, customer or children", async () => {
    orderFindUnique.mockResolvedValueOnce({
      id: "order_1",
      shopId: SHOP_ID,
      shopifyId: "gid://shopify/Order/99900001",
      total: "150.00",
      refundedTotal: "20.00",
      financialStatus: "refunded",
      fulfillmentStatus: "unfulfilled",
      shopifyUpdatedAt: new Date("2026-07-01T11:00:00Z"),
    });

    const result = await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        updated_at: "2026-07-01T10:00:00Z",
        total_price: "100.00",
        financial_status: "paid",
        line_items: [{ id: 1, quantity: 1, price: "100.00" }],
      }),
    );

    expect(result.total).toBe("150.00");
    expect(orderUpsert).not.toHaveBeenCalled();
    expect(customerUpsert).not.toHaveBeenCalled();
    expect(lineItemDeleteMany).not.toHaveBeenCalled();
    expect(lineItemCreateMany).not.toHaveBeenCalled();
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
    await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload({ id: 77700001 }),
    );
    await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload({ id: 77700002 }),
    );

    expect(fulfillmentCreate).toHaveBeenCalledTimes(2);
    expect(fulfillmentUpdate).not.toHaveBeenCalled();
  });

  it("adopts a pre-migration row by timestamp rather than duplicating it", async () => {
    // Rows imported before shopifyId existed carry none. The first update to
    // one of them must claim it, not write a second row beside it.
    fulfillmentFindUnique.mockResolvedValue(null);
    fulfillmentFindFirst.mockResolvedValue({
      id: "ful_legacy",
      shopifyId: null,
    });

    await syncFulfillmentFromShopify(SHOP_ID, fulfillmentPayload());

    expect(fulfillmentFindFirst.mock.calls[0]![0].where.shopifyId).toBeNull();
    expect(fulfillmentCreate).not.toHaveBeenCalled();
    const { where, data } = fulfillmentUpdate.mock.calls[0]![0];
    expect(where.id).toBe("ful_legacy");
    expect(data.shopifyId).toBe("gid://shopify/Fulfillment/77700001");
  });

  it("stops claiming an order is fulfilled once its only shipment is cancelled", async () => {
    fulfillmentCount.mockResolvedValue(0);

    await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload({ status: "cancelled" }),
    );

    expect(orderUpdate.mock.calls[0]![0].data.fulfillmentStatus).toBe(
      "unfulfilled",
    );
    expect(fulfillmentCount.mock.calls[0]![0].where.status.notIn).toContain(
      "cancelled",
    );
  });

  it("still reports fulfilled while another shipment is active", async () => {
    fulfillmentCount.mockResolvedValue(1);

    await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload({ status: "cancelled" }),
    );

    expect(orderUpdate.mock.calls[0]![0].data.fulfillmentStatus).toBe(
      "fulfilled",
    );
  });

  it("ignores a fulfilment for an order it has never seen", async () => {
    orderFindUnique.mockResolvedValue(null);

    const result = await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload(),
    );

    expect(result).toBeNull();
    expect(fulfillmentCreate).not.toHaveBeenCalled();
  });

  it("does not let a delayed pre-cancellation delivery resurrect shipment state", async () => {
    await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload({ updated_at: "2026-07-02T09:05:00Z" }),
    );
    fulfillmentCount.mockResolvedValue(0);
    await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload({
        status: "cancelled",
        updated_at: "2026-07-02T10:00:00Z",
      }),
    );

    orderUpdate.mockClear();
    await syncFulfillmentFromShopify(
      SHOP_ID,
      fulfillmentPayload({
        status: "success",
        updated_at: "2026-07-02T09:30:00Z",
      }),
    );

    expect(fulfillmentRows[0].status).toBe("cancelled");
    expect(fulfillmentRows[0].shippedAt).toBeNull();
    expect(orderUpdate).not.toHaveBeenCalled();
  });
});

describe("syncOrderFromShopify — multi-currency provenance", () => {
  it("stores the presentment pair and converts refunds at the implied rate", async () => {
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        total_price: "113.00",
        presentment_currency: "EUR",
        total_price_set: {
          shop_money: { amount: "113.00", currency_code: "USD" },
          presentment_money: { amount: "100.00", currency_code: "EUR" },
        },
        refunds: [
          {
            transactions: [
              {
                kind: "refund",
                status: "success",
                amount: "50.00",
                currency: "EUR",
              },
            ],
          },
        ],
      }),
    );

    const data = orderUpsert.mock.calls[0]![0].create;
    expect(data.presentmentCurrency).toBe("EUR");
    expect(data.presentmentTotal).toBe("100.00");
    // $113.00 settled from €100.00.
    expect(data.presentmentExchangeRate).toBe("1.1300000000");
    // €50.00 × 1.13 = $56.50, not $50.00.
    expect(data.refundedTotal).toBe("56.50");
  });

  it("stores no presentment provenance for a single-currency order", async () => {
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        total_price_set: {
          shop_money: { amount: "100.00", currency_code: "USD" },
          presentment_money: { amount: "100.00", currency_code: "USD" },
        },
      }),
    );

    const data = orderUpsert.mock.calls[0]![0].create;
    expect(data.presentmentCurrency).toBeNull();
    expect(data.presentmentTotal).toBeNull();
    expect(data.presentmentExchangeRate).toBeNull();
  });

  it("writes derived return fees onto the order", async () => {
    await syncOrderFromShopify(
      SHOP_ID,
      orderPayload({
        refunds: [
          {
            transactions: [
              { kind: "refund", status: "success", amount: "90.00" },
            ],
            refund_line_items: [
              {
                line_item_id: 1,
                quantity: 1,
                subtotal_set: { shop_money: { amount: "100.00" } },
                total_tax_set: { shop_money: { amount: "0.00" } },
              },
            ],
          },
        ],
      }),
    );

    const data = orderUpsert.mock.calls[0]![0].create;
    expect(data.refundedTotal).toBe("90.00");
    expect(data.returnFeesRetained).toBe("10.00");
  });
});
