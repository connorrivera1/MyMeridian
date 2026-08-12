import crypto from "node:crypto";

import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end cover for the three mandatory GDPR compliance webhooks.
 *
 * Shopify's automated app review sends a POST with an invalid HMAC to each
 * compliance endpoint and fails the submission unless it receives a 401, then
 * sends validly-signed payloads and expects 2xx. These tests exercise exactly
 * that contract: real requests, real HMAC verification through
 * `authenticate.webhook`, with only Prisma mocked (the suite runs without a
 * database, as every other suite here assumes).
 */

const TEST_SECRET = "test-shopify-api-secret";
const SHOP_DOMAIN = "meridian-test.myshopify.com";

process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = TEST_SECRET;
process.env.SHOPIFY_APP_URL = "https://meridian-test.example.com";
process.env.SCOPES = "read_orders,read_products";

const shopFindUnique = vi.fn();
const shopDelete = vi.fn();
const customerFindFirst = vi.fn();
const customerDelete = vi.fn();
const orderUpdateMany = vi.fn();
const sessionDeleteMany = vi.fn();
const webhookEventCreate = vi.fn();
const webhookEventUpdate = vi.fn();
const webhookEventUpdateMany = vi.fn();
const webhookEventFindUnique = vi.fn();
const webhookEventFindMany = vi.fn();
const webhookEventDeleteMany = vi.fn();
const dataRequestUpsert = vi.fn();
const dataRequestDeleteMany = vi.fn();
const customerErasureFindFirst = vi.fn();
const customerErasureCreateMany = vi.fn();
const executeRaw = vi.fn();

const transactionClient = {
  $executeRaw: (...args: unknown[]) => executeRaw(...args),
  customerErasure: {
    findFirst: (...args: unknown[]) => customerErasureFindFirst(...args),
    createMany: (...args: unknown[]) => customerErasureCreateMany(...args),
  },
  customer: {
    findFirst: (...args: unknown[]) => customerFindFirst(...args),
    delete: (...args: unknown[]) => customerDelete(...args),
  },
  order: {
    updateMany: (...args: unknown[]) => orderUpdateMany(...args),
  },
  orderTaxComponent: {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  webhookEvent: {
    findMany: (...args: unknown[]) => webhookEventFindMany(...args),
    updateMany: (...args: unknown[]) => webhookEventUpdateMany(...args),
  },
  dataRequest: {
    upsert: (...args: unknown[]) => dataRequestUpsert(...args),
    deleteMany: (...args: unknown[]) => dataRequestDeleteMany(...args),
  },
};

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUnique: (...args: unknown[]) => shopFindUnique(...args),
      delete: (...args: unknown[]) => shopDelete(...args),
    },
    customer: {
      findFirst: (...args: unknown[]) => customerFindFirst(...args),
      delete: (...args: unknown[]) => customerDelete(...args),
    },
    order: {
      updateMany: (...args: unknown[]) => orderUpdateMany(...args),
    },
    orderTaxComponent: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    session: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: (...args: unknown[]) => sessionDeleteMany(...args),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    webhookEvent: {
      create: (...args: unknown[]) => webhookEventCreate(...args),
      update: (...args: unknown[]) => webhookEventUpdate(...args),
      updateMany: (...args: unknown[]) => webhookEventUpdateMany(...args),
      findUnique: (...args: unknown[]) => webhookEventFindUnique(...args),
      findMany: (...args: unknown[]) => webhookEventFindMany(...args),
      deleteMany: (...args: unknown[]) => webhookEventDeleteMany(...args),
    },
    dataRequest: {
      upsert: (...args: unknown[]) => dataRequestUpsert(...args),
      deleteMany: (...args: unknown[]) => dataRequestDeleteMany(...args),
    },
    $transaction: (work: unknown) =>
      typeof work === "function"
        ? (work as (tx: typeof transactionClient) => unknown)(transactionClient)
        : Promise.all(work as Promise<unknown>[]),
  },
}));

const { webhooksSettled } = await import("~/lib/webhooks.server");
const { customerErasureHashes } = await import("~/lib/customer-erasure.server");

