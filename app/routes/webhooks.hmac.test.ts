import crypto from "node:crypto";

import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HMAC enforcement on the six webhooks that are *not* compliance topics.
 *
 * `webhooks.gdpr.test.ts` proves the three mandatory compliance endpoints
 * answer 401 to an unverified request, because that is the check Shopify's
 * automated review runs. Nothing proved it for the other six, and those are
 * the ones that write the merchant's numbers: an unverified `orders/create`
 * that reached `syncOrderFromShopify` would book revenue from a payload
 * anybody on the internet can POST, and an unverified `app/uninstalled` would
 * delete a live store's sessions.
 *
 * Every one of them goes through `handleWebhook`, so in principle they are
 * covered by construction — but "in principle" is exactly what a route that
 * quietly stops calling it would still satisfy. These drive the real route
 * modules against real HMAC verification, with only the database and the sync
 * layer mocked, and assert on the side effects rather than on the status code
 * alone: a 401 that had already written a row would be a passing test and a
 * breach.
 */

const TEST_SECRET = "test-shopify-api-secret";
const SHOP_DOMAIN = "meridian-test.myshopify.com";

process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = TEST_SECRET;
process.env.SHOPIFY_APP_URL = "https://meridian-test.example.com";
process.env.SCOPES = "read_orders,read_products";

const shopFindUnique = vi.fn();
const shopUpdate = vi.fn();
const shopUpdateMany = vi.fn();
const sessionDeleteMany = vi.fn();
const subscriptionUpsert = vi.fn();
const webhookEventCreate = vi.fn();
const webhookEventUpdate = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUnique: (...args: unknown[]) => shopFindUnique(...args),
      update: (...args: unknown[]) => shopUpdate(...args),
      updateMany: (...args: unknown[]) => shopUpdateMany(...args),
    },
    session: {
      deleteMany: (...args: unknown[]) => sessionDeleteMany(...args),
      // `PrismaSessionStorage` polls for its table on first use, so a client
      // that cannot answer these never gets as far as verifying anything.
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    subscription: { upsert: (...args: unknown[]) => subscriptionUpsert(...args) },
    webhookEvent: {
      create: (...args: unknown[]) => webhookEventCreate(...args),
      update: (...args: unknown[]) => webhookEventUpdate(...args),
    },
  },
}));

const syncOrderFromShopify = vi.fn(async (..._args: unknown[]) => undefined);
const syncProductFromShopify = vi.fn(async (..._args: unknown[]) => undefined);
const syncFulfillmentFromShopify = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("~/lib/sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sync.server")>()),
  syncOrderFromShopify: (...args: unknown[]) => syncOrderFromShopify(...args),
  syncProductFromShopify: (...args: unknown[]) => syncProductFromShopify(...args),
  syncFulfillmentFromShopify: (...args: unknown[]) => syncFulfillmentFromShopify(...args),
}));

const backfillVariantCosts = vi.fn(async (..._args: unknown[]) => 0);
vi.mock("~/lib/variant-cost.server", () => ({
  backfillVariantCosts: (...args: unknown[]) => backfillVariantCosts(...args),
}));

vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
  loadStrategicProductIds: vi.fn(),
}));

const { webhooksSettled } = await import("~/lib/webhooks.server");

const orders = await import("./webhooks.orders");
const products = await import("./webhooks.products");
const fulfillments = await import("./webhooks.fulfillments");
const uninstalled = await import("./webhooks.app-uninstalled");
const subscriptions = await import("./webhooks.app-subscriptions");
const scopesUpdate = await import("./webhooks.app-scopes-update");

interface WebhookRoute {
  action: (args: ActionFunctionArgs) => Promise<Response>;
  loader: () => Response;
}

/**
 * Each endpoint with a payload it would act on, and the writes it must not
 * perform for a request it has not verified.
 */
