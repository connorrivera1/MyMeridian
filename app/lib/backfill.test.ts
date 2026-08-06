import { CostSource, SyncStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `runBackfill` itself — the stage sequence, what it writes to the Shop row at
 * each end of it, and the two capability branches.
 *
 * The four `backfill-*.test.ts` files beside this one cover the pieces: the
 * GraphQL error handling, the resume cursor, the nested-collection pagination,
 * and the fulfilment rows. None of them ever runs the import. That left the
 * orchestration untested, and the orchestration is where the expensive
 * mistakes are — a resume point kept after a completed walk skips the whole
 * store on the next run, one thrown away on failure costs the merchant the
 * entire import a second time, and a frozen admin client fails silently an
 * hour into exactly the imports that are long enough to need it.
 *
 * Driven against a scripted admin client and a mocked Prisma, because every
 * one of these is a question about which value was written, not about what the
 * database did with it.
 */

// Read once at module load, so it is set before the import below. Four is
// above every other test here and below the cap case, which uses five.
process.env.MERIDIAN_MAX_BACKFILL_ORDERS = "4";

const ADMIN_CLIENT_MAX_AGE_MS = 40 * 60 * 1000;

interface ShopRow {
  id: string;
  domain: string;
  isDemo: boolean;
  grantedScopes: string | null;
  syncStatus: SyncStatus;
  syncCursor: string | null;
  syncedOrders: number;
  syncedProducts: number;
  syncStage: string | null;
  syncError: string | null;
  earliestOrderAt: Date | null;
  hasAllOrdersScope: boolean;
}

let shopRow: ShopRow;
/** Every `data` object handed to `shop.update`, in order. */
let shopUpdates: Record<string, unknown>[];

const variantUpserts: Record<string, unknown>[] = [];
const lineItemsCreated: Record<string, unknown>[] = [];
const storedVariants: { id: string; shopifyId: string; productId: string; unitCost: string }[] =
  [];

const prismaMock = {
  shop: {
    findUniqueOrThrow: vi.fn(async () => ({ ...shopRow })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      shopUpdates.push(data);
      Object.assign(shopRow, data);
      return shopRow;
    }),
  },
  product: { upsert: vi.fn(async () => ({ id: "product_row" })) },
  variant: {
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
      variantUpserts.push(args.create);
      return { id: "variant_row" };
    }),
    findMany: vi.fn(async () => storedVariants),
  },
  order: {
    upsert: vi.fn(async () => ({ id: "order_row" })),
    aggregate: vi.fn(async () => ({ _min: { processedAt: null } })),
  },
  customer: { upsert: vi.fn(async () => ({ id: "customer_row" })) },
  orderLineItem: {
    deleteMany: vi.fn(async () => ({})),
    createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
      lineItemsCreated.push(...data);
      return {};
    }),
  },
  fulfillment: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
  capacityDay: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
  // rebuildCapacityDays is raw SQL and is proven against real Postgres
  // elsewhere. An empty `received` makes it return before it writes anything,
  // which is enough to tell "it ran" from "it did not".
  $queryRaw: vi.fn(async () => []),
};

vi.mock("~/db.server", () => ({ default: prismaMock }));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
  loadStrategicProductIds: vi.fn(),
}));

const generatePricingRecommendations = vi.fn(async (..._args: unknown[]) => 0);
const recomputeShopProfitability = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("~/lib/pricing.server", () => ({
  generatePricingRecommendations: (...args: unknown[]) =>
    generatePricingRecommendations(...args),
}));
vi.mock("~/lib/recompute.server", () => ({
  recomputeShopProfitability: (...args: unknown[]) => recomputeShopProfitability(...args),
}));

const reconcileFirstOrdersForShop = vi.fn(async (..._args: unknown[]) => 0);
vi.mock("~/lib/sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sync.server")>()),
  reconcileFirstOrdersForShop: (...args: unknown[]) => reconcileFirstOrdersForShop(...args),
}));

const unauthenticatedAdmin = vi.fn();
vi.mock("~/shopify.server", () => ({
  unauthenticated: { admin: (...args: unknown[]) => unauthenticatedAdmin(...args) },
}));

