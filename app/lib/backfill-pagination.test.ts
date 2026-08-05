import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
  loadStrategicProductIds: vi.fn(),
}));
vi.mock("~/lib/pricing.server", () => ({ generatePricingRecommendations: vi.fn() }));
vi.mock("~/lib/recompute.server", () => ({ recomputeShopProfitability: vi.fn() }));

const { hydrateOrderOverflow, remainingVariants } = await import("./backfill.server");

/**
 * Every child collection in the import used to be requested with a fixed
 * `first:` and no `hasNextPage` check, so the overflow was dropped without a
 * word. Both failures pointed the same way: missing variants and missing line
 * items both remove cost, and removed cost reads as margin. A 120-variant
 * product reported 100% margin on 20 of its variants, and an 80-line wholesale
 * order lost roughly 40% of its COGS.
 *
 * These drive the two follow-up walks against a scripted admin client.
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

const variant = (id: string) => ({
  id,
  sku: id,
  title: id,
  price: "10.00",
  compareAtPrice: null,
  inventoryQuantity: 1,
  inventoryItem: { unitCost: { amount: "4.00" } },
});

describe("variant pagination", () => {
  it("walks every remaining page for one product", async () => {
    const admin = adminReturning([
      {
        product: {
          variants: {
            pageInfo: { hasNextPage: true, endCursor: "c2" },
            nodes: [variant("v101"), variant("v102")],
          },
        },
      },
      {
        product: {
          variants: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [variant("v103")],
          },
        },
      },
    ]);

    const rest = await remainingVariants(admin, true, "gid://shopify/Product/1", "c1");

    expect(rest.map((v) => v.id)).toEqual(["v101", "v102", "v103"]);
    expect(admin.calls()).toBe(2);
    // Each request must resume from the previous page, not restart.
    expect(admin.variables[0]?.cursor).toBe("c1");
    expect(admin.variables[1]?.cursor).toBe("c2");
  });

  it("stops cleanly when the product has been deleted mid-import", async () => {
    const admin = adminReturning([{ product: null }]);

    await expect(
      remainingVariants(admin, true, "gid://shopify/Product/gone", "c1"),
    ).resolves.toEqual([]);
  });
});

const lineItem = (id: string) => ({
  id,
  title: id,
  sku: id,
  quantity: 1,
  originalUnitPriceSet: { shopMoney: { amount: "10.00" } },
  totalDiscountSet: { shopMoney: { amount: "0.00" } },
  variant: { id: `v-${id}` },
  product: { id: `p-${id}` },
});

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Order/1",
    lineItems: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [lineItem("li1")],
    },
    refunds: [],
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("order line item pagination", () => {
  it("appends the overflow pages to the order in place", async () => {
    const admin = adminReturning([
      {
        order: {
          lineItems: {
            pageInfo: { hasNextPage: true, endCursor: "c3" },
            nodes: [lineItem("li51")],
          },
        },
      },
      {
        order: {
          lineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [lineItem("li52")],
          },
        },
      },
    ]);

    const node = order({
      lineItems: {
        pageInfo: { hasNextPage: true, endCursor: "c2" },
        nodes: [lineItem("li1")],
      },
    });

    await hydrateOrderOverflow(admin, node);

    expect(node.lineItems.nodes.map((i: { id: string }) => i.id)).toEqual([
      "li1",
      "li51",
      "li52",
    ]);
  });

  it("makes no request at all when nothing overflowed", async () => {
    const admin = adminReturning([]);

    await hydrateOrderOverflow(admin, order());

    // The common case is a single-page order; it must not cost a round trip.
    expect(admin.calls()).toBe(0);
  });

  it("pages each refund's line items separately", async () => {
    const admin = adminReturning([
      {
        refund: {
          refundLineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ quantity: 2, lineItem: { id: "li51" } }],
          },
        },
      },
    ]);

    const node = order({
      refunds: [
        {
          id: "gid://shopify/Refund/9",
          refundLineItems: {
            pageInfo: { hasNextPage: true, endCursor: "c2" },
            nodes: [{ quantity: 1, lineItem: { id: "li1" } }],
          },
        },
      ],
    });

    await hydrateOrderOverflow(admin, node);

    expect(node.refunds[0].refundLineItems.nodes).toEqual([
      { quantity: 1, lineItem: { id: "li1" } },
      { quantity: 2, lineItem: { id: "li51" } },
    ]);
    // Refunds are queried by their own id, not the order's.
    expect(admin.variables[0]?.id).toBe("gid://shopify/Refund/9");
  });
});