const ENDPOINTS: {
  topic: string;
  path: string;
  route: WebhookRoute;
  payload: Record<string, unknown>;
  /** Spies that stay untouched unless the payload was trusted. */
  writes: () => ReturnType<typeof vi.fn>[];
}[] = [
  {
    topic: "orders/create",
    path: "/webhooks/orders",
    route: orders as unknown as WebhookRoute,
    payload: {
      id: 5550001,
      name: "#1042",
      total_price: "121.00",
      line_items: [],
    },
    writes: () => [syncOrderFromShopify],
  },
  {
    topic: "products/update",
    path: "/webhooks/products",
    route: products as unknown as WebhookRoute,
    payload: { id: 7770001, title: "Alpine Shell Jacket", variants: [] },
    writes: () => [syncProductFromShopify, backfillVariantCosts],
  },
  {
    topic: "fulfillments/create",
    path: "/webhooks/fulfillments",
    route: fulfillments as unknown as WebhookRoute,
    payload: { id: 8880001, order_id: 5550001, status: "success" },
    writes: () => [syncFulfillmentFromShopify],
  },
  {
    topic: "app/uninstalled",
    path: "/webhooks/app-uninstalled",
    route: uninstalled as unknown as WebhookRoute,
    payload: { domain: SHOP_DOMAIN },
    writes: () => [sessionDeleteMany, shopUpdateMany],
  },
  {
    topic: "app_subscriptions/update",
    path: "/webhooks/app-subscriptions",
    route: subscriptions as unknown as WebhookRoute,
    payload: {
      app_subscription: {
        admin_graphql_api_id: "gid://shopify/AppSubscription/1",
        name: "Growth",
        status: "ACTIVE",
      },
    },
    writes: () => [subscriptionUpsert],
  },
  {
    topic: "app/scopes_update",
    path: "/webhooks/app-scopes-update",
    route: scopesUpdate as unknown as WebhookRoute,
    payload: { current: ["read_orders", "read_products", "read_inventory"] },
    writes: () => [shopUpdate],
  },
];

function sign(body: string): string {
  return crypto.createHmac("sha256", TEST_SECRET).update(body, "utf8").digest("base64");
}

function webhookRequest(
  path: string,
  topic: string,
  payload: Record<string, unknown>,
  { hmac, webhookId }: { hmac?: string | null; webhookId?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": SHOP_DOMAIN,
    "X-Shopify-API-Version": "2026-07",
    "X-Shopify-Webhook-Id": webhookId ?? crypto.randomUUID(),
  };
  // `null` means send no signature at all, which is a different rejection path
  // from a signature that is present and wrong.
  if (hmac !== null) headers["X-Shopify-Hmac-Sha256"] = hmac ?? sign(body);

  return new Request(`https://meridian-test.example.com${path}`, {
    method: "POST",
    body,
    headers,
  });
}

async function invoke(route: WebhookRoute, request: Request): Promise<Response> {
  try {
    const response = await route.action({ request } as ActionFunctionArgs);
    // The route answers Shopify as soon as the delivery is verified and
    // claimed, and does the work afterwards — five seconds is the whole
    // request budget. So the response arriving proves nothing about the side
    // effects yet, and every assertion below would race it. Settling here
    // keeps the tests asserting on the same thing they always did.
    await webhooksSettled();
    return response;
  } catch (thrown) {
    // Verification failure throws a Response; the framework turns that into
    // the HTTP response, so the test does the same.
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  webhookEventCreate.mockResolvedValue({});
  webhookEventUpdate.mockResolvedValue({});
  shopFindUnique.mockResolvedValue({
    id: "shop_1",
    domain: SHOP_DOMAIN,
    grantedScopes: "read_orders,read_products",
  });
  shopUpdate.mockResolvedValue({});
  shopUpdateMany.mockResolvedValue({ count: 1 });
  sessionDeleteMany.mockResolvedValue({ count: 1 });
  subscriptionUpsert.mockResolvedValue({});
  backfillVariantCosts.mockResolvedValue(0);
  syncOrderFromShopify.mockResolvedValue(undefined);
  syncProductFromShopify.mockResolvedValue(undefined);
  syncFulfillmentFromShopify.mockResolvedValue(undefined);
});