const { backfillIsStale, runBackfill } = await import("./backfill.server");

// ---------------------------------------------------------------------------
// A scripted store
// ---------------------------------------------------------------------------

const ok = (data: unknown) => ({ json: async () => ({ data }) }) as unknown as Response;

const SHOP_PROFILE = {
  shop: {
    name: "Northwind Outfitters",
    email: "owner@northwind.example",
    currencyCode: "CAD",
    ianaTimezone: "America/Toronto",
    plan: { displayName: "Shopify Plus" },
  },
};

function variantNode(id: string, unitCost: string | null) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    sku: `SKU-${id}`,
    title: `Variant ${id}`,
    price: "120.00",
    compareAtPrice: null,
    inventoryQuantity: 7,
    inventoryItem: unitCost ? { unitCost: { amount: unitCost } } : null,
  };
}

function productPage(nodes: unknown[], next: string | null) {
  return {
    products: {
      pageInfo: { hasNextPage: next !== null, endCursor: next },
      nodes,
    },
  };
}

const DEFAULT_PRODUCTS = [
  {
    id: "gid://shopify/Product/1",
    title: "Alpine Shell Jacket",
    handle: "alpine-shell-jacket",
    productType: "Outerwear",
    vendor: "Northwind",
    status: "ACTIVE",
    variants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [variantNode("11", "48.00")],
    },
  },
];

function orderNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    processedAt: "2026-07-01T12:00:00Z",
    createdAt: "2026-07-01T12:00:00Z",
    currencyCode: "CAD",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    subtotalPriceSet: { shopMoney: { amount: "120.00" } },
    totalDiscountsSet: { shopMoney: { amount: "0.00" } },
    totalShippingPriceSet: { shopMoney: { amount: "10.00" } },
    totalTaxSet: { shopMoney: { amount: "15.60" } },
    totalPriceSet: { shopMoney: { amount: "145.60" } },
    totalRefundedSet: { shopMoney: { amount: "0.00" } },
    lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    refunds: [],
    ...overrides,
  };
}

function orderPage(nodes: unknown[], next: string | null) {
  return {
    orders: {
      pageInfo: { hasNextPage: next !== null, endCursor: next },
      nodes,
    },
  };
}

interface Script {
  products?: unknown[];
  orders?: unknown[];
  /** Milliseconds the clock moves on after each request this client serves. */
  advanceMsPerCall?: number;
  /** Thrown instead of answering the nth request of that operation. */
  failOn?: { operation: string; nth: number; error: Error };
}

/**
 * An admin client that answers by operation name, so a test that expects the
 * products query and gets the orders query fails rather than passing on a
 * coincidence.
 */
function scriptedAdmin(script: Script = {}) {
  const productPages = script.products ?? [productPage(DEFAULT_PRODUCTS, null)];
  const orderPages = script.orders ?? [orderPage([orderNode("1001")], null)];
  const seen: Record<string, number> = {};
  const operations: string[] = [];

  const graphql = vi.fn(async (query: string) => {
    const operation = /query (Meridian\w+)/.exec(query)?.[1] ?? "unknown";
    const nth = (seen[operation] = (seen[operation] ?? 0) + 1);
    operations.push(operation);

    if (script.advanceMsPerCall) {
      vi.setSystemTime(new Date(Date.now() + script.advanceMsPerCall));
    }

    if (script.failOn?.operation === operation && script.failOn.nth === nth) {
      throw script.failOn.error;
    }

    switch (operation) {
      case "MeridianShop":
        return ok(SHOP_PROFILE);
      case "MeridianProducts": {
        const page = productPages[nth - 1];
        if (!page) throw new Error(`test: no product page ${nth}`);
        return ok(page);
      }
      case "MeridianOrders": {
        const page = orderPages[nth - 1];
        if (!page) throw new Error(`test: no order page ${nth}`);
        return ok(page);
      }
      default:
        throw new Error(`test: unscripted operation ${operation}`);
    }
  });

  return { graphql, operations, queries: () => graphql.mock.calls.map((c) => c[0]) };
}