const dataRequest = await import("./webhooks.gdpr.data-request");
const customersRedact = await import("./webhooks.gdpr.customers-redact");
const shopRedact = await import("./webhooks.gdpr.shop-redact");

function sign(body: string): string {
  return crypto
    .createHmac("sha256", TEST_SECRET)
    .update(body, "utf8")
    .digest("base64");
}

function webhookRequest(
  path: string,
  topic: string,
  payload: Record<string, unknown>,
  {
    hmac,
    webhookId = crypto.randomUUID(),
  }: { hmac?: string; webhookId?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  return new Request(`https://meridian-test.example.com${path}`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": SHOP_DOMAIN,
      "X-Shopify-Hmac-Sha256": hmac ?? sign(body),
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Webhook-Id": webhookId,
    },
  });
}

async function invoke(
  route: { action: (args: ActionFunctionArgs) => Promise<Response> },
  request: Request,
): Promise<Response> {
  try {
    // Webhook actions only read `request`; the rest of the framework args are
    // irrelevant to them.
    const response = await route.action({ request } as ActionFunctionArgs);
    // 200 goes back the moment the delivery is verified and claimed; the
    // export assembly and the deletes happen after it, because Shopify allows
    // five seconds for the whole request and this endpoint reads a shopper's
    // entire order history. Wait for that work before asserting on it.
    await webhooksSettled();
    return response;
  } catch (thrown) {
    // authenticate.webhook throws a Response on verification failure; a route
    // framework would surface it as the HTTP response, so tests do the same.
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  webhookEventCreate.mockResolvedValue({});
  webhookEventUpdate.mockResolvedValue({});
  webhookEventUpdateMany.mockResolvedValue({ count: 1 });
  webhookEventFindUnique.mockResolvedValue({
    receivedAt: new Date("2026-08-05T12:00:00.000Z"),
  });
  webhookEventFindMany.mockResolvedValue([]);
  webhookEventDeleteMany.mockResolvedValue({ count: 0 });
  shopFindUnique.mockResolvedValue({ id: "shop_1", domain: SHOP_DOMAIN });
  customerFindFirst.mockResolvedValue(null);
  customerDelete.mockResolvedValue({});
  orderUpdateMany.mockResolvedValue({ count: 0 });
  sessionDeleteMany.mockResolvedValue({ count: 0 });
  shopDelete.mockResolvedValue({});
  dataRequestUpsert.mockResolvedValue({ id: "dr_1" });
  dataRequestDeleteMany.mockResolvedValue({ count: 0 });
  customerErasureFindFirst.mockResolvedValue(null);
  customerErasureCreateMany.mockResolvedValue({ count: 2 });
  executeRaw.mockResolvedValue(0);
});

describe("HMAC verification", () => {
  const cases = [
    [
      "customers/data_request",
      "/webhooks/gdpr/customers-data-request",
      dataRequest,
    ],
    ["customers/redact", "/webhooks/gdpr/customers-redact", customersRedact],
    ["shop/redact", "/webhooks/gdpr/shop-redact", shopRedact],
  ] as const;

  for (const [topic, path, route] of cases) {
    it(`${topic}: rejects an invalid HMAC with 401 and touches nothing`, async () => {
      const response = await invoke(
        route,
        webhookRequest(
          path,
          topic,
          { shop_domain: SHOP_DOMAIN },
          { hmac: sign("tampered") },
        ),
      );
      expect(response.status).toBe(401);
      expect(webhookEventCreate).not.toHaveBeenCalled();
      expect(shopDelete).not.toHaveBeenCalled();
      expect(customerDelete).not.toHaveBeenCalled();
    });

    // Shopify's review bot signs its probe with a wrong secret (401, above),
    // but the requirement is written as "return 401 for an unverified request"
    // and an unsigned probe is unverified. The library answers those 400, which
    // is a rejection but not the documented one, so the app answers first.
    it(`${topic}: rejects a missing HMAC header with 401`, async () => {
      const body = JSON.stringify({ shop_domain: SHOP_DOMAIN });
      const request = new Request(`https://meridian-test.example.com${path}`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": topic,
          "X-Shopify-Shop-Domain": SHOP_DOMAIN,
        },
      });
      const response = await invoke(route, request);
      expect(response.status).toBe(401);
      expect(webhookEventCreate).not.toHaveBeenCalled();
      expect(shopDelete).not.toHaveBeenCalled();
    });

    it(`${topic}: refuses GET with 405`, () => {
      const response = (route as { loader: () => Response }).loader();
      expect(response.status).toBe(405);
    });
  }
});