describe.each(ENDPOINTS)("$topic", ({ topic, path, route, payload, writes }) => {
  it("rejects a forged signature with 401 and writes nothing", async () => {
    const response = await invoke(
      route,
      // Signed with the right secret over the wrong bytes — the shape of a
      // tampered payload, and what Shopify's review probe amounts to.
      webhookRequest(path, topic, payload, { hmac: sign("{}") }),
    );

    expect(response.status).toBe(401);
    // The delivery-id row is the first write on the path. If it exists, the
    // request was trusted far enough to touch the database.
    expect(webhookEventCreate).not.toHaveBeenCalled();
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("rejects a signature from the wrong secret with 401", async () => {
    const body = JSON.stringify(payload);
    const forged = crypto
      .createHmac("sha256", "not-the-app-secret")
      .update(body, "utf8")
      .digest("base64");

    const response = await invoke(route, webhookRequest(path, topic, payload, { hmac: forged }));

    expect(response.status).toBe(401);
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401 rather than 400", async () => {
    // The library answers an unsigned request 400. Requirement 4.1 is written
    // as 401 for an unverified request, and an unsigned one is unverified, so
    // `receiveWebhook` answers before the library gets to it.
    const response = await invoke(route, webhookRequest(path, topic, payload, { hmac: null }));

    expect(response.status).toBe(401);
    expect(webhookEventCreate).not.toHaveBeenCalled();
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it("rejects an empty signature with 401", async () => {
    const response = await invoke(route, webhookRequest(path, topic, payload, { hmac: "" }));

    expect(response.status).toBe(401);
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  // The positive control. Without it every assertion above would still pass on
  // a route that rejected *everything*, including Shopify.
  it("accepts a correctly signed delivery and acts on it", async () => {
    const response = await invoke(route, webhookRequest(path, topic, payload));

    expect(response.status).toBe(200);
    expect(webhookEventCreate).toHaveBeenCalledTimes(1);
    for (const write of writes()) expect(write).toHaveBeenCalled();
  });

  it("refuses GET with 405", () => {
    expect(route.loader().status).toBe(405);
  });
});

describe("verified delivery handling", () => {
  const ordersEndpoint = ENDPOINTS[0]!;

  it("suppresses a replayed delivery instead of booking it twice", async () => {
    // Shopify retries anything that does not answer 2xx within five seconds,
    // and the retry carries the same body and the same delivery id. The claim
    // is a unique insert; a second one violates it.
    webhookEventCreate.mockRejectedValueOnce(new Error("Unique constraint failed"));

    const response = await invoke(
      ordersEndpoint.route,
      webhookRequest(ordersEndpoint.path, ordersEndpoint.topic, ordersEndpoint.payload, {
        webhookId: "delivery-repeated",
      }),
    );

    expect(response.status).toBe(200);
    expect(syncOrderFromShopify).not.toHaveBeenCalled();
  });

  // The reason the handler moved off the response path at all. Shopify allows
  // five seconds for the entire request and deletes the subscription after
  // eight consecutive failures, so a slow handler used to be able to cost the
  // app every future delivery of that topic. Calls `action` directly rather
  // than through `invoke`, which settles the deferred work on purpose.
  it("answers Shopify before the handler has finished", async () => {
    let release = () => {};
    syncOrderFromShopify.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );

    const response = await ordersEndpoint.route.action({
      request: webhookRequest(
        ordersEndpoint.path,
        ordersEndpoint.topic,
        ordersEndpoint.payload,
      ),
    } as ActionFunctionArgs);

    expect(response.status).toBe(200);
    // Started — the work is deferred past the response, not past the event
    // loop, so it is already running when Shopify gets its answer.
    expect(syncOrderFromShopify).toHaveBeenCalledTimes(1);
    // ...but demonstrably not finished: the event row is only stamped when the
    // handler returns, and it has not returned.
    expect(webhookEventUpdate).not.toHaveBeenCalled();

    release();
    await webhooksSettled();
    expect(webhookEventUpdate).toHaveBeenCalledTimes(1);
  });

  it("still answers 200 when the handler throws", async () => {
    // A 500 makes Shopify retry with the same payload and eventually disable
    // the subscription outright, which loses every future delivery rather than
    // one. The failure is recorded on the event row instead.
    syncOrderFromShopify.mockRejectedValueOnce(new Error("database is down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await invoke(
      ordersEndpoint.route,
      webhookRequest(ordersEndpoint.path, ordersEndpoint.topic, ordersEndpoint.payload),
    );

    expect(response.status).toBe(200);
    expect(webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: "database is down" }),
      }),
    );
    consoleError.mockRestore();
  });

  it("does not treat refunds/create as an order", async () => {
    // A bare Refund has no order fields. Passing it to syncOrderFromShopify
    // built a phantom order keyed on the refund's id, which the engine then
    // charged shipping, payment fees and a share of overhead against no
    // revenue. The refund's real effect arrives on orders/updated.
    const response = await invoke(
      ordersEndpoint.route,
      webhookRequest(ordersEndpoint.path, "refunds/create", {
        id: 9990001,
        order_id: 5550001,
        refund_line_items: [{ quantity: 1, line_item_id: 1 }],
      }),
    );

    expect(response.status).toBe(200);
    expect(syncOrderFromShopify).not.toHaveBeenCalled();
  });
});
