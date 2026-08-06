import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
  loadStrategicProductIds: vi.fn(),
}));
vi.mock("~/lib/pricing.server", () => ({ generatePricingRecommendations: vi.fn() }));
vi.mock("~/lib/recompute.server", () => ({ recomputeShopProfitability: vi.fn() }));

const { fulfillmentRowsForOrder, hydrateOrderOverflow } = await import("./backfill.server");

/**
 * The import wrote the fulfilment history the Fulfilment screen is built on,
 * and got three separate things wrong about it. Each of these drives one.
 *
 * `Order.fulfillments` is a list, not a connection, so its overflow cannot be
 * paged the way line items are — it has to be re-asked for, and the trigger is
 * `fulfillmentsCount`.
 */

const ok = (data: unknown) => ({ json: async () => ({ data }) }) as unknown as Response;

function adminReturning(pages: unknown[]) {
  let call = 0;
  const variables: Record<string, unknown>[] = [];

  return {
    variables,
    calls: () => call,
    graphql: vi.fn(async (_query: string, options?: { variables?: Record<string, unknown> }) => {
      variables.push(options?.variables ?? {});
      return ok(pages[call++]);
    }),
  };
}

const fulfillment = (
  id: string,
  overrides: Partial<{
    createdAt: string;
    status: string | null;
    totalQuantity: number | null;
    company: string | null;
  }> = {},
) => ({
  id,
  createdAt: overrides.createdAt ?? "2026-03-01T10:00:00Z",
  status: overrides.status === undefined ? "success" : overrides.status,
  totalQuantity: overrides.totalQuantity === undefined ? 1 : overrides.totalQuantity,
  trackingInfo: [{ company: overrides.company ?? null }],
});

/** An order node carrying only what these paths read. */
const orderNode = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "gid://shopify/Order/1",
    lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    refunds: [],
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("fulfilment rows written by the import", () => {
  it("gives each shipment its own units, not the whole order's", () => {
    // A 12-unit order sent in three parcels. The old code summed the order's
    // line items and wrote that total onto every parcel: 36 units shipped.
    const rows = fulfillmentRowsForOrder("shop_1", "order_1", [
      fulfillment("gid://shopify/Fulfillment/1", { totalQuantity: 5 }),
      fulfillment("gid://shopify/Fulfillment/2", { totalQuantity: 4 }),
      fulfillment("gid://shopify/Fulfillment/3", { totalQuantity: 3 }),
    ]);

    expect(rows.map((r) => r.itemCount)).toEqual([5, 4, 3]);
    expect(rows.reduce((sum, r) => sum + r.itemCount, 0)).toBe(12);
  });

  it("leaves a cancelled shipment with no shippedAt", () => {
    const rows = fulfillmentRowsForOrder("shop_1", "order_1", [
      fulfillment("gid://shopify/Fulfillment/1", { status: "cancelled" }),
      fulfillment("gid://shopify/Fulfillment/2", { status: "failure" }),
      fulfillment("gid://shopify/Fulfillment/3", { status: "success" }),
    ]);

    expect(rows[0]!.shippedAt).toBeNull();
    expect(rows[1]!.shippedAt).toBeNull();
    expect(rows[2]!.shippedAt).toEqual(new Date("2026-03-01T10:00:00Z"));

    // createdAt is when Shopify made the record and stays either way.
    expect(rows[0]!.createdAt).toEqual(new Date("2026-03-01T10:00:00Z"));
  });

  it("carries Shopify's id and the carrier through unchanged", () => {
    const [row] = fulfillmentRowsForOrder("shop_1", "order_1", [
      fulfillment("gid://shopify/Fulfillment/9", { company: "FedEx" }),
    ]);

    expect(row).toMatchObject({
      shopId: "shop_1",
      orderId: "order_1",
      shopifyId: "gid://shopify/Fulfillment/9",
      status: "success",
      carrier: "FedEx",
      shippingCost: "0.00",
      pickPackCost: "0.00",
    });
  });

  it("treats a missing status as shipped and a missing quantity as none", () => {
    const [row] = fulfillmentRowsForOrder("shop_1", "order_1", [
      fulfillment("gid://shopify/Fulfillment/1", { status: null, totalQuantity: null }),
    ]);

    expect(row!.status).toBe("success");
    expect(row!.shippedAt).not.toBeNull();
    expect(row!.itemCount).toBe(0);
  });
});

describe("fulfilment truncation", () => {
  it("refetches an order whose shipments the page truncated", async () => {
    const held = Array.from({ length: 10 }, (_, i) =>
      fulfillment(`gid://shopify/Fulfillment/${i + 1}`),
    );
    const all = Array.from({ length: 14 }, (_, i) =>
      fulfillment(`gid://shopify/Fulfillment/${i + 1}`),
    );

    const admin = adminReturning([{ order: { fulfillments: all } }]);
    const node = orderNode({
      fulfillments: held,
      fulfillmentsCount: { count: 14, precision: "EXACT" },
    });

    await hydrateOrderOverflow(admin, node);

    expect(admin.calls()).toBe(1);
    expect(admin.variables[0]).toMatchObject({
      id: "gid://shopify/Order/1",
      pageSize: 250,
    });
    expect(node.fulfillments).toHaveLength(14);
  });

  it("makes no request when the page already held every shipment", async () => {
    const admin = adminReturning([]);
    const node = orderNode({
      fulfillments: [fulfillment("gid://shopify/Fulfillment/1")],
      fulfillmentsCount: { count: 1, precision: "EXACT" },
    });

    await hydrateOrderOverflow(admin, node);

    expect(admin.calls()).toBe(0);
    expect(node.fulfillments).toHaveLength(1);
  });

  it("refetches when the count is not exact, rather than trusting it", async () => {
    const admin = adminReturning([
      { order: { fulfillments: [fulfillment("f1"), fulfillment("f2")] } },
    ]);
    const node = orderNode({
      fulfillments: [fulfillment("f1")],
      fulfillmentsCount: { count: 1, precision: "AT_LEAST" },
    });

    await hydrateOrderOverflow(admin, node);

    expect(admin.calls()).toBe(1);
    expect(node.fulfillments).toHaveLength(2);
  });

  it("asks for nothing when fulfilment access was not granted", async () => {
    const admin = adminReturning([]);
    // No `fulfillments` and no count: the shape when read_fulfillments is absent.
    const node = orderNode({});

    await hydrateOrderOverflow(admin, node);

    expect(admin.calls()).toBe(0);
  });

  it("keeps the shipments it has when the order was deleted mid-import", async () => {
    const admin = adminReturning([{ order: null }]);
    const node = orderNode({
      fulfillments: [fulfillment("f1")],
      fulfillmentsCount: { count: 12, precision: "EXACT" },
    });

    await hydrateOrderOverflow(admin, node);

    expect(admin.calls()).toBe(1);
    expect(node.fulfillments).toHaveLength(1);
  });
});
