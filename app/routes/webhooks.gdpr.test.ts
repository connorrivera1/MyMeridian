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
const dataRequestUpsert = vi.fn();
const dataRequestDeleteMany = vi.fn();

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
    },
    dataRequest: {
      upsert: (...args: unknown[]) => dataRequestUpsert(...args),
      deleteMany: (...args: unknown[]) => dataRequestDeleteMany(...args),
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

const dataRequest = await import("./webhooks.gdpr.data-request");
const customersRedact = await import("./webhooks.gdpr.customers-redact");
const shopRedact = await import("./webhooks.gdpr.shop-redact");

function sign(body: string): string {
  return crypto.createHmac("sha256", TEST_SECRET).update(body, "utf8").digest("base64");
}

function webhookRequest(
  path: string,
  topic: string,
  payload: Record<string, unknown>,
  { hmac }: { hmac?: string } = {},
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
      "X-Shopify-Webhook-Id": crypto.randomUUID(),
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
    return await route.action({ request } as ActionFunctionArgs);
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
  shopFindUnique.mockResolvedValue({ id: "shop_1", domain: SHOP_DOMAIN });
  customerFindFirst.mockResolvedValue(null);
  customerDelete.mockResolvedValue({});
  orderUpdateMany.mockResolvedValue({ count: 0 });
  sessionDeleteMany.mockResolvedValue({ count: 0 });
  shopDelete.mockResolvedValue({});
  dataRequestUpsert.mockResolvedValue({ id: "dr_1" });
  dataRequestDeleteMany.mockResolvedValue({ count: 0 });
});

describe("HMAC verification", () => {
  const cases = [
    ["customers/data_request", "/webhooks/gdpr/customers-data-request", dataRequest],
    ["customers/redact", "/webhooks/gdpr/customers-redact", customersRedact],
    ["shop/redact", "/webhooks/gdpr/shop-redact", shopRedact],
  ] as const;

  for (const [topic, path, route] of cases) {
    it(`${topic}: rejects an invalid HMAC with 401 and touches nothing`, async () => {
      const response = await invoke(
        route,
        webhookRequest(path, topic, { shop_domain: SHOP_DOMAIN }, { hmac: sign("tampered") }),
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
          orderNumber: 1001,
          processedAt: new Date("2026-02-01T00:00:00.000Z"),
          total: "121.00",
          lineItems: [{ title: "Merino Base Layer", quantity: 1, unitPrice: "84.00" }],
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
    expect(stored.create.shopifyCustomerId).toBe("gid://shopify/Customer/5551234");
    expect(stored.create.customerEmail).toBe("shopper@example.com");
    expect(stored.create.ordersIncluded).toBe(1);
    expect(stored.create.report.orders[0]!.orderNumber).toBe(1001);
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
      create: { shopifyCustomerId: string; ordersIncluded: number; report: { note?: string } };
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
});

describe("customers/redact", () => {
  it("anonymises orders and deletes the customer row", async () => {
    customerFindFirst.mockResolvedValue({ id: "cust_9" });

    const response = await invoke(
      customersRedact,
      webhookRequest(
        "/webhooks/gdpr/customers-redact",
        "customers/redact",
        { shop_domain: SHOP_DOMAIN, customer: { id: 5551234 } },
      ),
    );

    expect(response.status).toBe(200);
    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: { customerId: "cust_9" },
      data: { customerId: null },
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
      webhookRequest(
        "/webhooks/gdpr/customers-redact",
        "customers/redact",
        { shop_domain: SHOP_DOMAIN, customer: { id: 5551234 } },
      ),
    );

    expect(dataRequestDeleteMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        shopifyCustomerId: {
          in: ["5551234", "gid://shopify/Customer/5551234"],
        },
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
      webhookRequest(
        "/webhooks/gdpr/customers-redact",
        "customers/redact",
        { shop_domain: SHOP_DOMAIN, customer: { id: 5551234 } },
      ),
    );

    expect(response.status).toBe(200);
    expect(dataRequestDeleteMany).toHaveBeenCalledTimes(1);
    expect(customerDelete).not.toHaveBeenCalled();
  });

  it("still returns 200 when the customer is unknown", async () => {
    const response = await invoke(
      customersRedact,
      webhookRequest(
        "/webhooks/gdpr/customers-redact",
        "customers/redact",
        { shop_domain: SHOP_DOMAIN, customer: { id: 404404 } },
      ),
    );
    expect(response.status).toBe(200);
    expect(customerDelete).not.toHaveBeenCalled();
  });
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
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { shop: SHOP_DOMAIN } });
    expect(shopDelete).toHaveBeenCalledWith({ where: { id: "shop_1" } });
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