describe("customers/data_request", () => {
  it("returns 200 for a valid signature even when no data is held", async () => {
    const response = await invoke(
      dataRequest,
      webhookRequest(
        "/webhooks/gdpr/customers-data-request",
        "customers/data_request",
        { shop_domain: SHOP_DOMAIN, customer: { id: 5551234 } },
      ),
    );
    expect(response.status).toBe(200);
    expect(customerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { shopifyId: "gid://shopify/Customer/5551234" },
            { shopifyId: "5551234" },
          ],
        }),
      }),
    );
  });

  // The whole point of the topic. Before this the report was assembled, logged
  // and discarded, so a merchant who was told in Settings that they could
  // collect it had nothing to collect and no way to know.
  it("stores the assembled export for the merchant to collect", async () => {
    customerFindFirst.mockResolvedValue({
      id: "cust_9",
      shopifyId: "gid://shopify/Customer/5551234",
      email: "shopper@example.com",
      firstOrderAt: new Date("2026-02-01T00:00:00.000Z"),
      ordersCount: 1,
      lifetimeRevenue: "121.00",
      acquisitionChannel: "GOOGLE",
      orders: [
        {
          shopifyId: "gid://shopify/Order/1001",
          orderNumber: 1001,
          processedAt: new Date("2026-02-01T00:00:00.000Z"),
          total: "121.00",
          lineItems: [
            { title: "Merino Base Layer", quantity: 1, unitPrice: "84.00" },
          ],
          fulfillments: [],
        },
      ],
    });

    const response = await invoke(
      dataRequest,
      webhookRequest(
        "/webhooks/gdpr/customers-data-request",
        "customers/data_request",
        { shop_domain: SHOP_DOMAIN, customer: { id: 5551234 } },
      ),
    );

    expect(response.status).toBe(200);
    expect(dataRequestUpsert).toHaveBeenCalledTimes(1);

    const stored = dataRequestUpsert.mock.calls[0]![0] as {
      create: {
        shopId: string;
        shopifyCustomerId: string;
        customerEmail: string;
        ordersIncluded: number;
        report: { orders: { orderNumber: number }[] };
      };
    };
    expect(stored.create.shopId).toBe("shop_1");
    expect(stored.create.shopifyCustomerId).toBe(
      "gid://shopify/Customer/5551234",
    );
    expect(stored.create.customerEmail).toBe("shopper@example.com");
    expect(stored.create.ordersIncluded).toBe(1);
    expect(stored.create.report.orders[0]!.orderNumber).toBe(1001);
    expect(stored.create).toEqual(
      expect.objectContaining({
        requestedAt: new Date("2026-08-05T12:00:00.000Z"),
        expiresAt: new Date("2026-09-05T12:00:00.000Z"),
      }),
    );
  });

  // "We hold nothing on this person" is the answer to the request, and the
  // merchant has to be able to give it.
  it("stores an empty export when no data is held", async () => {
    await invoke(
      dataRequest,
      webhookRequest(
        "/webhooks/gdpr/customers-data-request",
        "customers/data_request",
        { shop_domain: SHOP_DOMAIN, customer: { id: 404404 } },
      ),
    );

    const stored = dataRequestUpsert.mock.calls[0]![0] as {
      create: {
        shopifyCustomerId: string;
        ordersIncluded: number;
        report: { note?: string };
      };
    };
    expect(stored.create.shopifyCustomerId).toBe("404404");
    expect(stored.create.ordersIncluded).toBe(0);
    expect(stored.create.report.note).toMatch(/no data held/i);
  });

  it("keeps the export out of the application log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    customerFindFirst.mockResolvedValue({
      id: "cust_9",
      shopifyId: "gid://shopify/Customer/5551234",
      email: "shopper@example.com",
      firstOrderAt: null,
      ordersCount: 0,
      lifetimeRevenue: "0",
      acquisitionChannel: "DIRECT",
      orders: [],
    });

    await invoke(
      dataRequest,
      webhookRequest(
        "/webhooks/gdpr/customers-data-request",
        "customers/data_request",
        { shop_domain: SHOP_DOMAIN, customer: { id: 5551234 } },
      ),
    );

    const logged = info.mock.calls.flat().join(" ");
    expect(logged).not.toContain("shopper@example.com");
    info.mockRestore();
  });

  it("answers a post-erasure request without retaining the supplied id or email", async () => {
    customerErasureFindFirst.mockResolvedValue({ id: "erased_1" });

    await invoke(
      dataRequest,
      webhookRequest(
        "/webhooks/gdpr/customers-data-request",
        "customers/data_request",
        {
          shop_domain: SHOP_DOMAIN,
          customer: { id: 5551234, email: "erased@example.com" },
        },
      ),
    );

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
    expect(JSON.stringify(stored)).not.toMatch(/5551234|erased@example\.com/);
  });
});

