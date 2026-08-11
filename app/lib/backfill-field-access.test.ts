import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the order import does when Shopify refuses a field it asked for.
 *
 * The scopes a store grants and the protected-customer-data request approved
 * for the app are two separate permissions, so a field can be denied on a store
 * that granted everything Meridian asks for. Shopify says so with HTTP 200 and
 * an access-denied error naming the field, which `gql` turns into a
 * `ShopifyFieldError` for the caller to narrow its query and retry.
 *
 * The caller only ever narrowed one way: it assumed every field error was the
 * customer journey, and it only tried that when journey was still enabled.
 * Journey is enabled from `capabilities.customers`, and `read_customers` is not
 * among the four scopes in `shopify.app.toml` — so on every real store the flag
 * is false, and the whole recovery path was unreachable. Any refused field
 * aborted the entire import and left the merchant an empty dashboard.
 *
 * These drive `importOrders` against an admin client that refuses a named
 * field, because the defect is about which field the run stops asking for.
 */

const prismaMock = {
  shop: { update: vi.fn(async () => ({})) },
  order: {
    aggregate: vi.fn(async () => ({ _min: { processedAt: null } })),
    upsert: vi.fn(async () => ({ id: "order_row" })),
  },
  customer: { upsert: vi.fn(async () => ({ id: "customer_row" })) },
  variant: { findMany: vi.fn(async () => []) },
  orderLineItem: {
    deleteMany: vi.fn(async () => ({})),
    createMany: vi.fn(async () => ({})),
  },
  fulfillment: {
    deleteMany: vi.fn(async () => ({})),
    createMany: vi.fn(async () => ({})),
  },
};

/*
 * `withOrderLock` wraps the order's destructive writes in a transaction that
 * takes a Postgres advisory lock. A mock cannot emulate either — there is no
 * isolation and nothing to contend with — so the callback simply receives this
 * same client and the lock statement is a no-op. That keeps these tests
 * asserting what they were written to assert: the queries the import issues.
 *
 * The serialisation itself is therefore NOT covered here, and cannot be
 * without a real database. See order-lock.server.ts.
 */
Object.assign(prismaMock, {
  $transaction: (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(prismaMock)
      : Promise.all(arg as unknown[]),
  $executeRaw: vi.fn(async () => 0),
});

vi.mock("~/db.server", () => ({ default: prismaMock }));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
  loadStrategicProductIds: vi.fn(),
}));
vi.mock("~/lib/pricing.server", () => ({
  generatePricingRecommendations: vi.fn(),
}));
vi.mock("~/lib/recompute.server", () => ({
  recomputeShopProfitability: vi.fn(),
}));
vi.mock("~/lib/sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sync.server")>()),
  reconcileFirstOrdersForShop: vi.fn(async () => 0),
  syncOrderFromShopify: vi.fn(async () => ({ id: "order_row" })),
  syncFulfillmentFromShopify: vi.fn(async () => null),
}));

const { importOrders } = await import("./backfill.server");

/** A real store: every scope in the toml granted, and `read_customers` is not one. */
const realStore = {
  orders: true,
  products: true,
  customers: false,
  inventoryCost: true,
  fulfillments: true,
};

/** A store that also granted customer access, so journey is probed for. */
const withCustomers = { ...realStore, customers: true };

const ok = (data: unknown) =>
  ({ json: async () => ({ data }) }) as unknown as Response;

function orderNode(id: string) {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    processedAt: "2026-07-01T00:00:00Z",
    createdAt: "2026-07-01T00:00:00Z",
    currencyCode: "USD",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    refunds: [],
  };
}

/**
 * Shopify's own shape for a refused field: HTTP 200, and the client library
 * raises `GraphqlQueryError` carrying `body.errors.graphQLErrors`. `gql` reads
 * exactly that, so anything shallower would not reach `ShopifyFieldError`.
 */
function accessDenied(field: string) {
  return Object.assign(
    new Error(`GraphQL Client: Access denied for ${field} field.`),
    {
      body: {
        errors: {
          graphQLErrors: [{ message: `Access denied for ${field} field.` }],
        },
      },
    },
  );
}

/**
 * An admin that refuses `field` for as long as the query still asks for it, and
 * records the queries it was sent so the test can assert what was given up.
 */
function refusing(field: string, marker: string) {
  const queries: string[] = [];

  return {
    queries,
    graphql: vi.fn(async (query: string) => {
      queries.push(query);
      if (query.includes(marker)) throw accessDenied(field);

      return ok({
        orders: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [orderNode("1"), orderNode("2")],
        },
      });
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("importOrders when Shopify refuses a field", () => {
  it("drops fulfilments and still imports the orders", async () => {
    // The case that made this unreachable: a real store, so journey is off,
    // and the refused field is one the store did grant the scope for.
    const admin = refusing("fulfillments", "fulfillmentsCount");

    const result = await importOrders("shop_1", admin, realStore);

    expect(result.count).toBe(2);
    expect(admin.queries.at(-1)).not.toContain("fulfillmentsCount");
  });

  it("drops customer identity and still imports the orders", async () => {
    const admin = refusing("customer", "customer { id email }");

    const result = await importOrders("shop_1", admin, withCustomers);

    expect(result.count).toBe(2);
    expect(admin.queries.at(-1)).not.toContain("customer { id email }");
  });

  it("gives up the journey with customer access rather than asking twice", async () => {
    const admin = refusing("customer", "customer { id email }");

    const result = await importOrders("shop_1", admin, withCustomers);

    // Journey is a property of the same shopper. One refusal, one retry.
    expect(result.usedJourney).toBe(false);
    expect(admin.queries).toHaveLength(2);
    expect(admin.queries.at(-1)).not.toContain("customerJourneySummary");
  });

  it("still drops only the journey when only the journey is refused", async () => {
    const admin = refusing("customerJourneySummary", "customerJourneySummary");

    const result = await importOrders("shop_1", admin, withCustomers);

    expect(result.count).toBe(2);
    expect(result.usedJourney).toBe(false);
    // The narrower loss: customer identity survives a journey refusal.
    expect(admin.queries.at(-1)).toContain("customer { id email }");
  });

  it("names the field that was actually refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = refusing("fulfillments", "fulfillmentsCount");

    await importOrders("shop_1", admin, realStore);

    const message = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(message).toContain("fulfillments");
    expect(message).not.toContain("journey");
  });

  it("still fails on a field error that no optional group explains", async () => {
    // A refusal of something the import cannot do without is a real failure.
    // Degrading here would import a store's orders with no money on them.
    const admin = refusing("totalPriceSet", "totalPriceSet");

    await expect(importOrders("shop_1", admin, realStore)).rejects.toThrow(
      /totalPriceSet/,
    );
  });

  it("stops retrying once nothing optional is left to give up", async () => {
    // Every optional group refused in turn: three narrowings, then the throw.
    // Without a terminating condition this is an infinite request loop.
    const admin = {
      queries: [] as string[],
      graphql: vi.fn(async (query: string) => {
        admin.queries.push(query);
        throw accessDenied("customer");
      }),
    };

    await expect(
      importOrders("shop_1", admin, withCustomers),
    ).rejects.toThrow();
    // customers (which takes journey with it), then fulfillments, then out.
    expect(admin.queries.length).toBeLessThanOrEqual(4);
  });
});
