import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)(
  "economic ingestion, against real PostgreSQL",
  () => {
    let prisma: any;
    let syncOrderFromShopify: any;
    let syncProductFromShopify: any;
    let syncFulfillmentFromShopify: any;
    let hydrateProductWebhook: any;
    let importOrders: any;
    let shopId: string;
    const runId = Date.now();

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_URL;
      const { PrismaClient } = await import("@prisma/client");
      prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
      ({
        syncOrderFromShopify,
        syncProductFromShopify,
        syncFulfillmentFromShopify,
      } = await import("./sync.server"));
      ({ hydrateProductWebhook } = await import("./shopify-catalog.server"));
      ({ importOrders } = await import("./backfill.server"));
      const shop = await prisma.shop.create({
        data: {
          domain: `economic-ingestion-${runId}.myshopify.com`,
          name: "Economic ingestion integration",
          currency: "USD",
          timezone: "UTC",
          grantedScopes: "read_orders,read_products,read_inventory",
        },
      });
      shopId = shop.id;
    });

    afterAll(async () => {
      if (!prisma) return;
      await prisma.shop.deleteMany({ where: { id: shopId } });
      await prisma.$disconnect();
    });

    function productPayload(
      productId: number,
      variantId: number,
      unitCost: string,
      inventoryUpdatedAt: string,
      productUpdatedAt = inventoryUpdatedAt,
    ) {
      return {
        id: productId,
        title: `Product ${productId}`,
        handle: `product-${productId}`,
        status: "active",
        updated_at: productUpdatedAt,
        variants: [
          {
            id: variantId,
            title: `Variant ${variantId}`,
            sku: `SKU-${variantId}`,
            price: "50.00",
            inventory_quantity: 20,
            inventory_item_gid: `gid://shopify/InventoryItem/${variantId}`,
            inventory_item_updated_at: inventoryUpdatedAt,
            unit_cost_known: true,
            unit_cost: unitCost,
          },
        ],
      };
    }

    function orderPayload(
      orderId: number,
      variantId: number,
      updatedAt: string,
      total = "50.00",
      title = "Current line",
    ) {
      return {
        id: orderId,
        order_number: Number(String(orderId).slice(-8)),
        processed_at: updatedAt,
        created_at: updatedAt,
        updated_at: updatedAt,
        currency: "USD",
        subtotal_price: total,
        total_discounts: "0.00",
        total_tax: "0.00",
        total_price: total,
        financial_status: "paid",
        fulfillment_status: "unfulfilled",
        line_items: [
          {
            id: orderId * 10,
            variant_id: variantId,
            title,
            sku: `SKU-${variantId}`,
            quantity: 1,
            price: total,
          },
        ],
        refunds: [],
      };
    }

    it("freezes old COGS while an order after a cost edit receives the new cost", async () => {
      const productId = runId + 100;
      const variantId = runId + 101;
      await syncProductFromShopify(
        shopId,
        productPayload(productId, variantId, "12.5000", "2026-08-10T10:00:00Z"),
      );
      await syncOrderFromShopify(
        shopId,
        orderPayload(runId + 110, variantId, "2026-08-10T10:05:00Z"),
      );

      await syncProductFromShopify(
        shopId,
        productPayload(productId, variantId, "19.7500", "2026-08-10T11:00:00Z"),
      );
      await syncOrderFromShopify(
        shopId,
        orderPayload(runId + 111, variantId, "2026-08-10T11:05:00Z"),
      );

      const rows = await prisma.orderLineItem.findMany({
        where: {
          shopId,
          shopifyId: {
            in: [
              `gid://shopify/LineItem/${(runId + 110) * 10}`,
              `gid://shopify/LineItem/${(runId + 111) * 10}`,
            ],
          },
        },
        orderBy: { shopifyId: "asc" },
        select: { unitCost: true, variantId: true, productId: true },
      });
      expect(rows.map((row: any) => String(row.unitCost))).toEqual([
        "12.5",
        "19.75",
      ]);
      expect(rows.every((row: any) => row.variantId && row.productId)).toBe(
        true,
      );
    });

    it("never mixes a newer webhook header with stale children from an in-flight backfill", async () => {
      const productId = runId + 200;
      const variantId = runId + 201;
      const orderId = runId + 210;
      await syncProductFromShopify(
        shopId,
        productPayload(productId, variantId, "8.0000", "2026-08-10T12:00:00Z"),
      );

      let releasePage!: () => void;
      let markRequested!: () => void;
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releasePage = resolve;
      });
      const backfill = importOrders(
        shopId,
        {
          graphql: async () => {
            markRequested();
            await held;
            return {
              json: async () => ({
                data: {
                  orders: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: `gid://shopify/Order/${orderId}`,
                        name: `#${String(orderId).slice(-8)}`,
                        processedAt: "2026-08-10T12:01:00Z",
                        createdAt: "2026-08-10T12:01:00Z",
                        updatedAt: "2026-08-10T12:01:00Z",
                        currencyCode: "USD",
                        displayFinancialStatus: "PAID",
                        displayFulfillmentStatus: "UNFULFILLED",
                        subtotalPriceSet: { shopMoney: { amount: "40.00" } },
                        totalDiscountsSet: { shopMoney: { amount: "0.00" } },
                        totalShippingPriceSet: {
                          shopMoney: { amount: "0.00" },
                        },
                        totalTaxSet: { shopMoney: { amount: "0.00" } },
                        totalPriceSet: { shopMoney: { amount: "40.00" } },
                        totalRefundedSet: { shopMoney: { amount: "0.00" } },
                        lineItems: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            {
                              id: `gid://shopify/LineItem/${orderId * 10}`,
                              title: "Stale backfill line",
                              sku: `SKU-${variantId}`,
                              quantity: 1,
                              originalUnitPriceSet: {
                                shopMoney: { amount: "40.00" },
                              },
                              totalDiscountSet: {
                                shopMoney: { amount: "0.00" },
                              },
                              variant: {
                                id: `gid://shopify/ProductVariant/${variantId}`,
                              },
                              product: {
                                id: `gid://shopify/Product/${productId}`,
                              },
                            },
                          ],
                        },
                        refunds: [],
                      },
                    ],
                  },
                },
              }),
            } as Response;
          },
        },
        {
          orders: true,
          products: true,
          customers: false,
          inventoryCost: true,
          fulfillments: false,
        },
      );

      await requested;
      await syncOrderFromShopify(
        shopId,
        orderPayload(
          orderId,
          variantId,
          "2026-08-10T12:02:00Z",
          "55.00",
          "Newest webhook line",
        ),
      );
      releasePage();
      await backfill;

      const stored = await prisma.order.findUniqueOrThrow({
        where: {
          shopId_shopifyId: {
            shopId,
            shopifyId: `gid://shopify/Order/${orderId}`,
          },
        },
        include: { lineItems: true },
      });
      expect(String(stored.total)).toBe("55");
      expect(stored.shopifyUpdatedAt).toEqual(new Date("2026-08-10T12:02:00Z"));
      expect(stored.lineItems).toHaveLength(1);
      expect(stored.lineItems[0].title).toBe("Newest webhook line");
      expect(String(stored.lineItems[0].unitPrice)).toBe("55");
    });

    it("hydrates and sells variant 101 with links, price history and nonzero COGS", async () => {
      const productId = runId + 300;
      const baseVariantId = runId + 1_000;
      const snapshots = Array.from({ length: 101 }, (_, index) => {
        const id = baseVariantId + index;
        return {
          id: `gid://shopify/ProductVariant/${id}`,
          sku: `SKU-${id}`,
          title: `Variant ${id}`,
          price: "25.00",
          compareAtPrice: null,
          inventoryQuantity: 5,
          updatedAt: "2026-08-10T13:00:00Z",
          inventoryItem: {
            id: `gid://shopify/InventoryItem/${id}`,
            updatedAt: "2026-08-10T13:01:00Z",
            unitCost: { amount: "7.2500" },
          },
        };
      });
      const admin = {
        graphql: async (_query: string, options: any) => {
          const after = options?.variables?.cursor;
          const nodes = after ? snapshots.slice(100) : snapshots.slice(0, 100);
          return {
            json: async () => ({
              data: {
                product: {
                  id: `gid://shopify/Product/${productId}`,
                  title: "Extended product",
                  handle: "extended-product",
                  productType: "Matrix",
                  vendor: "Northwind",
                  status: "ACTIVE",
                  updatedAt: "2026-08-10T13:00:00Z",
                  variants: {
                    pageInfo: {
                      hasNextPage: !after,
                      endCursor: after ? null : "after-100",
                    },
                    nodes,
                  },
                },
              },
            }),
          } as Response;
        },
      };
      const webhook = {
        id: productId,
        title: "Extended product",
        variants: snapshots.slice(0, 100),
        variant_gids: snapshots.map((snapshot) => ({
          admin_graphql_api_id: snapshot.id,
        })),
      };
      const hydrated = await hydrateProductWebhook(admin, webhook, true);
      await syncProductFromShopify(shopId, hydrated);

      const omittedVariantId = baseVariantId + 100;
      await syncOrderFromShopify(
        shopId,
        orderPayload(
          runId + 310,
          omittedVariantId,
          "2026-08-10T13:05:00Z",
          "25.00",
        ),
      );

      const storedVariant = await prisma.variant.findUniqueOrThrow({
        where: {
          shopId_shopifyId: {
            shopId,
            shopifyId: `gid://shopify/ProductVariant/${omittedVariantId}`,
          },
        },
        include: { priceHistory: true, lineItems: true },
      });
      expect(storedVariant.priceHistory).toHaveLength(1);
      expect(storedVariant.inventoryItemShopifyId).toBe(
        `gid://shopify/InventoryItem/${omittedVariantId}`,
      );
      expect(storedVariant.lineItems).toHaveLength(1);
      expect(storedVariant.lineItems[0].productId).toBe(
        storedVariant.productId,
      );
      expect(String(storedVariant.lineItems[0].unitCost)).toBe("7.25");
    });

    it("ignores delayed pre-cancellation fulfillment deliveries and replays", async () => {
      const productId = runId + 400;
      const variantId = runId + 401;
      const orderId = runId + 410;
      const fulfillmentId = runId + 420;
      await syncProductFromShopify(
        shopId,
        productPayload(productId, variantId, "4.0000", "2026-08-10T14:00:00Z"),
      );
      await syncOrderFromShopify(
        shopId,
        orderPayload(orderId, variantId, "2026-08-10T14:01:00Z"),
      );
      const base = {
        id: fulfillmentId,
        order_id: orderId,
        created_at: "2026-08-10T14:02:00Z",
        line_items: [{ quantity: 1 }],
      };
      await syncFulfillmentFromShopify(shopId, {
        ...base,
        status: "success",
        updated_at: "2026-08-10T14:03:00Z",
      });
      const cancelled = {
        ...base,
        status: "cancelled",
        updated_at: "2026-08-10T14:05:00Z",
      };
      await syncFulfillmentFromShopify(shopId, cancelled);
      await syncFulfillmentFromShopify(shopId, cancelled);
      await syncFulfillmentFromShopify(shopId, {
        ...base,
        status: "success",
        updated_at: "2026-08-10T14:04:00Z",
      });

      const fulfillment = await prisma.fulfillment.findUniqueOrThrow({
        where: {
          shopId_shopifyId: {
            shopId,
            shopifyId: `gid://shopify/Fulfillment/${fulfillmentId}`,
          },
        },
        include: { order: true },
      });
      expect(fulfillment.status).toBe("cancelled");
      expect(fulfillment.shippedAt).toBeNull();
      expect(fulfillment.shopifyUpdatedAt).toEqual(
        new Date("2026-08-10T14:05:00Z"),
      );
      expect(fulfillment.order.fulfillmentStatus).toBe("unfulfilled");
    });
  },
);