describe("customers/redact", () => {
  it("uses a dedicated stable key independent of connector-token rotation", () => {
    const previousErasureKey = process.env.MERIDIAN_CUSTOMER_ERASURE_KEY;
    const previousEncryptionKey = process.env.MERIDIAN_ENCRYPTION_KEY;
    try {
      process.env.MERIDIAN_CUSTOMER_ERASURE_KEY = Buffer.alloc(32, 11).toString(
        "base64",
      );
      process.env.MERIDIAN_ENCRYPTION_KEY = Buffer.alloc(32, 22).toString(
        "base64",
      );
      const beforeRotation = customerErasureHashes("shop_1", { id: 5551234 });

      process.env.MERIDIAN_ENCRYPTION_KEY = Buffer.alloc(32, 33).toString(
        "base64",
      );
      expect(customerErasureHashes("shop_1", { id: 5551234 })).toEqual(
        beforeRotation,
      );

      process.env.MERIDIAN_CUSTOMER_ERASURE_KEY = Buffer.alloc(32, 44).toString(
        "base64",
      );
      expect(customerErasureHashes("shop_1", { id: 5551234 })).not.toEqual(
        beforeRotation,
      );
    } finally {
      if (previousErasureKey === undefined) {
        delete process.env.MERIDIAN_CUSTOMER_ERASURE_KEY;
      } else {
        process.env.MERIDIAN_CUSTOMER_ERASURE_KEY = previousErasureKey;
      }
      if (previousEncryptionKey === undefined) {
        delete process.env.MERIDIAN_ENCRYPTION_KEY;
      } else {
        process.env.MERIDIAN_ENCRYPTION_KEY = previousEncryptionKey;
      }
    }
  });

  it("requires the dedicated erasure key in production and rejects a short key", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousErasureKey = process.env.MERIDIAN_CUSTOMER_ERASURE_KEY;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.MERIDIAN_CUSTOMER_ERASURE_KEY;
      expect(() => customerErasureHashes("shop_1", { id: 5551234 })).toThrow(
        /MERIDIAN_CUSTOMER_ERASURE_KEY is required/,
      );

      process.env.MERIDIAN_CUSTOMER_ERASURE_KEY =
        Buffer.alloc(31).toString("base64");
      expect(() => customerErasureHashes("shop_1", { id: 5551234 })).toThrow(
        /must decode to 32 bytes/,
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousErasureKey === undefined) {
        delete process.env.MERIDIAN_CUSTOMER_ERASURE_KEY;
      } else {
        process.env.MERIDIAN_CUSTOMER_ERASURE_KEY = previousErasureKey;
      }
    }
  });

  it("tombstones identity and scrubs every matching recovery payload", async () => {
    customerFindFirst.mockResolvedValue({ id: "cust_9" });
    webhookEventFindMany.mockResolvedValue([
      {
        id: "event_current",
        webhookId: "redact-current",
        topic: "CUSTOMERS_REDACT",
        payload: {
          customer: { id: 5551234, email: "shopper@example.com" },
        },
      },
      {
        id: "event_order",
        webhookId: "order-pending",
        topic: "ORDERS_UPDATED",
        payload: {
          id: 1001,
          total_price: "121.00",
          landing_site:
            "/products/base?utm_campaign=private&email=shopper%40example.com",
          referring_site: "https://personal.example/customer/5551234",
          customer: { id: 5551234, email: "shopper@example.com" },
        },
      },
      {
        id: "event_access",
        webhookId: "access-pending",
        topic: "CUSTOMERS_DATA_REQUEST",
        payload: {
          customer: { id: 5551234, email: "shopper@example.com" },
        },
      },
    ]);

    await invoke(
      customersRedact,
      webhookRequest(
        "/webhooks/gdpr/customers-redact",
        "customers/redact",
        {
          shop_domain: SHOP_DOMAIN,
          customer: { id: 5551234, email: "shopper@example.com" },
        },
        { webhookId: "redact-current" },
      ),
    );

    const tombstones = customerErasureCreateMany.mock.calls[0]![0].data as {
      identifierHash: string;
    }[];
    expect(tombstones).toHaveLength(2);
    expect(
      tombstones.every((row) => /^[a-f0-9]{64}$/.test(row.identifierHash)),
    ).toBe(true);
    expect(JSON.stringify(tombstones)).not.toMatch(
      /5551234|shopper@example\.com/,
    );

    expect(webhookEventUpdateMany).toHaveBeenCalledWith({
      where: { id: "event_current", processedAt: null },
      data: { payload: { customer: { id: 5551234 } } },
    });
    expect(webhookEventUpdateMany).toHaveBeenCalledWith({
      where: { id: "event_order", processedAt: null },
      data: { payload: { id: 1001, total_price: "121.00" } },
    });
    expect(webhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "event_access", processedAt: null },
        data: expect.objectContaining({
          processedAt: expect.any(Date),
          payloadExpiresAt: null,
          leaseToken: null,
        }),
      }),
    );
  });

  it("anonymises orders and deletes the customer row", async () => {
    customerFindFirst.mockResolvedValue({ id: "cust_9" });

    const response = await invoke(
      customersRedact,
      webhookRequest("/webhooks/gdpr/customers-redact", "customers/redact", {
        shop_domain: SHOP_DOMAIN,
        customer: { id: 5551234 },
      }),
    );

    expect(response.status).toBe(200);
    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: { shopId: "shop_1", customerId: "cust_9" },
      data: {
        customerId: null,
        isFirstOrder: false,
        campaignId: null,
        campaignName: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        landingSite: null,
        taxCountryCode: null,
        taxRegionCode: null,
      },
    });
    expect(customerDelete).toHaveBeenCalledWith({ where: { id: "cust_9" } });
  });

  // A held export is a full copy of the orders and email that erasure is about
  // to remove. Leaving it behind erases nothing.
  it("deletes any export still held for that customer", async () => {
    customerFindFirst.mockResolvedValue({ id: "cust_9" });
    dataRequestDeleteMany.mockResolvedValue({ count: 1 });

    await invoke(
      customersRedact,
      webhookRequest("/webhooks/gdpr/customers-redact", "customers/redact", {
        shop_domain: SHOP_DOMAIN,
        customer: { id: 5551234 },
      }),
    );

    expect(dataRequestDeleteMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        OR: [
          { shopifyCustomerId: "5551234" },
          { shopifyCustomerId: "gid://shopify/Customer/5551234" },
        ],
      },
    });
  });

  // Redaction can arrive after the customer row is already gone — a retried
  // delivery, or a shopper Meridian never stored. The export is still there.
  it("deletes held exports even when the customer row has gone", async () => {
    customerFindFirst.mockResolvedValue(null);
    dataRequestDeleteMany.mockResolvedValue({ count: 1 });

    const response = await invoke(
      customersRedact,
      webhookRequest("/webhooks/gdpr/customers-redact", "customers/redact", {
        shop_domain: SHOP_DOMAIN,
        customer: { id: 5551234 },
      }),
    );

    expect(response.status).toBe(200);
    expect(dataRequestDeleteMany).toHaveBeenCalledTimes(1);
    expect(customerDelete).not.toHaveBeenCalled();
  });

  it("still returns 200 when the customer is unknown", async () => {
    const response = await invoke(
      customersRedact,
      webhookRequest("/webhooks/gdpr/customers-redact", "customers/redact", {
        shop_domain: SHOP_DOMAIN,
        customer: { id: 404404 },
      }),
    );
    expect(response.status).toBe(200);
    expect(customerDelete).not.toHaveBeenCalled();
  });
});

