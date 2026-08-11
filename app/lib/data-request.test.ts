import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cover for servicing `customers/data_request`.
 *
 * The defect this replaces was not a crash: the export was assembled correctly
 * and then dropped on the floor, while Settings and the privacy policy both told
 * the merchant they could collect it. So these tests are mostly about the export
 * still existing afterwards, and about it not outliving what it is for.
 */

const dataRequestUpsert = vi.fn();
const dataRequestFindMany = vi.fn();
const dataRequestFindFirst = vi.fn();
const dataRequestCount = vi.fn();
const dataRequestDeleteMany = vi.fn();
const dataRequestUpdateMany = vi.fn();
const webhookEventFindMany = vi.fn();
const customerErasureFindFirst = vi.fn();

const transactionClient = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  customerErasure: {
    findFirst: (...args: unknown[]) => customerErasureFindFirst(...args),
  },
  dataRequest: {
    upsert: (...args: unknown[]) => dataRequestUpsert(...args),
    updateMany: (...args: unknown[]) => dataRequestUpdateMany(...args),
    findFirst: (...args: unknown[]) => dataRequestFindFirst(...args),
  },
};

vi.mock("~/db.server", () => ({
  default: {
    dataRequest: {
      upsert: (...args: unknown[]) => dataRequestUpsert(...args),
      findMany: (...args: unknown[]) => dataRequestFindMany(...args),
      count: (...args: unknown[]) => dataRequestCount(...args),
      deleteMany: (...args: unknown[]) => dataRequestDeleteMany(...args),
      updateMany: (...args: unknown[]) => dataRequestUpdateMany(...args),
    },
    webhookEvent: {
      findMany: (...args: unknown[]) => webhookEventFindMany(...args),
    },
    $transaction: (run: (tx: typeof transactionClient) => unknown) =>
      run(transactionClient),
  },
}));

const {
  DATA_REQUEST_RETENTION_DAYS,
  buildCustomerExport,
  collectDataRequestForDownload,
  deleteDataRequestsForCustomer,
  findPendingWebhookPersonalData,
  listDataRequests,
  purgeExpiredDataRequests,
  recordDataRequest,
} = await import("./data-request.server");

const REQUESTED_AT = new Date("2026-08-05T12:00:00.000Z");

