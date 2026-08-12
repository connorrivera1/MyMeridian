import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shopFindUnique: vi.fn(),
  adminClientForShop: vi.fn(),
  hydrateOrderVariantProducts: vi.fn(),
  hydrateProductWebhook: vi.fn(),
  hydrateInventoryItemProducts: vi.fn(),
  syncOrderFromShopify: vi.fn(),
  syncProductFromShopify: vi.fn(),
  syncFulfillmentFromShopify: vi.fn(),
  invalidateAnalyticsCache: vi.fn(),
  recordOrderUsage: vi.fn(),
  billSoftOrderOverage: vi.fn(),
  reconcileConnectedCarriersForShop: vi.fn(),
  shopUpdate: vi.fn(),
  synchroniseShopifyShippingConnector: vi.fn(),
  requestBackfill: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique, update: mocks.shopUpdate },
  },
}));

vi.mock("~/lib/provision.server", () => ({
  synchroniseShopifyShippingConnector:
    mocks.synchroniseShopifyShippingConnector,
}));

vi.mock("~/lib/backfill-queue.server", () => ({
  requestBackfill: mocks.requestBackfill,
}));

vi.mock("~/lib/shopify-catalog.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
  hydrateOrderVariantProducts: mocks.hydrateOrderVariantProducts,
  hydrateProductWebhook: mocks.hydrateProductWebhook,
  hydrateInventoryItemProducts: mocks.hydrateInventoryItemProducts,
}));

vi.mock("~/lib/sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sync.server")>()),
  syncOrderFromShopify: mocks.syncOrderFromShopify,
  syncProductFromShopify: mocks.syncProductFromShopify,
  syncFulfillmentFromShopify: mocks.syncFulfillmentFromShopify,
}));

vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: mocks.invalidateAnalyticsCache,
}));

vi.mock("~/integrations/shipping.server", () => ({
  reconcileConnectedCarriersForShop: mocks.reconcileConnectedCarriersForShop,
}));

vi.mock("~/lib/usage-meter.server", () => ({
  recordOrderUsage: vi.fn().mockResolvedValue({
    counted: true,
    meterId: "meter_1",
    used: 1,
    status: "under_limit",
    crossedSoftLimit: false,
  }),
  billSoftOrderOverage: vi.fn().mockResolvedValue({
    billedUnits: 0,
    skipped: true,
  }),
}));

vi.mock("~/lib/usage-meter.server", () => ({
  recordOrderUsage: mocks.recordOrderUsage,
  billSoftOrderOverage: mocks.billSoftOrderOverage,
}));

const {
  processInventoryItemsWebhook,
  processAppScopesUpdateWebhook,
  processFulfillmentsWebhook,
  processOrdersWebhook,
  processProductsWebhook,
} = await import("./webhook-processors.server");

const context = (topic: string, payload: Record<string, unknown>) => ({
  shopDomain: "economic-processors.myshopify.com",
  topic,
  webhookId: `delivery-${topic}`,
  payload,
  isReplay: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    domain: "economic-processors.myshopify.com",
    grantedScopes: "read_orders,read_products,read_inventory",
    isDemo: false,
  });
  mocks.adminClientForShop.mockResolvedValue({ graphql: vi.fn() });
  mocks.hydrateOrderVariantProducts.mockResolvedValue([]);
  mocks.hydrateProductWebhook.mockImplementation(
    async (_admin, payload) => payload,
  );
  mocks.hydrateInventoryItemProducts.mockResolvedValue([]);
  mocks.syncOrderFromShopify.mockResolvedValue(undefined);
  mocks.syncProductFromShopify.mockResolvedValue(undefined);
  mocks.syncFulfillmentFromShopify.mockResolvedValue(undefined);
  mocks.reconcileConnectedCarriersForShop.mockResolvedValue(2);
  mocks.recordOrderUsage.mockResolvedValue({
    meterId: "meter_1",
    status: "under_limit",
    crossedSoftLimit: false,
  });
  mocks.billSoftOrderOverage.mockResolvedValue({
    billedUnits: 0,
    skipped: true,
  });
  mocks.shopUpdate.mockResolvedValue({});
  mocks.synchroniseShopifyShippingConnector.mockResolvedValue({});
  mocks.requestBackfill.mockResolvedValue({ started: true, resumed: false });
});