const ALL_SCOPES =
  "read_orders,read_products,read_inventory,read_customers,read_fulfillments";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-06T09:00:00Z"));

  shopRow = {
    id: "shop_1",
    domain: "northwind.myshopify.com",
    isDemo: false,
    grantedScopes: ALL_SCOPES,
    syncStatus: SyncStatus.PENDING,
    syncCursor: null,
    syncedOrders: 0,
    syncedProducts: 0,
    syncStage: null,
    syncError: null,
    earliestOrderAt: null,
    hasAllOrdersScope: false,
  };
  shopUpdates = [];
  variantUpserts.length = 0;
  lineItemsCreated.length = 0;
  storedVariants.length = 0;
  generatePricingRecommendations.mockResolvedValue(0);
  recomputeShopProfitability.mockResolvedValue(undefined);
  unauthenticatedAdmin.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The `data` of the update that finished the run. */
const finalUpdate = () => shopUpdates[shopUpdates.length - 1]!;

// ---------------------------------------------------------------------------

describe("runBackfill: a completed import", () => {
  it("records the store profile, the counts and the history it found", async () => {
    const admin = scriptedAdmin({
      orders: [
        orderPage([orderNode("1001", { processedAt: "2023-04-02T08:00:00Z" })], "cursor_p1"),
        orderPage([orderNode("1002")], null),
      ],
    });

    const result = await runBackfill("shop_1", admin);

    expect(result).toMatchObject({
      products: 1,
      orders: 2,
      reachedOrderCap: false,
      earliestOrderAt: new Date("2023-04-02T08:00:00Z"),
    });
    // Currency and timezone are not cosmetic — the engine buckets orders into
    // the merchant's own days, so a wrong zone moves every evening order.
    expect(shopUpdates).toContainEqual(
      expect.objectContaining({ currency: "CAD", timezone: "America/Toronto" }),
    );
    expect(finalUpdate()).toMatchObject({
      syncStatus: SyncStatus.COMPLETE,
      syncStage: null,
      earliestOrderAt: new Date("2023-04-02T08:00:00Z"),
      // Orders older than sixty days exist, so the store has history the
      // default scope would have hidden.
      hasAllOrdersScope: true,
    });
  });

  it("throws the resume point away, so the next run does not skip the store", async () => {
    const admin = scriptedAdmin({
      orders: [orderPage([orderNode("1001")], "cursor_p1"), orderPage([orderNode("1002")], null)],
    });

    await runBackfill("shop_1", admin);

    // The last page's cursor is written by the order walk and points at the
    // *end* of the store. Left behind, a later run that dies before the order
    // stage would resume from there and import nothing at all.
    expect(finalUpdate()).toMatchObject({ syncCursor: null });
    expect(shopRow.syncCursor).toBeNull();
  });

  it("runs the stages in order and reports each one", async () => {
    const admin = scriptedAdmin();

    await runBackfill("shop_1", admin);

    expect(admin.operations).toEqual([
      "MeridianShop",
      "MeridianProducts",
      "MeridianOrders",
    ]);
    const stages = shopUpdates
      .map((update) => update.syncStage)
      .filter((stage): stage is string => typeof stage === "string");
    expect(stages).toEqual([
      "Reading store settings",
      "Importing products and costs",
      "Importing order history",
      "Rebuilding fulfilment history",
      "Computing profitability",
    ]);
  });

  it("does not fail the import when pricing recommendations cannot be built", async () => {
    // Recommendations are a derived nicety; the imported orders are not. A
    // regression in the elasticity fit must not throw six months of history
    // away and report FAILED.
    generatePricingRecommendations.mockRejectedValue(new Error("not enough price points"));

    await expect(runBackfill("shop_1", scriptedAdmin())).resolves.toBeTruthy();

    expect(recomputeShopProfitability).toHaveBeenCalledWith("shop_1");
    expect(finalUpdate()).toMatchObject({ syncStatus: SyncStatus.COMPLETE });
  });
});