function customerWithOrders() {
  return {
    id: "cust_1",
    shopId: "shop_1",
    shopifyId: "gid://shopify/Customer/5551234",
    email: "shopper@example.com",
    firstOrderAt: new Date("2026-01-04T09:00:00.000Z"),
    acquisitionChannel: "GOOGLE",
    acquisitionCampaignId: null,
    ordersCount: 2,
    lifetimeRevenue: "310.50",
    lifetimeProfit: "88.10",
    orders: [
      {
        id: "order_1",
        shopId: "shop_1",
        shopifyId: "gid://shopify/Order/1001",
        shopifyUpdatedAt: new Date("2026-01-04T09:05:00.000Z"),
        orderNumber: 1001,
        processedAt: new Date("2026-01-04T09:00:00.000Z"),
        customerId: "cust_1",
        currency: "USD",
        subtotal: "100.00",
        discountTotal: "0.00",
        shippingCharged: "10.00",
        taxTotal: "11.00",
        total: "121.00",
        refundedTotal: "0.00",
        financialStatus: "paid",
        fulfillmentStatus: "fulfilled",
        channel: "GOOGLE",
        campaignId: "spring",
        campaignName: "Spring",
        utmSource: "google",
        utmMedium: "cpc",
        utmCampaign: "spring",
        landingSite: "/products/base?utm_campaign=spring",
        isFirstOrder: true,
        cogsTotal: "40.00",
        shippingCost: "8.00",
        paymentFee: "3.00",
        adCostAttributed: "12.00",
        overheadAllocated: "4.00",
        contributionProfit: "58.00",
        netProfit: "42.00",
        computedAt: new Date("2026-08-01T00:00:00.000Z"),
        lineItems: [
          {
            id: "line_1",
            shopId: "shop_1",
            orderId: "order_1",
            shopifyId: "gid://shopify/LineItem/1",
            variantId: "variant_1",
            productId: "product_1",
            title: "Merino Base Layer",
            sku: "MERINO-BASE",
            quantity: 1,
            unitPrice: "84.00",
            discount: "0.00",
            unitCost: "31.0000",
            refundedQty: 0,
          },
        ],
        fulfillments: [
          {
            id: "fulfillment_1",
            shopId: "shop_1",
            orderId: "order_1",
            shopifyId: "gid://shopify/Fulfillment/1",
            shopifyUpdatedAt: new Date("2026-01-05T09:15:00.000Z"),
            status: "success",
            createdAt: new Date("2026-01-05T09:00:00.000Z"),
            shippedAt: new Date("2026-01-05T09:00:00.000Z"),
            deliveredAt: null,
            carrier: "UPS",
            serviceLevel: "ground",
            shippingCost: "8.00",
            pickPackCost: "2.50",
            itemCount: 1,
            location: "primary",
          },
        ],
      },
      {
        id: "order_2",
        shopId: "shop_1",
        shopifyId: "gid://shopify/Order/1044",
        shopifyUpdatedAt: null,
        orderNumber: 1044,
        processedAt: new Date("2026-03-11T17:20:00.000Z"),
        customerId: "cust_1",
        currency: "USD",
        subtotal: "189.50",
        discountTotal: "0.00",
        shippingCharged: "0.00",
        taxTotal: "0.00",
        total: "189.50",
        refundedTotal: "0.00",
        financialStatus: "paid",
        fulfillmentStatus: "fulfilled",
        channel: "EMAIL",
        campaignId: null,
        campaignName: null,
        utmSource: "newsletter",
        utmMedium: "email",
        utmCampaign: null,
        landingSite: "/products/summit-pack",
        isFirstOrder: false,
        cogsTotal: "70.00",
        shippingCost: "0.00",
        paymentFee: "5.00",
        adCostAttributed: "0.00",
        overheadAllocated: "5.00",
        contributionProfit: "114.50",
        netProfit: "109.50",
        computedAt: null,
        lineItems: [
          {
            id: "line_2",
            shopId: "shop_1",
            orderId: "order_2",
            shopifyId: "gid://shopify/LineItem/2",
            variantId: "variant_2",
            productId: "product_2",
            title: "Summit Pack 32L",
            sku: "SUMMIT-32",
            quantity: 1,
            unitPrice: "189.00",
            discount: "0.00",
            unitCost: "70.0000",
            refundedQty: 0,
          },
          {
            id: "line_3",
            shopId: "shop_1",
            orderId: "order_2",
            shopifyId: "gid://shopify/LineItem/3",
            variantId: "variant_3",
            productId: "product_3",
            title: "Merino Wool Socks (3-pack)",
            sku: "SOCKS-3",
            quantity: 2,
            unitPrice: "45.00",
            discount: "0.00",
            unitCost: "12.0000",
            refundedQty: 0,
          },
        ],
        fulfillments: [],
      },
    ],
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  dataRequestUpsert.mockResolvedValue({ id: "dr_1" });
  dataRequestFindMany.mockResolvedValue([]);
  dataRequestFindFirst.mockResolvedValue(null);
  dataRequestCount.mockResolvedValue(0);
  dataRequestDeleteMany.mockResolvedValue({ count: 0 });
  dataRequestUpdateMany.mockResolvedValue({ count: 1 });
  webhookEventFindMany.mockResolvedValue([]);
  customerErasureFindFirst.mockResolvedValue(null);
});