describe("economic webhook processors", () => {
  it("starts a lifetime-history import when read_all_orders is newly granted", async () => {
    mocks.shopFindUnique.mockResolvedValueOnce({
      id: "shop_1",
      domain: "economic-processors.myshopify.com",
      grantedScopes: "read_orders,read_products",
    });
    await processAppScopesUpdateWebhook(
      context("APP_SCOPES_UPDATE", {
        current: ["read_orders", "read_products", "read_all_orders"],
      }),
    );

    expect(mocks.shopUpdate).toHaveBeenCalledWith({
      where: { id: "shop_1" },
      data: expect.objectContaining({
        grantedScopes: "read_orders,read_products,read_all_orders",
        syncStatus: "PENDING",
        hasAllOrdersScope: false,
      }),
    });
    expect(mocks.requestBackfill).toHaveBeenCalledWith("shop_1");
  });

  it("uses a Shopify fulfillment signal to reconcile connected carriers immediately", async () => {
    const payload = { id: 9001, order_id: 1001, status: "success" };
    await processFulfillmentsWebhook(context("FULFILLMENTS_UPDATE", payload));

    expect(mocks.syncFulfillmentFromShopify).toHaveBeenCalledWith(
      "shop_1",
      payload,
    );
    expect(mocks.reconcileConnectedCarriersForShop).toHaveBeenCalledWith(
      "shop_1",
    );
    expect(
      mocks.syncFulfillmentFromShopify.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.reconcileConnectedCarriersForShop.mock.invocationCallOrder[0]!,
    );
  });

  it("commits every referenced variant hydration before the order snapshot", async () => {
    const hydratedProducts = [
      { id: "gid://shopify/Product/1", variants: [{ id: "v1" }] },
      { id: "gid://shopify/Product/2", variants: [{ id: "v2" }] },
    ];
    mocks.hydrateOrderVariantProducts.mockResolvedValue(hydratedProducts);
    const payload = {
      id: 101,
      line_items: [{ variant_id: 11 }, { variant_id: 22 }],
    };

    await processOrdersWebhook(context("ORDERS_UPDATED", payload));

    expect(mocks.hydrateOrderVariantProducts).toHaveBeenCalledWith(
      expect.anything(),
      ["11", "22"],
      true,
    );
    expect(mocks.syncProductFromShopify).toHaveBeenNthCalledWith(
      1,
      "shop_1",
      hydratedProducts[0],
    );
    expect(mocks.syncProductFromShopify).toHaveBeenNthCalledWith(
      2,
      "shop_1",
      hydratedProducts[1],
    );
    expect(
      mocks.syncProductFromShopify.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(mocks.syncOrderFromShopify.mock.invocationCallOrder[0]!);
  });

  it("keeps flushing batched soft overage while orders continue arriving", async () => {
    mocks.recordOrderUsage.mockResolvedValue({
      meterId: "meter_1",
      status: "soft_overage",
      crossedSoftLimit: false,
    });

    await processOrdersWebhook(
      context("ORDERS_CREATE", { id: 1100, line_items: [] }),
    );

    expect(mocks.billSoftOrderOverage).toHaveBeenCalledWith(
      "economic-processors.myshopify.com",
      "meter_1",
    );
  });

  it("propagates hydration failure without freezing an unlinked zero-cost line", async () => {
    const failure = new Error("Shopify GraphQL: throttled");
    mocks.hydrateOrderVariantProducts.mockRejectedValueOnce(failure);

    await expect(
      processOrdersWebhook(
        context("ORDERS_CREATE", {
          id: 101,
          line_items: [{ variant_id: 11 }],
        }),
      ),
    ).rejects.toBe(failure);
    expect(mocks.syncOrderFromShopify).not.toHaveBeenCalled();
    expect(mocks.invalidateAnalyticsCache).not.toHaveBeenCalled();
  });

  it("replaces the truncated product payload with the complete GraphQL snapshot", async () => {
    const complete = {
      id: "gid://shopify/Product/1",
      variants: Array.from({ length: 101 }, (_, index) => ({ id: index + 1 })),
    };
    mocks.hydrateProductWebhook.mockResolvedValueOnce(complete);

    await processProductsWebhook(
      context("PRODUCTS_UPDATE", { id: 1, variants: [{ id: 1 }] }),
    );

    expect(mocks.syncProductFromShopify).toHaveBeenCalledWith(
      "shop_1",
      complete,
    );
  });

  it("resolves an inventory edit and publishes its refreshed cost snapshot", async () => {
    const refreshed = {
      id: "gid://shopify/Product/1",
      variants: [{ id: "v1", unit_cost: "21.50" }],
    };
    mocks.hydrateInventoryItemProducts.mockResolvedValueOnce([refreshed]);

    await processInventoryItemsWebhook(
      context("INVENTORY_ITEMS_UPDATE", {
        id: 91,
        cost: "21.50",
        updated_at: "2026-08-10T12:00:00Z",
      }),
    );

    expect(mocks.hydrateInventoryItemProducts).toHaveBeenCalledWith(
      expect.anything(),
      "91",
      true,
    );
    expect(mocks.syncProductFromShopify).toHaveBeenCalledWith(
      "shop_1",
      refreshed,
    );
  });
});