describe("runBackfill: a failed import", () => {
  const longMessage = `Shopify GraphQL: ${"the connection was reset. ".repeat(40)}`;

  it("marks the shop failed and keeps the error short enough to store", async () => {
    const admin = scriptedAdmin({
      failOn: { operation: "MeridianOrders", nth: 1, error: new Error(longMessage) },
    });

    await expect(runBackfill("shop_1", admin)).rejects.toThrow(/connection was reset/);

    const update = finalUpdate();
    expect(update).toMatchObject({ syncStatus: SyncStatus.FAILED, syncStage: null });
    // `syncError` is a bounded column; an unbounded Shopify message would
    // fail the very update that exists to record the failure.
    expect(String(update.syncError).length).toBe(500);
    expect(String(update.syncError)).toContain("connection was reset");
  });

  it("keeps the resume point, so the next attempt does not re-walk the store", async () => {
    const admin = scriptedAdmin({
      orders: [orderPage([orderNode("1001")], "cursor_p1")],
      failOn: { operation: "MeridianOrders", nth: 2, error: new Error("Shopify GraphQL: 502") },
    });

    await expect(runBackfill("shop_1", admin)).rejects.toThrow(/502/);

    // The pair to the completed-import case above: on success the cursor must
    // go, on failure it must stay. This is the whole value of the resume path.
    expect(shopRow.syncCursor).toBe("cursor_p1");
    expect(shopRow.syncedOrders).toBe(1);
    expect(finalUpdate()).not.toHaveProperty("syncCursor");
  });

  it("does not mark the import complete when a stage threw", async () => {
    const admin = scriptedAdmin({
      failOn: { operation: "MeridianShop", nth: 1, error: new Error("Shopify GraphQL: 500") },
    });

    await expect(runBackfill("shop_1", admin)).rejects.toThrow();

    expect(shopUpdates).not.toContainEqual(
      expect.objectContaining({ syncStatus: SyncStatus.COMPLETE }),
    );
    expect(recomputeShopProfitability).not.toHaveBeenCalled();
  });
});

describe("runBackfill: resuming an interrupted import", () => {
  it("carries the order count over but restarts the product count", async () => {
    shopRow.syncStatus = SyncStatus.FAILED;
    shopRow.syncCursor = "cursor_p1";
    shopRow.syncedOrders = 12_000;
    shopRow.syncedProducts = 340;

    const admin = scriptedAdmin();

    await runBackfill("shop_1", admin);

    // The reset at the top of the run is what used to throw the resume point
    // away. Products are re-read either way — the cursor only covers orders —
    // so that counter restarts, while the order counter carries over or the
    // cap becomes per-attempt rather than a total.
    expect(shopUpdates[0]).toMatchObject({
      syncStatus: SyncStatus.RUNNING,
      syncStage: "Resuming order history",
      syncedOrders: 12_000,
      syncedProducts: 0,
      syncCursor: "cursor_p1",
    });
  });

  it("starts a completed shop from the beginning rather than the last cursor", async () => {
    shopRow.syncStatus = SyncStatus.COMPLETE;
    shopRow.syncCursor = "cursor_p1";
    shopRow.syncedOrders = 12_000;

    await runBackfill("shop_1", scriptedAdmin());

    expect(shopUpdates[0]).toMatchObject({
      syncStage: "Reading store settings",
      syncedOrders: 0,
      syncCursor: null,
    });
  });

  it("stops at the order cap and says so", async () => {
    // MERIDIAN_MAX_BACKFILL_ORDERS is 4 for this file.
    const admin = scriptedAdmin({
      orders: [
        orderPage([orderNode("1"), orderNode("2"), orderNode("3")], "cursor_p1"),
        orderPage([orderNode("4"), orderNode("5")], "cursor_p2"),
      ],
    });

    const result = await runBackfill("shop_1", admin);

    expect(result.orders).toBe(4);
    expect(result.reachedOrderCap).toBe(true);
    // The fifth order was on the page but past the cap, and no third page was
    // ever asked for.
    expect(admin.operations.filter((op) => op === "MeridianOrders")).toHaveLength(2);
  });
});

