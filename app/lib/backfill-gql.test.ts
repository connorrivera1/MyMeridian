import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
  loadStrategicProductIds: vi.fn(),
}));
vi.mock("~/lib/pricing.server", () => ({ generatePricingRecommendations: vi.fn() }));
vi.mock("~/lib/recompute.server", () => ({ recomputeShopProfitability: vi.fn() }));

const { gql, ShopifyFieldError } = await import("./backfill.server");

/**
 * Shopify answers HTTP 200 for THROTTLED and for access-denied, and the client
 * library turns a 200-with-errors into a thrown GraphqlQueryError rather than a
 * resolved response. `gql` used to inspect only the resolved body, so its
 * throttle backoff and its field-error classification were both unreachable:
 * the first throttle on a real store's import failed the whole backfill, and
 * the customerJourneySummary capability probe could never degrade gracefully.
 *
 * These drive `gql` with the error shapes the library actually throws.
 */

/** What throwFailedRequest raises for a 200 carrying GraphQL errors. */
function graphqlQueryError(errors: { message: string; extensions?: { code?: string } }[]) {
  const error = new Error(errors[0]?.message ?? "GraphQL operation failed");
  Object.assign(error, { body: { errors: { graphQLErrors: errors } } });
  return error;
}

const ok = (data: unknown) =>
  ({ json: async () => ({ data }) }) as unknown as Response;

function adminThatThrows(sequence: unknown[]) {
  let call = 0;
  return {
    calls: () => call,
    graphql: vi.fn(async () => {
      const next = sequence[call++];
      if (next instanceof Error) throw next;
      return ok(next);
    }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Let the backoff sleeps elapse while the promise is in flight. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const raced = promise.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  await vi.advanceTimersByTimeAsync(120_000);
  const result = await raced;
  if (result.ok) return result.v;
  throw result.e;
}

describe("gql throttle handling", () => {
  it("retries a thrown THROTTLED error and succeeds", async () => {
    const admin = adminThatThrows([
      graphqlQueryError([{ message: "Throttled", extensions: { code: "THROTTLED" } }]),
      graphqlQueryError([{ message: "Throttled", extensions: { code: "THROTTLED" } }]),
      { shop: { name: "Northwind" } },
    ]);

    const data = await settle(gql<{ shop: { name: string } }>(admin, "query {}"));

    expect(data.shop.name).toBe("Northwind");
    expect(admin.calls()).toBe(3);
  });

  it("treats an HTTP 429 throttling error as throttled too", async () => {
    class HttpThrottlingError extends Error {}
    const admin = adminThatThrows([
      new HttpThrottlingError("Shopify is throttling requests"),
      { shop: { name: "Northwind" } },
    ]);

    await expect(settle(gql(admin, "query {}"))).resolves.toBeTruthy();
    expect(admin.calls()).toBe(2);
  });

  it("gives up after the retry budget rather than looping", async () => {
    const throttle = () =>
      graphqlQueryError([{ message: "Throttled", extensions: { code: "THROTTLED" } }]);
    const admin = adminThatThrows(Array.from({ length: 20 }, throttle));

    await expect(settle(gql(admin, "query {}"))).rejects.toThrow(/Throttled/);
    expect(admin.calls()).toBe(7); // initial attempt + 6 retries
  });
});

describe("gql field-error classification", () => {
  it("classifies a thrown access-denied as a capability difference", async () => {
    // This is what a store without customerJourneySummary access returns. It
    // must become ShopifyFieldError so the caller can retry with a narrower
    // query instead of failing the entire import.
    const admin = adminThatThrows([
      graphqlQueryError([
        {
          message: "Access denied for customerJourneySummary field.",
          extensions: { code: "ACCESS_DENIED" },
        },
      ]),
    ]);

    await expect(settle(gql(admin, "query {}"))).rejects.toBeInstanceOf(
      ShopifyFieldError,
    );
  });

  it("classifies a thrown unknown-field error the same way", async () => {
    const admin = adminThatThrows([
      graphqlQueryError([{ message: "Field 'unitCost' doesn't exist on type" }]),
    ]);

    await expect(settle(gql(admin, "query {}"))).rejects.toBeInstanceOf(
      ShopifyFieldError,
    );
  });

  it("still fails loudly on an error that is neither", async () => {
    const admin = adminThatThrows([
      graphqlQueryError([{ message: "Something else went wrong" }]),
    ]);

    const failure = settle(gql(admin, "query {}"));
    await expect(failure).rejects.toThrow(/Something else went wrong/);
    await expect(failure).rejects.not.toBeInstanceOf(ShopifyFieldError);
  });

  it("does not retry a response that resolved with no data", async () => {
    const admin = adminThatThrows([{ shop: null }, { shop: null }]);
    // `{ data: { shop: null } }` is data, so this resolves; the guard is for a
    // body with no `data` key at all.
    await expect(settle(gql(admin, "query {}"))).resolves.toEqual({ shop: null });
    expect(admin.calls()).toBe(1);
  });
});