describe("buildCustomerExport", () => {
  it("includes every order and line item held for the customer", () => {
    const report = buildCustomerExport(
      "meridian-test.myshopify.com",
      customerWithOrders(),
      REQUESTED_AT,
    );

    expect(report.customer?.email).toBe("shopper@example.com");
    expect(report.customer?.lifetimeRevenue).toBe("310.50");
    expect(report.orders.map((order) => order.orderNumber)).toEqual([
      1001, 1044,
    ]);
    expect(report.orders[1]!.lineItems).toHaveLength(2);
    expect(report.orders[1]!.lineItems[1]).toEqual(
      expect.objectContaining({
        title: "Merino Wool Socks (3-pack)",
        quantity: 2,
        unitPrice: "45.00",
      }),
    );
  });

  it("says so plainly when nothing is held, rather than returning nothing", () => {
    const report = buildCustomerExport(
      "meridian-test.myshopify.com",
      null,
      REQUESTED_AT,
    );

    expect(report.customer).toBeNull();
    expect(report.orders).toEqual([]);
    expect(report.note).toMatch(/no data held/i);
  });

  it("exports every normalized customer, order, line-item and fulfillment field", () => {
    const pending = [
      {
        topic: "ORDERS_UPDATED",
        receivedAt: "2026-08-05T11:59:00.000Z",
        payload: {
          id: 1001,
          customer: { id: 5551234, email: "shopper@example.com" },
        },
      },
    ];
    const report = buildCustomerExport(
      "meridian-test.myshopify.com",
      customerWithOrders(),
      REQUESTED_AT,
      pending,
    );

    expect(Object.keys(report.customer!).sort()).toEqual(
      [
        "id",
        "shopId",
        "shopifyId",
        "email",
        "firstOrderAt",
        "acquisitionChannel",
        "acquisitionCampaignId",
        "ordersCount",
        "lifetimeRevenue",
        "lifetimeProfit",
      ].sort(),
    );
    expect(Object.keys(report.orders[0]!).sort()).toEqual(
      [
        "id",
        "shopId",
        "shopifyId",
        "shopifyUpdatedAt",
        "orderNumber",
        "processedAt",
        "customerId",
        "currency",
        "subtotal",
        "discountTotal",
        "shippingCharged",
        "taxTotal",
        "total",
        "refundedTotal",
        "financialStatus",
        "fulfillmentStatus",
        "channel",
        "campaignId",
        "campaignName",
        "utmSource",
        "utmMedium",
        "utmCampaign",
        "landingSite",
        "isFirstOrder",
        "cogsTotal",
        "shippingCost",
        "paymentFee",
        "adCostAttributed",
        "overheadAllocated",
        "contributionProfit",
        "netProfit",
        "computedAt",
        "lineItems",
        "fulfillments",
      ].sort(),
    );
    expect(Object.keys(report.orders[0]!.lineItems[0]!).sort()).toEqual(
      [
        "id",
        "shopId",
        "orderId",
        "shopifyId",
        "variantId",
        "productId",
        "title",
        "sku",
        "quantity",
        "unitPrice",
        "discount",
        "unitCost",
        "refundedQty",
      ].sort(),
    );
    expect(Object.keys(report.orders[0]!.fulfillments[0]!).sort()).toEqual(
      [
        "id",
        "shopId",
        "orderId",
        "shopifyId",
        "shopifyUpdatedAt",
        "status",
        "createdAt",
        "shippedAt",
        "deliveredAt",
        "carrier",
        "serviceLevel",
        "shippingCost",
        "pickPackCost",
        "itemCount",
        "location",
      ].sort(),
    );
    expect(report.pendingWebhookData).toEqual(pending);
  });
});

describe("findPendingWebhookPersonalData", () => {
  it("includes only minimized pending payloads that name the shopper", async () => {
    webhookEventFindMany.mockResolvedValue([
      {
        topic: "ORDERS_UPDATED",
        receivedAt: new Date("2026-08-05T11:00:00.000Z"),
        payload: {
          id: 1001,
          customer: { id: 5551234, email: "shopper@example.com" },
        },
      },
      {
        topic: "ORDERS_UPDATED",
        receivedAt: new Date("2026-08-05T11:01:00.000Z"),
        payload: { id: 1002, customer: { id: 999 } },
      },
      {
        topic: "FULFILLMENTS_UPDATE",
        receivedAt: new Date("2026-08-05T11:02:00.000Z"),
        payload: { id: 77, order_id: 1001, tracking_company: "UPS" },
      },
      {
        topic: "FULFILLMENTS_UPDATE",
        receivedAt: new Date("2026-08-05T11:03:00.000Z"),
        payload: { id: 78, order_id: 9999, tracking_company: "FedEx" },
      },
    ]);

    const found = await findPendingWebhookPersonalData(
      "shop_1",
      { id: "gid://shopify/Customer/5551234" },
      ["gid://shopify/Order/1001"],
    );

    expect(found).toEqual([
      {
        topic: "ORDERS_UPDATED",
        receivedAt: "2026-08-05T11:00:00.000Z",
        payload: {
          id: 1001,
          customer: { id: 5551234, email: "shopper@example.com" },
        },
      },
      {
        topic: "FULFILLMENTS_UPDATE",
        receivedAt: "2026-08-05T11:02:00.000Z",
        payload: { id: 77, order_id: 1001, tracking_company: "UPS" },
      },
    ]);
  });
});