describe("runBackfill: what the granted scopes change", () => {
  it("drops the capacity series when fulfilment access is missing", async () => {
    shopRow.grantedScopes = "read_orders,read_products,read_inventory";

    await runBackfill("shop_1", scriptedAdmin());

    // A capacity series built from orders alone shows a backlog that only ever
    // grows and fires a "you are behind" alert at a warehouse that is not.
    // Better to have none and say so.
    expect(prismaMock.capacityDay.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop_1" },
    });
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("rebuilds the capacity series when fulfilment access is granted", async () => {
    await runBackfill("shop_1", scriptedAdmin());

    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    expect(prismaMock.capacityDay.deleteMany).not.toHaveBeenCalled();
  });

  it("does not ask for unit cost without read_inventory, and says so in the stage", async () => {
    shopRow.grantedScopes = "read_orders,read_products";
    const admin = scriptedAdmin();

    await runBackfill("shop_1", admin);

    // Asking for `inventoryItem` without the scope fails the entire query
    // rather than nulling that one field, so the whole product import would
    // be lost rather than its costs.
    const productsQuery = admin.queries().find((q) => q.includes("MeridianProducts"))!;
    expect(productsQuery).not.toContain("inventoryItem");
    expect(shopUpdates).toContainEqual(
      expect.objectContaining({ syncStage: "Importing products (no cost access)" }),
    );
  });

  it("records a variant with no measured cost as estimated, not as free", async () => {
    const admin = scriptedAdmin({
      products: [
        productPage(
          [
            {
              ...DEFAULT_PRODUCTS[0],
              variants: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [variantNode("11", "48.00"), variantNode("12", null)],
              },
            },
          ],
          null,
        ),
      ],
    });

    await runBackfill("shop_1", admin);

    // The distinction the whole margin rests on: a cost Shopify measured, and
    // a cost nobody knows. Both are stored, and only one is trusted.
    expect(variantUpserts[0]).toMatchObject({
      unitCost: "48.00",
      costSource: CostSource.SHOPIFY,
    });
    expect(variantUpserts[1]).toMatchObject({
      unitCost: null,
      costSource: CostSource.ESTIMATED,
    });
  });
});

