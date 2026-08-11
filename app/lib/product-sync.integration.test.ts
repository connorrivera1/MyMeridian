import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Transaction rollback and advisory-lock contention are database semantics.
 * The in-process product-sync suite proves the decisions; this suite proves
 * Postgres keeps current catalog state and irreconstructible price history as
 * one serialized fact.
 */
const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("product sync, against a real Postgres", () => {
  let prisma: any;
  let syncProductFromShopify: (shopId: string, payload: any) => Promise<any>;
  let importProducts: (
    shopId: string,
    admin: { graphql: (query: string) => Promise<Response> },
    includeCost: boolean,
  ) => Promise<number>;
  let withProductLock: (
    shopId: string,
    shopifyProductId: string,
    run: (tx: any) => Promise<any>,
  ) => Promise<any>;
  let shopId: string;
  const runId = Date.now();

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    ({ syncProductFromShopify } = await import("./sync.server"));
    ({ importProducts } = await import("./backfill.server"));
    ({ withProductLock } = await import("./product-lock.server"));

    const shop = await prisma.shop.create({
      data: {
        domain: `product-atomicity-${runId}.myshopify.com`,
        name: "Product Atomicity Test",
        currency: "USD",
        timezone: "UTC",
      },
    });
    shopId = shop.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  function payload(
    productId: number,
    title: string,
    variants: Array<{ id: number; price: string; inventory?: number }>,
    updatedAt = "2026-08-10T12:00:00.000Z",
  ) {
    return {
      id: productId,
      title,
      handle: `product-${productId}`,
      status: "active",
      updated_at: updatedAt,
      variants: variants.map((variant) => ({
        id: variant.id,
        title: `Variant ${variant.id}`,
        sku: `SKU-${variant.id}`,
        price: variant.price,
        inventory_quantity: variant.inventory ?? 5,
        grams: 100,
      })),
    };
  }

  const ok = (data: unknown) =>
    ({ json: async () => ({ data }) }) as unknown as Response;

  function productPage(
    productId: number,
    title: string,
    updatedAt: string,
    variants: Array<{ id: number; price: string; inventory?: number }>,
  ) {
    return {
      products: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: `gid://shopify/Product/${productId}`,
            title,
            handle: `product-${productId}`,
            productType: "Outerwear",
            vendor: "Northwind",
            status: "ACTIVE",
            updatedAt,
            variants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: variants.map((variant) => ({
                id: `gid://shopify/ProductVariant/${variant.id}`,
                title: `Variant ${variant.id}`,
                sku: `SKU-${variant.id}`,
                price: variant.price,
                compareAtPrice: null,
                inventoryQuantity: variant.inventory ?? 5,
                inventoryItem: null,
              })),
            },
          },
        ],
      },
    };
  }

  it("rolls back all current rows on a history fault, then replays exactly once", async () => {
    const productId = runId + 100;
    const firstVariantId = runId + 101;
    const secondVariantId = runId + 102;
    const initial = payload(productId, "Original", [
      { id: firstVariantId, price: "10.00" },
      { id: secondVariantId, price: "20.00" },
    ]);
    await syncProductFromShopify(shopId, initial);

    const secondVariant = await prisma.variant.findUniqueOrThrow({
      where: {
        shopId_shopifyId: {
          shopId,
          shopifyId: `gid://shopify/ProductVariant/${secondVariantId}`,
        },
      },
    });
    const suffix = String(runId).replace(/\D/g, "");
    const functionName = `meridian_fail_price_${suffix}`;
    const triggerName = `meridian_fail_price_trigger_${suffix}`;
    const escapedVariantId = String(secondVariant.id).replaceAll("'", "''");

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."variantId" = '${escapedVariantId}' THEN
          RAISE EXCEPTION 'injected price history failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "PriceChange"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    const changed = payload(productId, "Changed", [
      { id: firstVariantId, price: "11.00", inventory: 9 },
      { id: secondVariantId, price: "22.00", inventory: 9 },
    ]);
    try {
      await expect(syncProductFromShopify(shopId, changed)).rejects.toThrow(
        /injected price history failure/i,
      );
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON "PriceChange"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${functionName}"()`,
      );
    }

    const rolledBackProduct = await prisma.product.findUniqueOrThrow({
      where: {
        shopId_shopifyId: {
          shopId,
          shopifyId: `gid://shopify/Product/${productId}`,
        },
      },
      include: { variants: { orderBy: { shopifyId: "asc" } } },
    });
    expect(rolledBackProduct.title).toBe("Original");
    expect(
      rolledBackProduct.variants.map((variant: any) => String(variant.price)),
    ).toEqual(["10", "20"]);
    expect(await prisma.priceChange.count({ where: { shopId } })).toBe(2);

    await syncProductFromShopify(shopId, changed);
    await syncProductFromShopify(shopId, changed);

    const committed = await prisma.product.findUniqueOrThrow({
      where: {
        shopId_shopifyId: {
          shopId,
          shopifyId: `gid://shopify/Product/${productId}`,
        },
      },
      include: {
        variants: {
          orderBy: { shopifyId: "asc" },
          include: { priceHistory: true },
        },
      },
    });
    expect(committed.title).toBe("Changed");
    expect(
      committed.variants.map((variant: any) => String(variant.price)),
    ).toEqual(["11", "22"]);
    expect(
      committed.variants.map((variant: any) =>
        variant.priceHistory.map((row: any) => String(row.price)).sort(),
      ),
    ).toEqual([
      ["10", "11"],
      ["20", "22"],
    ]);
  });

  it("serialises concurrent deliveries and records each real transition once", async () => {
    const productId = runId + 200;
    const variantId = runId + 201;
    const productGid = `gid://shopify/Product/${productId}`;
    await syncProductFromShopify(
      shopId,
      payload(productId, "Concurrent", [{ id: variantId, price: "30.00" }]),
    );

    let active = 0;
    let overlapped = false;
    const holdLock = () =>
      withProductLock(shopId, productGid, async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 60));
        active -= 1;
      });
    await Promise.all([holdLock(), holdLock()]);
    expect(overlapped).toBe(false);

    const sameTransition = payload(
      productId,
      "Concurrent",
      [{ id: variantId, price: "31.00" }],
      "2026-08-10T12:01:00.000Z",
    );
    await Promise.all([
      syncProductFromShopify(shopId, sameTransition),
      syncProductFromShopify(shopId, sameTransition),
    ]);

    await Promise.all([
      syncProductFromShopify(
        shopId,
        payload(
          productId,
          "Concurrent A",
          [{ id: variantId, price: "32.00" }],
          "2026-08-10T12:02:00.000Z",
        ),
      ),
      syncProductFromShopify(
        shopId,
        payload(
          productId,
          "Concurrent B",
          [{ id: variantId, price: "33.00" }],
          "2026-08-10T12:03:00.000Z",
        ),
      ),
    ]);

    const storedProduct = await prisma.product.findUniqueOrThrow({
      where: {
        shopId_shopifyId: {
          shopId,
          shopifyId: productGid,
        },
      },
      include: { variants: { include: { priceHistory: true } } },
    });
    const storedVariant = storedProduct.variants[0];
    const prices = storedVariant.priceHistory
      .map((row: any) => String(row.price))
      .sort();
    expect(prices).toEqual(["30", "31", "32", "33"]);
    expect(String(storedVariant.price)).toBe("33");
    expect(storedProduct.title).toBe("Concurrent B");
    expect(storedProduct.shopifyUpdatedAt).toEqual(
      new Date("2026-08-10T12:03:00.000Z"),
    );
  });

  it("records one honest import baseline per variant and reimports idempotently", async () => {
    const productId = runId + 300;
    const firstVariantId = runId + 301;
    const secondVariantId = runId + 302;
    const page = productPage(
      productId,
      "Imported baseline",
      "2026-08-01T12:00:00.000Z",
      [
        { id: firstVariantId, price: "40.00" },
        { id: secondVariantId, price: "50.00" },
      ],
    );
    const admin = { graphql: async () => ok(page) };
    const beforeObservation = new Date();

    await importProducts(shopId, admin, false);
    await importProducts(shopId, admin, false);

    const product = await prisma.product.findUniqueOrThrow({
      where: {
        shopId_shopifyId: {
          shopId,
          shopifyId: `gid://shopify/Product/${productId}`,
        },
      },
      include: {
        variants: {
          orderBy: { shopifyId: "asc" },
          include: { priceHistory: true },
        },
      },
    });
    expect(product.shopifyUpdatedAt).toEqual(
      new Date("2026-08-01T12:00:00.000Z"),
    );
    expect(
      product.variants.map((variant: any) => String(variant.price)),
    ).toEqual(["40", "50"]);
    expect(
      product.variants.map((variant: any) => variant.priceHistory.length),
    ).toEqual([1, 1]);
    for (const variant of product.variants) {
      expect(
        variant.priceHistory[0].effectiveAt.getTime(),
      ).toBeGreaterThanOrEqual(beforeObservation.getTime());
      expect(variant.priceHistory[0].effectiveAt).toEqual(
        product.variants[0].priceHistory[0].effectiveAt,
      );
    }
  });

  it("does not let an in-flight stale backfill overwrite a newer webhook", async () => {
    const productId = runId + 400;
    const variantId = runId + 401;
    let releasePage!: () => void;
    let markRequested!: () => void;
    const pageRequested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    const pageReleased = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const stalePage = productPage(
      productId,
      "Stale backfill title",
      "2026-08-10T12:02:00.000Z",
      [{ id: variantId, price: "32.00", inventory: 2 }],
    );
    const backfill = importProducts(
      shopId,
      {
        graphql: async () => {
          markRequested();
          await pageReleased;
          return ok(stalePage);
        },
      },
      false,
    );

    await pageRequested;
    await syncProductFromShopify(
      shopId,
      payload(
        productId,
        "Newest webhook title",
        [{ id: variantId, price: "33.00", inventory: 9 }],
        "2026-08-10T12:03:00.000Z",
      ),
    );
    releasePage();
    await backfill;

    const product = await prisma.product.findUniqueOrThrow({
      where: {
        shopId_shopifyId: {
          shopId,
          shopifyId: `gid://shopify/Product/${productId}`,
        },
      },
      include: { variants: { include: { priceHistory: true } } },
    });
    expect(product.title).toBe("Newest webhook title");
    expect(product.shopifyUpdatedAt).toEqual(
      new Date("2026-08-10T12:03:00.000Z"),
    );
    expect(String(product.variants[0].price)).toBe("33");
    expect(product.variants[0].inventoryQty).toBe(9);
    expect(
      product.variants[0].priceHistory.map((row: any) => String(row.price)),
    ).toEqual(["33"]);
  });
});
