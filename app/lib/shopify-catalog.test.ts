import { describe, expect, it, vi } from "vitest";

import {
  hydrateInventoryItemProducts,
  hydrateOrderVariantProducts,
  hydrateProductWebhook,
} from "./shopify-catalog.server";

const ok = (data: unknown) =>
  ({ json: async () => ({ data }) }) as unknown as Response;

const product = (id = "gid://shopify/Product/1") => ({
  id,
  title: "Alpine Shell",
  handle: "alpine-shell",
  productType: "Outerwear",
  vendor: "Northwind",
  status: "ACTIVE",
  updatedAt: "2026-08-10T12:00:00Z",
});

function variant(id: number, parent = product()) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    sku: `SKU-${id}`,
    title: `Variant ${id}`,
    price: `${id}.00`,
    compareAtPrice: null,
    inventoryQuantity: id,
    updatedAt: "2026-08-10T12:00:00Z",
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${id}`,
      updatedAt: "2026-08-10T12:01:00Z",
      unitCost: { amount: `${id / 2}` },
    },
    product: parent,
  };
}

describe("Shopify catalog hydration", () => {
  it("walks every product-variant page and carries cost plus inventory identity", async () => {
    const first = Array.from({ length: 100 }, (_, index) => variant(index + 1));
    const last = variant(101);
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          product: {
            ...product(),
            variants: {
              pageInfo: { hasNextPage: true, endCursor: "after-100" },
              nodes: first,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        ok({
          product: {
            ...product(),
            variants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [last],
            },
          },
        }),
      );

    const hydrated = await hydrateProductWebhook(
      { graphql },
      {
        id: 1,
        variants: first,
        variant_gids: Array.from({ length: 101 }, (_, index) => ({
          admin_graphql_api_id: `gid://shopify/ProductVariant/${index + 1}`,
        })),
      },
      true,
    );

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1]![1]?.variables).toMatchObject({
      cursor: "after-100",
    });
    expect(hydrated.variants).toHaveLength(101);
    expect(hydrated.variants[100]).toMatchObject({
      id: "gid://shopify/ProductVariant/101",
      inventory_item_gid: "gid://shopify/InventoryItem/101",
      inventory_item_updated_at: "2026-08-10T12:01:00Z",
      unit_cost_known: true,
      unit_cost: "50.5",
    });
  });

  it("hydrates every order-referenced variant and groups complete local catalog writes", async () => {
    const otherProduct = product("gid://shopify/Product/2");
    const graphql = vi.fn(
      async (
        _query: string,
        _options?: { variables?: Record<string, unknown> },
      ) => ok({ nodes: [variant(11), variant(22, otherProduct)] }),
    );

    const products = await hydrateOrderVariantProducts(
      { graphql },
      ["11", "gid://shopify/ProductVariant/22"],
      true,
    );

    expect(products).toHaveLength(2);
    expect(
      products.flatMap((entry) => entry.variants).map((entry) => entry.id),
    ).toEqual([
      "gid://shopify/ProductVariant/11",
      "gid://shopify/ProductVariant/22",
    ]);
    expect(graphql.mock.calls[0]![1]?.variables).toEqual({
      ids: [
        "gid://shopify/ProductVariant/11",
        "gid://shopify/ProductVariant/22",
      ],
    });
  });

  it("fails instead of freezing a zero-cost anonymous line when Shopify omits a variant", async () => {
    await expect(
      hydrateOrderVariantProducts(
        { graphql: vi.fn(async () => ok({ nodes: [null] })) },
        ["404"],
        true,
      ),
    ).rejects.toThrow(/did not return 1 referenced order variant/i);
  });

  it("resolves inventory-item edits through the variants connection", async () => {
    const itemVariant = variant(51);
    const graphql = vi.fn(async () =>
      ok({
        inventoryItem: {
          id: itemVariant.inventoryItem.id,
          updatedAt: "2026-08-10T13:00:00Z",
          unitCost: { amount: "19.75" },
          variants: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                ...itemVariant,
                inventoryItem: undefined,
              },
            ],
          },
        },
      }),
    );

    const products = await hydrateInventoryItemProducts(
      { graphql },
      "51",
      true,
    );

    expect(products[0]!.variants[0]).toMatchObject({
      inventory_item_gid: "gid://shopify/InventoryItem/51",
      inventory_item_updated_at: "2026-08-10T13:00:00Z",
      unit_cost: "19.75",
    });
  });

  it("propagates GraphQL errors so the durable delivery retries", async () => {
    await expect(
      hydrateProductWebhook(
        {
          graphql: vi.fn(async () => ({
            json: async () => ({ errors: [{ message: "throttled" }] }),
          })) as never,
        },
        { id: 1 },
        true,
      ),
    ).rejects.toThrow(/Shopify GraphQL: throttled/);
  });
});
