import { SyncStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The import stored a resume point after every page and never read it back, so
 * an interrupted walk began again at the store's first order — the cost fell
 * entirely on the stores whose imports are long enough to be interrupted.
 *
 * These drive the order walk against a scripted admin client and a fake Shop
 * row, because the whole defect is about which cursor the *first* request of a
 * run carries and what the run believes it has already seen.
 */

const shopRow = {
  id: "shop_1",
  syncedOrders: 0,
  syncCursor: null as string | null,
};

const oldestStoredOrder = { value: null as Date | null };

const prismaMock = {
  shop: {
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(shopRow, data);
      return shopRow;
    }),
  },
  order: {
    aggregate: vi.fn(async () => ({
      _min: { processedAt: oldestStoredOrder.value },
    })),
    upsert: vi.fn(async () => ({ id: "order_row" })),
  },
  customer: { upsert: vi.fn(async () => ({ id: "customer_row" })) },
  variant: { findMany: vi.fn(async () => []) },
  orderLineItem: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
  fulfillment: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
};

vi.mock("~/db.server", () => ({ default: prismaMock }));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
  loadStrategicProductIds: vi.fn(),
}));
vi.mock("~/lib/pricing.server", () => ({ generatePricingRecommendations: vi.fn() }));
vi.mock("~/lib/recompute.server", () => ({ recomputeShopProfitability: vi.fn() }));
vi.mock("~/lib/sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sync.server")>()),
  reconcileFirstOrdersForShop: vi.fn(async () => 0),
}));

const { importOrders, isInvalidCursorError, resumePointFor } = await import(
  "./backfill.server"
);

const capabilities = {
  orders: true,
  products: true,
  customers: false,
  fulfillments: false,
  inventoryCost: true,
};

const ok = (data: unknown) => ({ json: async () => ({ data }) }) as unknown as Response;

function orderNode(id: string, processedAt: string) {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    processedAt,
    createdAt: processedAt,
    currencyCode: "USD",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    refunds: [],
  };
}

/**
 * A store of three pages. `pages[cursor]` is what Shopify answers for a request
 * carrying that cursor, so asking for the wrong one is a test failure rather
 * than a silently identical answer.
 */
const pages: Record<string, { nodes: ReturnType<typeof orderNode>[]; next: string | null }> = {
  START: { nodes: [orderNode("1", "2023-01-05T00:00:00Z")], next: "cursor_p1" },
  cursor_p1: { nodes: [orderNode("2", "2026-07-01T00:00:00Z")], next: "cursor_p2" },
  cursor_p2: { nodes: [orderNode("3", "2026-07-02T00:00:00Z")], next: null },
};

function scriptedAdmin(options: { rejectCursor?: string } = {}) {
  const requested: (string | null)[] = [];

  return {
    requested,
    graphql: vi.fn(
      async (_query: string, call?: { variables?: Record<string, unknown> }) => {
        const cursor = (call?.variables?.cursor ?? null) as string | null;
        requested.push(cursor);

        if (options.rejectCursor && cursor === options.rejectCursor) {
          throw new Error("Shopify GraphQL: Invalid cursor.");
        }

        const page = pages[cursor ?? "START"];
        if (!page) throw new Error(`test: no page scripted for cursor ${cursor}`);

        return ok({
          orders: {
            pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
            nodes: page.nodes,
          },
        });
      },
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  shopRow.syncedOrders = 0;
  shopRow.syncCursor = null;
  oldestStoredOrder.value = null;
});

describe("resumePointFor", () => {
  const base = { syncCursor: "cursor_p1", syncedOrders: 40 };

  it("resumes an import that was left running", () => {
    expect(resumePointFor({ ...base, syncStatus: SyncStatus.RUNNING })).toEqual({
      cursor: "cursor_p1",
      importedOrders: 40,
    });
  });

  it("resumes an import that failed partway", () => {
    expect(resumePointFor({ ...base, syncStatus: SyncStatus.FAILED })).toEqual({
      cursor: "cursor_p1",
      importedOrders: 40,
    });
  });

  it("does not resume a finished import — a re-sync must re-read the store", () => {
    expect(resumePointFor({ ...base, syncStatus: SyncStatus.COMPLETE })).toBeNull();
  });

  it("does not resume when the scopes changed, because the query has changed", () => {
    expect(resumePointFor({ ...base, syncStatus: SyncStatus.PENDING })).toBeNull();
  });

  it("has nothing to resume from without a stored cursor", () => {
    expect(
      resumePointFor({ syncCursor: null, syncedOrders: 40, syncStatus: SyncStatus.FAILED }),
    ).toBeNull();
  });
});

describe("order import resume", () => {
  it("starts a fresh import at the first page and asks for no stored history", async () => {
    const admin = scriptedAdmin();

    const result = await importOrders("shop_1", admin, capabilities, null);

    expect(admin.requested).toEqual([null, "cursor_p1", "cursor_p2"]);
    expect(result.count).toBe(3);
    expect(prismaMock.order.aggregate).not.toHaveBeenCalled();
  });

  it("picks the walk up at the stored cursor instead of the first page", async () => {
    const admin = scriptedAdmin();
    oldestStoredOrder.value = new Date("2023-01-05T00:00:00Z");

    const result = await importOrders("shop_1", admin, capabilities, {
      cursor: "cursor_p1",
      importedOrders: 1,
    });

    // The whole point: the first request carries the cursor, and page one —
    // the 12,000 orders that were already imported — is never fetched again.
    expect(admin.requested).toEqual(["cursor_p1", "cursor_p2"]);
    expect(admin.requested).not.toContain(null);
    // Two new orders on top of the one the interrupted run had already stored,
    // so MAX_ORDERS stays a total rather than becoming a per-attempt cap.
    expect(result.count).toBe(3);
    expect(shopRow.syncedOrders).toBe(3);
  });

  it("keeps the store's real history when it resumes past the oldest order", async () => {
    const admin = scriptedAdmin();
    oldestStoredOrder.value = new Date("2023-01-05T00:00:00Z");

    const result = await importOrders("shop_1", admin, capabilities, {
      cursor: "cursor_p1",
      importedOrders: 1,
    });

    // Orders are walked oldest-first, so everything old is behind the cursor.
    // Read from the pages alone this would report the store as having begun
    // trading in July 2026 and — via hasAllOrdersScope — claim there was
    // nothing before it.
    expect(result.earliestOrderAt).toEqual(new Date("2023-01-05T00:00:00Z"));
    expect(result.sawOrdersOlderThan60Days).toBe(true);
  });

  it("falls back to a full walk when Shopify rejects the stored cursor", async () => {
    const admin = scriptedAdmin({ rejectCursor: "cursor_stale" });
    oldestStoredOrder.value = new Date("2023-01-05T00:00:00Z");

    const result = await importOrders("shop_1", admin, capabilities, {
      cursor: "cursor_stale",
      importedOrders: 99,
    });

    // Rejected, then restarted from the beginning — otherwise every retry for
    // ever resumes from the same dead cursor and fails in the same place.
    expect(admin.requested).toEqual(["cursor_stale", null, "cursor_p1", "cursor_p2"]);
    // Counted from scratch, because the walk was from scratch.
    expect(result.count).toBe(3);
    expect(result.earliestOrderAt).toEqual(new Date("2023-01-05T00:00:00Z"));
  });

  it("does not mistake a genuine failure for a bad cursor", () => {
    expect(isInvalidCursorError(new Error("Shopify GraphQL: Invalid cursor."))).toBe(true);
    expect(isInvalidCursorError(new Error("Shopify GraphQL: Internal error."))).toBe(false);
  });
});
