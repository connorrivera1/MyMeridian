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
const dataRequestDeleteMany = vi.fn();
const dataRequestUpdateMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    dataRequest: {
      upsert: (...args: unknown[]) => dataRequestUpsert(...args),
      findMany: (...args: unknown[]) => dataRequestFindMany(...args),
      deleteMany: (...args: unknown[]) => dataRequestDeleteMany(...args),
      updateMany: (...args: unknown[]) => dataRequestUpdateMany(...args),
    },
  },
}));

const {
  DATA_REQUEST_RETENTION_DAYS,
  buildCustomerExport,
  deleteDataRequestsForCustomer,
  listDataRequests,
  markDataRequestCollected,
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
        orderNumber: 1001,
        processedAt: new Date("2026-01-04T09:00:00.000Z"),
        total: "121.00",
        lineItems: [{ title: "Merino Base Layer", quantity: 1, unitPrice: "84.00" }],
      },
      {
        orderNumber: 1044,
        processedAt: new Date("2026-03-11T17:20:00.000Z"),
        total: "189.50",
        lineItems: [
          { title: "Summit Pack 32L", quantity: 1, unitPrice: "189.00" },
          { title: "Merino Wool Socks (3-pack)", quantity: 2, unitPrice: "45.00" },
        ],
      },
    ],
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  dataRequestUpsert.mockResolvedValue({ id: "dr_1" });
  dataRequestFindMany.mockResolvedValue([]);
  dataRequestDeleteMany.mockResolvedValue({ count: 0 });
  dataRequestUpdateMany.mockResolvedValue({ count: 1 });
});

describe("buildCustomerExport", () => {
  it("includes every order and line item held for the customer", () => {
    const report = buildCustomerExport(
      "meridian-test.myshopify.com",
      customerWithOrders(),
      REQUESTED_AT,
    );

    expect(report.customer?.email).toBe("shopper@example.com");
    expect(report.customer?.lifetimeRevenue).toBe(310.5);
    expect(report.orders.map((order) => order.orderNumber)).toEqual([1001, 1044]);
    expect(report.orders[1]!.items).toHaveLength(2);
    expect(report.orders[1]!.items[1]).toEqual({
      title: "Merino Wool Socks (3-pack)",
      quantity: 2,
      unitPrice: 45,
    });
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
      new Date(REQUESTED_AT.getTime() + DATA_REQUEST_RETENTION_DAYS * 86_400_000),
    );
    // A retried delivery must land on the same row, not beside it.
    expect(call.update.report).toBe(report);
    expect(call.update).not.toHaveProperty("webhookId");
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

    await listDataRequests("shop_1", new Date("2026-08-06T00:00:00.000Z"));

    expect(order).toEqual(["purge", "list"]);
  });
});

describe("listDataRequests", () => {
  it("returns the shop's requests newest first, with the export attached", async () => {
    dataRequestFindMany.mockResolvedValue([
      {
        id: "dr_2",
        shopifyCustomerId: "5551234",
        customerEmail: "shopper@example.com",
        requestedAt: REQUESTED_AT,
        ordersIncluded: 2,
        collectedAt: null,
        expiresAt: new Date("2026-09-05T12:00:00.000Z"),
        report: { shop: "meridian-test.myshopify.com", orders: [] },
      },
    ]);

    const rows = await listDataRequests("shop_1");

    expect(dataRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop_1" },
        orderBy: { requestedAt: "desc" },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.report).toEqual({
      shop: "meridian-test.myshopify.com",
      orders: [],
    });
  });
});

describe("markDataRequestCollected", () => {
  it("stamps only an uncollected export, and only within this shop", async () => {
    const now = new Date("2026-08-06T10:00:00.000Z");

    expect(await markDataRequestCollected("shop_1", "dr_2", now)).toBe(true);
    expect(dataRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: "dr_2", shopId: "shop_1", collectedAt: null },
      data: { collectedAt: now },
    });
  });

  it("reports false when nothing matched", async () => {
    dataRequestUpdateMany.mockResolvedValue({ count: 0 });
    expect(await markDataRequestCollected("shop_1", "dr_elsewhere")).toBe(false);
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