describe("recordDataRequest", () => {
  it("stores the export against the delivery id with an expiry", async () => {
    const report = buildCustomerExport(
      "meridian-test.myshopify.com",
      customerWithOrders(),
      REQUESTED_AT,
    );

    await recordDataRequest({
      shopId: "shop_1",
      webhookId: "delivery-1",
      shopifyCustomerId: "gid://shopify/Customer/5551234",
      customerEmail: "shopper@example.com",
      report,
      requestedAt: REQUESTED_AT,
    });

    expect(dataRequestUpsert).toHaveBeenCalledTimes(1);
    const call = dataRequestUpsert.mock.calls[0]![0] as {
      where: { webhookId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };

    expect(call.where).toEqual({ webhookId: "delivery-1" });
    expect(call.create.ordersIncluded).toBe(2);
    expect(call.create.report).toBe(report);
    expect(call.create.expiresAt).toEqual(
      new Date(
        REQUESTED_AT.getTime() + DATA_REQUEST_RETENTION_DAYS * 86_400_000,
      ),
    );
    // A retried delivery must land on the same row, not beside it.
    expect(call.update.report).toBe(report);
    expect(call.update).not.toHaveProperty("webhookId");
    expect(call.update).not.toHaveProperty("requestedAt");
    expect(call.update).not.toHaveProperty("expiresAt");
  });

  it("cannot extend the retention clock when Shopify retries the delivery", async () => {
    const firstRequestedAt = new Date("2026-08-05T12:00:00.000Z");
    const retryAttemptedAt = new Date("2026-08-12T12:00:00.000Z");
    const stored: Record<string, unknown> = {};
    dataRequestUpsert.mockImplementation(
      async ({ create, update }: { create: object; update: object }) => {
        if (Object.keys(stored).length === 0) Object.assign(stored, create);
        else Object.assign(stored, update);
        return stored;
      },
    );
    const report = buildCustomerExport(
      "meridian-test.myshopify.com",
      customerWithOrders(),
      firstRequestedAt,
    );

    await recordDataRequest({
      shopId: "shop_1",
      webhookId: "delivery-retention-retry",
      shopifyCustomerId: "gid://shopify/Customer/5551234",
      customerEmail: "shopper@example.com",
      report,
      requestedAt: firstRequestedAt,
    });
    await recordDataRequest({
      shopId: "shop_1",
      webhookId: "delivery-retention-retry",
      shopifyCustomerId: "gid://shopify/Customer/5551234",
      customerEmail: "shopper@example.com",
      report: { ...report, requestedAt: retryAttemptedAt.toISOString() },
      requestedAt: retryAttemptedAt,
    });

    expect(stored.requestedAt).toEqual(firstRequestedAt);
    expect(stored.expiresAt).toEqual(
      new Date(
        firstRequestedAt.getTime() + DATA_REQUEST_RETENTION_DAYS * 86_400_000,
      ),
    );
  });

  it("records only a de-identified empty response after customer erasure won the race", async () => {
    customerErasureFindFirst.mockResolvedValue({ id: "erased_1" });
    const report = buildCustomerExport(
      "meridian-test.myshopify.com",
      customerWithOrders(),
      REQUESTED_AT,
    );

    await recordDataRequest({
      shopId: "shop_1",
      webhookId: "delivery-after-redact",
      shopifyCustomerId: "gid://shopify/Customer/5551234",
      customerEmail: "shopper@example.com",
      report,
      requestedAt: REQUESTED_AT,
    });

    const stored = dataRequestUpsert.mock.calls[0]![0];
    expect(stored.create).toEqual(
      expect.objectContaining({
        shopifyCustomerId: "redacted-request",
        customerEmail: null,
        ordersIncluded: 0,
        report: expect.objectContaining({
          customer: null,
          orders: [],
          pendingWebhookData: [],
        }),
      }),
    );
    expect(JSON.stringify(stored)).not.toMatch(
      /5551234|shopper@example\.com|Merino Base Layer/,
    );
  });
});

describe("retention", () => {
  it("deletes exports whose retention has run out, collected or not", async () => {
    dataRequestDeleteMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-09-20T00:00:00.000Z");

    expect(await purgeExpiredDataRequests(now)).toBe(3);
    expect(dataRequestDeleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
    });
  });

  it("purges before listing, so nothing expired is offered for collection", async () => {
    const order: string[] = [];
    dataRequestDeleteMany.mockImplementation(async () => {
      order.push("purge");
      return { count: 1 };
    });
    dataRequestFindMany.mockImplementation(async () => {
      order.push("list");
      return [];
    });

    await listDataRequests("shop_1", {
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(order[0]).toBe("purge");
  });
});

describe("listDataRequests", () => {
  it("returns every active obligation and paginates metadata-only history", async () => {
    const summary = (id: string, collectedAt: Date | null) => ({
      id,
      shopifyCustomerId: `customer-${id}`,
      customerEmail: `${id}@example.com`,
      requestedAt: REQUESTED_AT,
      ordersIncluded: 2,
      collectedAt,
      expiresAt: new Date("2026-09-05T12:00:00.000Z"),
      // A database row has this field, but the explicit query projection must
      // prevent it crossing the list boundary.
      report: { private: id },
    });
    const outstanding = Array.from({ length: 31 }, (_, index) =>
      summary(`outstanding-${index}`, null),
    );
    const history = Array.from({ length: 5 }, (_, index) =>
      summary(`history-${index}`, new Date()),
    );
    dataRequestCount.mockResolvedValue(30);
    dataRequestFindMany.mockImplementation(
      async ({ where }: { where: { collectedAt: unknown } }) =>
        where.collectedAt === null ? outstanding : history,
    );

    const result = await listDataRequests("shop_1", { historyPage: 2 });

    expect(result.outstanding).toHaveLength(31);
    expect(result.history).toHaveLength(5);
    expect(result.historyPage).toBe(2);
    expect(result.historyPageCount).toBe(2);
    const [outstandingCall, historyCall] = dataRequestFindMany.mock.calls.map(
      ([call]) => call,
    );
    expect(outstandingCall).toEqual(
      expect.objectContaining({
        where: { shopId: "shop_1", collectedAt: null },
        orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
        select: expect.not.objectContaining({ report: expect.anything() }),
      }),
    );
    expect(outstandingCall).not.toHaveProperty("take");
    expect(historyCall).toEqual(
      expect.objectContaining({
        skip: 25,
        take: 25,
        select: expect.not.objectContaining({ report: expect.anything() }),
      }),
    );
  });
});

describe("collectDataRequestForDownload", () => {
  it("returns an active shop-scoped report and stamps first collection in one transaction", async () => {
    const now = new Date("2026-08-06T10:00:00.000Z");
    const row = {
      report: { shop: "meridian-test.myshopify.com", orders: [] },
      requestedAt: REQUESTED_AT,
    };
    dataRequestFindFirst.mockResolvedValue(row);

    await expect(
      collectDataRequestForDownload("shop_1", "dr_2", now),
    ).resolves.toEqual(row);
    expect(dataRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "dr_2",
        shopId: "shop_1",
        collectedAt: null,
        expiresAt: { gt: now },
      },
      data: { collectedAt: now },
    });
    expect(dataRequestFindFirst).toHaveBeenCalledWith({
      where: { id: "dr_2", shopId: "shop_1", expiresAt: { gt: now } },
      select: { report: true, requestedAt: true },
    });
  });

  it("returns null when the shop-scoped active row does not exist", async () => {
    dataRequestUpdateMany.mockResolvedValue({ count: 0 });
    dataRequestFindFirst.mockResolvedValue(null);
    await expect(
      collectDataRequestForDownload("shop_1", "dr_elsewhere"),
    ).resolves.toBeNull();
  });
});

describe("deleteDataRequestsForCustomer", () => {
  it("matches both the raw id and the gid form Shopify uses", async () => {
    dataRequestDeleteMany.mockResolvedValue({ count: 2 });

    expect(await deleteDataRequestsForCustomer("shop_1", 5551234)).toBe(2);
    expect(dataRequestDeleteMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        shopifyCustomerId: {
          in: ["5551234", "gid://shopify/Customer/5551234"],
        },
      },
    });
  });
});