describe("runBackfill: the admin client's expiring token", () => {
  it("re-acquires the session once the token is old, and keeps importing", async () => {
    // Offline access tokens expire after about an hour now. The client built
    // in `afterAuth` closes over one frozen Session, so on a store whose
    // import runs past that every later request fails authentication and the
    // run stops with a plausible-looking partial dataset.
    const replacement = scriptedAdmin({ advanceMsPerCall: 0 });
    unauthenticatedAdmin.mockResolvedValue({ admin: replacement });

    const original = scriptedAdmin({ advanceMsPerCall: ADMIN_CLIENT_MAX_AGE_MS / 2 + 1_000 });

    const result = await runBackfill("shop_1", original);

    expect(unauthenticatedAdmin).toHaveBeenCalledWith("northwind.myshopify.com");
    // Two requests on the original client take it past the age limit; the
    // third is served by the refreshed one.
    expect(original.operations).toEqual(["MeridianShop", "MeridianProducts"]);
    expect(replacement.operations).toEqual(["MeridianOrders"]);
    expect(result.orders).toBe(1);
  });

  it("keeps the current client when the session cannot be refreshed", async () => {
    // The token in hand may still be good, and if it is not the next request
    // fails with a clearer error than an aborted import would give.
    unauthenticatedAdmin.mockRejectedValue(new Error("no offline session stored"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const original = scriptedAdmin({ advanceMsPerCall: ADMIN_CLIENT_MAX_AGE_MS / 2 + 1_000 });

    const result = await runBackfill("shop_1", original);

    expect(result.orders).toBe(1);
    expect(original.operations).toEqual([
      "MeridianShop",
      "MeridianProducts",
      "MeridianOrders",
    ]);
    // And it must not re-try the refresh on every subsequent request either.
    expect(unauthenticatedAdmin).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("runBackfill: what one order writes", () => {
  const lineItem = (id: string, variantId: string | null, quantity: number) => ({
    id: `gid://shopify/LineItem/${id}`,
    title: `Line ${id}`,
    sku: `SKU-${id}`,
    quantity,
    originalUnitPriceSet: { shopMoney: { amount: "120.00" } },
    totalDiscountSet: { shopMoney: { amount: "5.00" } },
    variant: variantId ? { id: `gid://shopify/ProductVariant/${variantId}` } : null,
    product: { id: "gid://shopify/Product/1" },
  });

  it("sums a line item's refunded units across every refund that touched it", async () => {
    // A line refunded twice — partially, then the rest. Overwriting rather
    // than adding leaves the order looking mostly unrefunded, and refunds are
    // subtracted from revenue before profit.
    const admin = scriptedAdmin({
      orders: [
        orderPage(
          [
            orderNode("1001", {
              lineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [lineItem("1", "11", 5)],
              },
              refunds: [
                {
                  id: "gid://shopify/Refund/1",
                  refundLineItems: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ quantity: 2, lineItem: { id: "gid://shopify/LineItem/1" } }],
                  },
                },
                {
                  id: "gid://shopify/Refund/2",
                  refundLineItems: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ quantity: 1, lineItem: { id: "gid://shopify/LineItem/1" } }],
                  },
                },
              ],
            }),
          ],
          null,
        ),
      ],
    });

    await runBackfill("shop_1", admin);

    expect(lineItemsCreated).toHaveLength(1);
    expect(lineItemsCreated[0]).toMatchObject({ quantity: 5, refundedQty: 3 });
  });

  it("snapshots the variant's cost, and zero when the variant is unknown", async () => {
    storedVariants.push({
      id: "variant_row_11",
      shopifyId: "gid://shopify/ProductVariant/11",
      productId: "product_row",
      unitCost: "48.00",
    });

    const admin = scriptedAdmin({
      orders: [
        orderPage(
          [
            orderNode("1001", {
              lineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [lineItem("1", "11", 1), lineItem("2", "99", 1)],
              },
            }),
          ],
          null,
        ),
      ],
    });

    await runBackfill("shop_1", admin);

    // Frozen here so a later cost change cannot rewrite this order's profit.
    expect(lineItemsCreated[0]).toMatchObject({
      variantId: "variant_row_11",
      productId: "product_row",
      unitCost: "48.00",
    });
    // A line whose variant was never imported gets "0", which the engine reads
    // as unknown rather than as free — the alternative is a 100% margin.
    expect(lineItemsCreated[1]).toMatchObject({ variantId: null, unitCost: "0" });
  });

  it("settles the first order per customer shop-wide rather than from this run", async () => {
    // `firstOrderSeen` only knows the orders this pass walked. A resumed run,
    // one that stopped at the cap, or a shop whose webhooks already wrote
    // newer orders sees a slice of the customer and would over-flag.
    await runBackfill("shop_1", scriptedAdmin());

    expect(reconcileFirstOrdersForShop).toHaveBeenCalledWith("shop_1");
  });
});

describe("backfillIsStale", () => {
  const at = (iso: string) => new Date(iso);

  it("gives up on an import still running an hour later", () => {
    // The process that owned it is gone; without this the merchant watches a
    // spinner for ever and can never start another import.
    expect(
      backfillIsStale({
        syncStatus: SyncStatus.RUNNING,
        syncStartedAt: at("2026-08-06T07:30:00Z"),
      }),
    ).toBe(true);
  });

  it("leaves an import that is merely slow alone", () => {
    expect(
      backfillIsStale({
        syncStatus: SyncStatus.RUNNING,
        syncStartedAt: at("2026-08-06T08:30:00Z"),
      }),
    ).toBe(false);
  });

  it("treats a running import with no start time as abandoned", () => {
    expect(
      backfillIsStale({ syncStatus: SyncStatus.RUNNING, syncStartedAt: null }),
    ).toBe(true);
  });

  it("says nothing about an import that is not running", () => {
    for (const syncStatus of [SyncStatus.COMPLETE, SyncStatus.FAILED, SyncStatus.PENDING]) {
      expect(backfillIsStale({ syncStatus, syncStartedAt: null })).toBe(false);
    }
  });
});
