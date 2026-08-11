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
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
  },
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

const {
  processInventoryItemsWebhook,
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
});

describe("economic webhook processors", () => {
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
