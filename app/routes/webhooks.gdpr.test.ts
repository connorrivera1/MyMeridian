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