describe("malformed mandatory customer deliveries", () => {
  it.each([
    [
      "customers/data_request",
      "/webhooks/gdpr/customers-data-request",
      dataRequest,
    ],
    ["customers/redact", "/webhooks/gdpr/customers-redact", customersRedact],
  ] as const)(
    "%s remains failed and recoverable when customer.id is missing",
    async (topic, path, route) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const response = await invoke(
        route,
        webhookRequest(path, topic, {
          shop_domain: SHOP_DOMAIN,
          customer: { email: "unresolved@example.com" },
        }),
      );

      expect(response.status).toBe(200);
      expect(webhookEventCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: { customer: { email: "unresolved@example.com" } },
        }),
      });
      const failed = webhookEventUpdateMany.mock.calls
        .map(([call]) => call)
        .find(
          (call) =>
            call?.data?.error === "Operation failed (Error).",
        );
      expect(failed).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            error: "Operation failed (Error).",
            availableAt: expect.any(Date),
            leaseToken: null,
            leaseExpiresAt: null,
          }),
        }),
      );
      const failedData = (failed as { data: Record<string, unknown> }).data;
      expect(failedData).not.toHaveProperty("payload");
      expect(failedData).not.toHaveProperty("processedAt");
      expect(
        webhookEventUpdateMany.mock.calls.some(([call]) =>
          Object.prototype.hasOwnProperty.call(call.data, "payload"),
        ),
      ).toBe(false);
      consoleError.mockRestore();
    },
  );
});

