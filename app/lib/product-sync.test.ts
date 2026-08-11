import { beforeEach, describe, expect, it, vi } from "vitest";

interface ProductRow {
  id: string;
  shopId: string;
  shopifyId: string;
  title: string;
  shopifyUpdatedAt: Date | null;
  [key: string]: unknown;
}

interface VariantRow {
  id: string;
  shopId: string;
  productId: string;
  shopifyId: string;
  price: string;
  [key: string]: unknown;
}

interface PriceChangeRow {
  id: string;
  shopId: string;
  variantId: string;
  price: string;
  effectiveAt: Date;
}

interface CatalogState {
  product: ProductRow | null;
  variants: Map<string, VariantRow>;
  priceChanges: PriceChangeRow[];
}

let state: CatalogState;
let failHistoryPrice: string | null;
let nextId: number;
const advisoryLock = vi.fn(async () => 0);

function cloneState(source: CatalogState): CatalogState {
  return {
    product: source.product ? { ...source.product } : null,
    variants: new Map(
      [...source.variants].map(([key, value]) => [key, { ...value }]),
    ),
    priceChanges: source.priceChanges.map((row) => ({ ...row })),
  };
}

function clientFor(draft: CatalogState) {
  return {
    product: {
      findUnique: vi.fn(async () =>
        draft.product ? { ...draft.product } : null,
      ),
      upsert: vi.fn(async ({ create, update }: any) => {
        draft.product = draft.product
          ? { ...draft.product, ...update }
          : { id: `product_${nextId++}`, ...create };
        return { ...draft.product };
      }),
    },
    variant: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = draft.variants.get(where.shopId_shopifyId.shopifyId);
        return row
          ? {
              ...row,
              _count: {
                priceHistory: draft.priceChanges.filter(
                  (change) => change.variantId === row.id,
                ).length,
              },
            }
          : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.shopId_shopifyId.shopifyId;
        const existing = draft.variants.get(key);
        const normalized = (data: Record<string, unknown>) => ({
          ...data,
          price: String(data.price),
        });
        const row = existing
          ? { ...existing, ...normalized(update) }
          : { id: `variant_${nextId++}`, ...normalized(create) };
        draft.variants.set(key, row as VariantRow);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = [...draft.variants.values()].find(
          (candidate) => candidate.id === where.id,
        );
        if (!row) throw new Error(`missing variant ${where.id}`);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    priceChange: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = draft.priceChanges.find(
          (change) =>
            change.variantId === where.variantId &&
            Number(change.price) === Number(String(where.price)) &&
            change.effectiveAt.getTime() === where.effectiveAt.getTime(),
        );
        return row ? { id: row.id } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        if (
          failHistoryPrice !== null &&
          Number(String(data.price)) === Number(failHistoryPrice)
        ) {
          throw new Error("injected price history failure");
        }
        const row = {
          id: `price_${nextId++}`,
          ...data,
          price: String(data.price),
        };
        draft.priceChanges.push(row);
        return { ...row };
      }),
    },
    $executeRaw: advisoryLock,
  };
}

vi.mock("~/db.server", () => ({
  default: {
    $transaction: async (
      run: (tx: ReturnType<typeof clientFor>) => unknown,
    ) => {
      const draft = cloneState(state);
      const result = await run(clientFor(draft));
      state = draft;
      return result;
    },
  },
}));

const { syncProductFromShopify } = await import("./sync.server");

const SHOP_ID = "shop_product_atomicity";

function productPayload(
  title: string,
  variants: Array<{
    id: number;
    price: string;
    inventory?: number;
    unitCost?: string | null;
    inventoryUpdatedAt?: string;
  }>,
  updatedAt = "2026-08-10T12:00:00.000Z",
) {
  return {
    id: 4100,
    title,
    handle: "atomic-product",
    status: "active",
    updated_at: updatedAt,
    variants: variants.map((variant) => ({
      id: variant.id,
      title: `Variant ${variant.id}`,
      sku: `SKU-${variant.id}`,
      price: variant.price,
      inventory_quantity: variant.inventory ?? 5,
      grams: 100,
      ...(variant.inventoryUpdatedAt
        ? {
            inventory_item_gid: `gid://shopify/InventoryItem/${variant.id}`,
            inventory_item_updated_at: variant.inventoryUpdatedAt,
            unit_cost_known: true,
            unit_cost: variant.unitCost ?? null,
          }
        : {}),
    })),
  };
}

function variant(id: number): VariantRow {
  return state.variants.get(`gid://shopify/ProductVariant/${id}`)!;
}

beforeEach(() => {
  state = { product: null, variants: new Map(), priceChanges: [] };
  failHistoryPrice = null;
  nextId = 1;
  advisoryLock.mockClear();
});

