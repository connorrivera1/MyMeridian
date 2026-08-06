import { describe, expect, it, vi } from "vitest";

/**
 * Cover for the raw statements `recompute` writes its results back through.
 *
 * Prisma is mocked rather than hit, in the house style — the assertions here are
 * about the SQL these functions *generate*, which is exactly where the defect
 * they cover lived. The behaviour itself was proved separately against real
 * Postgres inside a rolled-back transaction, because no mock can tell you how a
 * server casts a bound `Date`.
 *
 * `writeCustomerAggregates` cast a bound `Date` straight to `::timestamp` when
 * writing `Customer.firstOrderAt`. That renders the instant in the *session*
 * time zone and then discards the offset, so the stored value was shifted by
 * whatever `TimeZone` the connection had — and shifted by a different amount
 * either side of a DST transition. Measured against the live database on this
 * machine (`America/New_York`): −5h on 2026-03-01, −4h on 2026-03-15, against a
 * Prisma ORM write of the same instant landing at exactly 0h.
 *
 * Every other writer of that column — `syncCustomer`, `reconcileFirstOrder`, the
 * backfill and the seed — goes through Prisma and stores UTC. So this was one
 * column with two writers and two meanings, the same shape as the `shippedAt`
 * defect: `reconcileFirstOrder` would settle a customer's first order and the
 * next `recompute` would quietly move it.
 */

const executeRawCalls: unknown[][] = [];
const shopFindUniqueOrThrow = vi.fn();
const shopUpdate = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUniqueOrThrow: (...args: unknown[]) => shopFindUniqueOrThrow(...args),
      update: (...args: unknown[]) => shopUpdate(...args),
    },
    $executeRaw: (...args: unknown[]) => {
      executeRawCalls.push(args);
      return Promise.resolve(1);
    },
  },
}));

vi.mock("~/data/queries.server", () => ({
  loadEngineOrders: vi.fn().mockResolvedValue([
    {
      id: "order_1",
      orderNumber: 1001,
      processedAt: new Date("2026-03-15T02:30:00.000Z"),
      customerId: "cust_1",
      channel: "GOOGLE",
      campaignId: null,
      isFirstOrder: true,
      subtotalCents: 10000,
      discountTotalCents: 0,
      shippingChargedCents: 0,
      taxTotalCents: 0,
      totalCents: 10000,
      refundedTotalCents: 0,
      actualShippingCostCents: null,
      actualPickPackCostCents: null,
      lineItems: [],
    },
  ]),
  loadAdSpend: vi.fn().mockResolvedValue([]),
  loadCostRules: vi.fn().mockResolvedValue({
    paymentPercentRate: 0,
    paymentFixedPerOrderCents: 0,
    shippingDefaultPerOrderCents: 0,
    pickPackPerOrderCents: 0,
    pickPackPerItemCents: 0,
    monthlyOverheadCents: 0,
  }),
}));

const { recomputeShopProfitability } = await import("./recompute.server");
const { loadAdSpend, loadEngineOrders } = await import("~/data/queries.server");

/** Flatten a tagged-template call into the SQL text it would send. */
function sqlTextOf(call: unknown[]): string {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return strings
    .map((part, i) => {
      const value = values[i];
      // Nested `Prisma.sql` fragments carry their own template strings.
      const nested =
        value && typeof value === "object" && "strings" in (value as object)
          ? (value as { strings: readonly string[] }).strings.join("?")
          : "";
      return part + nested;
    })
    .join("");
}

async function runRecompute() {
  executeRawCalls.length = 0;
  vi.mocked(loadEngineOrders).mockClear();
  vi.mocked(loadAdSpend).mockClear();
  shopFindUniqueOrThrow.mockResolvedValue({
    id: "shop_1",
    timezone: "America/Los_Angeles",
  });
  shopUpdate.mockResolvedValue({});
  await recomputeShopProfitability("shop_1");
  return executeRawCalls.map(sqlTextOf);
}

describe("recompute is whole-history by construction", () => {
  /**
   * `writeCustomerAggregates` rolls `ordersCount`, `lifetimeRevenue`,
   * `lifetimeProfit` and `firstOrderAt` out of the orders this run loaded, and
   * writes them under lifetime names. That is only true if the run loaded the
   * customer's whole history. `recomputeShopProfitability` used to take an
   * optional `range` — unused by all four callers, but public, optional, and
   * shaped exactly like a safe incremental-update knob. Passing one would have
   * written window totals under a lifetime label and dragged `firstOrderAt`
   * forward to the earliest order in the window, undoing `reconcileFirstOrder`
   * on the very column the timestamptz fix below exists to protect.
   */

  it("takes only a shop id — no range parameter to pass by mistake", () => {
    expect(recomputeShopProfitability.length).toBe(1);
  });

  it("loads orders and spend from the epoch, not from a window", async () => {
    await runRecompute();

    for (const loader of [loadEngineOrders, loadAdSpend]) {
      const [shopId, range] = vi.mocked(loader).mock.calls[0] as [string, { from: Date; to: Date }];
      expect(shopId).toBe("shop_1");
      expect(range.from.getTime()).toBe(0);
      // `to` reaches past now, so an order processed moments ago is still in.
      expect(range.to.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("passes the same range to every loader, so aggregates cannot straddle windows", async () => {
    await runRecompute();

    const orderRange = vi.mocked(loadEngineOrders).mock.calls[0]![1];
    const spendRange = vi.mocked(loadAdSpend).mock.calls[0]![1];

    expect(orderRange.from.getTime()).toBe(spendRange.from.getTime());
    expect(orderRange.to.getTime()).toBe(spendRange.to.getTime());
  });
});

describe("writeCustomerAggregates timestamp binding", () => {
  it("casts firstOrderAt through timestamptz and back to UTC", async () => {
    const statements = await runRecompute();
    const customerWrite = statements.find((s) => s.includes('"firstOrderAt"'));

    expect(customerWrite).toBeDefined();
    expect(customerWrite).toContain("::timestamptz AT TIME ZONE 'UTC'");
  });

  it("never casts a bound Date straight to ::timestamp", async () => {
    const statements = await runRecompute();
    const customerWrite = statements.find((s) => s.includes('"firstOrderAt"'))!;

    // The bug was a single missing `tz`. `::timestamp` immediately followed by
    // anything other than `tz` is the shape that silently drops the offset.
    expect(customerWrite).not.toMatch(/::timestamp(?!tz)/);
  });

  it("still writes the other customer aggregate columns", async () => {
    const statements = await runRecompute();
    const customerWrite = statements.find((s) => s.includes('"firstOrderAt"'))!;

    for (const column of ['"ordersCount"', '"lifetimeRevenue"', '"lifetimeProfit"']) {
      expect(customerWrite).toContain(column);
    }
    // The write stays scoped to the shop — a VALUES join with no shop predicate
    // would let one shop's recompute update another's customer row.
    expect(customerWrite).toContain('c."shopId"');
  });

  it("leaves the order profit write on server-side NOW() for computedAt", async () => {
    const statements = await runRecompute();
    const orderWrite = statements.find((s) => s.includes('"netProfit"'));

    expect(orderWrite).toBeDefined();
    // `computedAt` is the one timestamp here that is not a bound Date, so it
    // never had the offset problem and should stay as it is.
    expect(orderWrite).toContain('"computedAt"         = NOW()');
    expect(orderWrite).not.toMatch(/::timestamp(?!tz)/);
  });
});