describe("shop/redact", () => {
  it("purges sessions and cascades the shop delete", async () => {
    const response = await invoke(
      shopRedact,
      webhookRequest("/webhooks/gdpr/shop-redact", "shop/redact", {
        shop_domain: SHOP_DOMAIN,
      }),
    );

    expect(response.status).toBe(200);
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { shop: SHOP_DOMAIN },
    });
    expect(webhookEventDeleteMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP_DOMAIN },
    });
    expect(shopDelete).toHaveBeenCalledWith({ where: { id: "shop_1" } });
    expect(shopDelete.mock.invocationCallOrder[0]).toBeLessThan(
      webhookEventDeleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("retains and marks the delivery when the shop delete fails", async () => {
    const failure = new Error("shop delete timed out");
    shopDelete.mockRejectedValueOnce(failure);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const response = await invoke(
      shopRedact,
      webhookRequest("/webhooks/gdpr/shop-redact", "shop/redact", {
        shop_domain: SHOP_DOMAIN,
      }),
    );

    expect(response.status).toBe(200);
    expect(webhookEventDeleteMany).not.toHaveBeenCalled();
    expect(webhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: "Operation failed (Error).",
        }),
      }),
    );
    expect(shopDelete.mock.invocationCallOrder[0]).toBeLessThan(
      webhookEventUpdateMany.mock.invocationCallOrder[0]!,
    );
    consoleError.mockRestore();
  });

  it("erases legacy webhook events even when the shop row is already gone", async () => {
    shopFindUnique.mockResolvedValue(null);

    await invoke(
      shopRedact,
      webhookRequest("/webhooks/gdpr/shop-redact", "shop/redact", {
        shop_domain: SHOP_DOMAIN,
      }),
    );

    expect(webhookEventCreate).not.toHaveBeenCalled();
    expect(webhookEventDeleteMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP_DOMAIN },
    });
  });

  it("returns 200 when the shop was never provisioned", async () => {
    shopFindUnique.mockResolvedValue(null);
    const response = await invoke(
      shopRedact,
      webhookRequest("/webhooks/gdpr/shop-redact", "shop/redact", {
        shop_domain: SHOP_DOMAIN,
      }),
    );
    expect(response.status).toBe(200);
    expect(shopDelete).not.toHaveBeenCalled();
  });
});