describe("syncProductFromShopify atomic price history", () => {
  it("treats Prisma's canonical Decimal text as the same incoming price", async () => {
    const delivery = productPayload("Decimal representation", [
      { id: 5099, price: "10.00" },
    ]);
    await syncProductFromShopify(SHOP_ID, delivery);

    // PostgreSQL/Prisma reads Decimal(12,2) 10.00 back as Decimal("10"). A
    // string comparison sees a change on every replay even though the numeric
    // price is identical.
    variant(5099).price = "10";
    await syncProductFromShopify(SHOP_ID, delivery);

    expect(state.priceChanges.map((row) => row.price)).toEqual(["10"]);
  });

  it("rolls back current state when history fails, then records one row on retry", async () => {
    await syncProductFromShopify(
      SHOP_ID,
      productPayload("Original", [{ id: 5100, price: "10.00" }]),
    );

    failHistoryPrice = "12.00";
    await expect(
      syncProductFromShopify(
        SHOP_ID,
        productPayload("Changed", [{ id: 5100, price: "12.00", inventory: 9 }]),
      ),
    ).rejects.toThrow("injected price history failure");

    expect(state.product?.title).toBe("Original");
    expect(variant(5100).price).toBe("10");
    expect(variant(5100).inventoryQty).toBe(5);
    expect(state.priceChanges.map((row) => row.price)).toEqual(["10"]);

    failHistoryPrice = null;
    const retry = productPayload("Changed", [
      { id: 5100, price: "12.00", inventory: 9 },
    ]);
    await syncProductFromShopify(SHOP_ID, retry);
    await syncProductFromShopify(SHOP_ID, retry);

    expect(state.product?.title).toBe("Changed");
    expect(variant(5100).price).toBe("12");
    expect(variant(5100).inventoryQty).toBe(9);
    expect(state.priceChanges.map((row) => row.price)).toEqual(["10", "12"]);
    expect(advisoryLock).toHaveBeenCalledTimes(4);
  });

  it("rolls back earlier variants when a later history insert fails", async () => {
    await syncProductFromShopify(
      SHOP_ID,
      productPayload("Two variants", [
        { id: 5101, price: "10.00" },
        { id: 5102, price: "20.00" },
      ]),
    );

    failHistoryPrice = "22.00";
    await expect(
      syncProductFromShopify(
        SHOP_ID,
        productPayload("Failed update", [
          { id: 5101, price: "11.00" },
          { id: 5102, price: "22.00" },
        ]),
      ),
    ).rejects.toThrow("injected price history failure");

    expect(state.product?.title).toBe("Two variants");
    expect([variant(5101).price, variant(5102).price]).toEqual(["10", "20"]);
    expect(state.priceChanges.map((row) => row.price)).toEqual(["10", "20"]);
  });

  it("keeps newer current state when an older delivery arrives late", async () => {
    await syncProductFromShopify(
      SHOP_ID,
      productPayload(
        "Newest title",
        [{ id: 5103, price: "33.00", inventory: 8 }],
        "2026-08-10T12:03:00.000Z",
      ),
    );
    const stale = productPayload(
      "Older title",
      [{ id: 5103, price: "32.00", inventory: 4 }],
      "2026-08-10T12:02:00.000Z",
    );
    await syncProductFromShopify(SHOP_ID, stale);
    await syncProductFromShopify(SHOP_ID, stale);

    expect(state.product?.title).toBe("Newest title");
    expect(state.product?.shopifyUpdatedAt).toEqual(
      new Date("2026-08-10T12:03:00.000Z"),
    );
    expect(variant(5103).price).toBe("33");
    expect(variant(5103).inventoryQty).toBe(8);
    expect(
      state.priceChanges.map((row) => [row.price, row.effectiveAt]),
    ).toEqual([
      ["33", new Date("2026-08-10T12:03:00.000Z")],
      ["32", new Date("2026-08-10T12:02:00.000Z")],
    ]);
  });

  it("orders cost edits on the inventory-item clock independently of product chronology", async () => {
    await syncProductFromShopify(
      SHOP_ID,
      productPayload(
        "Newest title",
        [
          {
            id: 5104,
            price: "40.00",
            unitCost: "18.00",
            inventoryUpdatedAt: "2026-08-10T13:00:00.000Z",
          },
        ],
        "2026-08-10T12:03:00.000Z",
      ),
    );

    await syncProductFromShopify(
      SHOP_ID,
      productPayload(
        "Stale product title",
        [
          {
            id: 5104,
            price: "39.00",
            unitCost: "21.50",
            inventoryUpdatedAt: "2026-08-10T14:00:00.000Z",
          },
        ],
        "2026-08-10T12:02:00.000Z",
      ),
    );
    await syncProductFromShopify(
      SHOP_ID,
      productPayload(
        "Still stale",
        [
          {
            id: 5104,
            price: "38.00",
            unitCost: "19.00",
            inventoryUpdatedAt: "2026-08-10T13:30:00.000Z",
          },
        ],
        "2026-08-10T12:01:00.000Z",
      ),
    );

    expect(state.product?.title).toBe("Newest title");
    expect(variant(5104).price).toBe("40");
    expect(String(variant(5104).unitCost)).toBe("21.50");
    expect(variant(5104).inventoryItemShopifyId).toBe(
      "gid://shopify/InventoryItem/5104",
    );
    expect(variant(5104).inventoryItemUpdatedAt).toEqual(
      new Date("2026-08-10T14:00:00.000Z"),
    );
  });
});
