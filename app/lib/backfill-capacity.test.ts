import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRawCalls: { sql: string; values: unknown[] }[] = [];
let receivedRows: { day: Date; count: bigint }[] = [];
let shippedOrderRows: { day: Date; count: bigint }[] = [];
let shippedUnitRows: { day: Date; units: bigint }[] = [];

const deleteMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const createMany = vi.fn(async (_args: { data: unknown[] }) => ({ count: 0 }));
let shopTimezone: string | null = "America/Los_Angeles";

/** Flatten a tagged-template call, including any nested `Prisma.sql` fragments. */
function sqlTextOf(strings: readonly string[], values: unknown[]): string {
  return strings
    .map((part, i) => {
      const value = values[i];
      const nested =
        value && typeof value === "object" && "strings" in (value as object)
          ? (value as { strings: readonly string[] }).strings.join("?")
          : "";
      return part + nested;
    })
    .join("");
}

/** Every bound value, including those carried by nested fragments. */
function boundValues(values: unknown[]): unknown[] {
  return values.flatMap((value) =>
    value && typeof value === "object" && "values" in (value as object)
      ? (value as { values: unknown[] }).values
      : [value],
  );
}

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUniqueOrThrow: () => Promise.resolve({ timezone: shopTimezone }),
    },
    $queryRaw: (strings: readonly string[], ...values: unknown[]) => {
      const sql = sqlTextOf(strings, values);
      queryRawCalls.push({ sql, values: boundValues(values) });

      if (sql.includes('COUNT(*)') && sql.includes('"Order"')) {
        return Promise.resolve(receivedRows);
      }
      if (sql.includes("last_shipped")) return Promise.resolve(shippedOrderRows);
      return Promise.resolve(shippedUnitRows);
    },
    capacityDay: {
      deleteMany: (args: unknown) => deleteMany(args),
      createMany: (args: { data: unknown[] }) => createMany(args),
    },
  },
}));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
  loadStrategicProductIds: vi.fn(),
}));
vi.mock("~/lib/pricing.server", () => ({ generatePricingRecommendations: vi.fn() }));
vi.mock("~/lib/recompute.server", () => ({ recomputeShopProfitability: vi.fn() }));

const { rebuildCapacityDays } = await import("./backfill.server");

/**
 * The three raw statements the Fulfilment screen's whole history is built from.
 *
 * `rebuildCapacityDays` is where the split-shipment rule actually lives. An
 * order sent in three parcels used to be counted as three orders fulfilled,
 * which inflated throughput, deflated the backlog, and raised the observed
 * capacity ceiling every alert on that screen is measured against. The fix is a
 * `MAX("shippedAt") GROUP BY "orderId"` subquery, and until now nothing held it
 * in place — the rows it writes had no test at all.
 *
 * Prisma is mocked in the house style. These assertions are about the SQL these
 * statements generate and the arithmetic done on their results, which is where
 * every defect in this function has been.
 */

/** UTC midnight, `n` days before today — the shape `date_trunc('day', …)` returns. */
function day(n: number): Date {
  const today = new Date();
  return new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
      n * 86_400_000,
  );
}

const key = (d: Date) => d.toISOString().slice(0, 10);

type CapacityRow = {
  shopId: string;
  date: Date;
  ordersReceived: number;
  ordersFulfilled: number;
  unitsFulfilled: number;
  backlogEnd: number;
  maxDailyCapacity: number;
};

/** Every row handed to `createMany`, flattened across chunks and keyed by day. */
function writtenRows(): Map<string, CapacityRow> {
  const rows = createMany.mock.calls.flatMap((call) => call[0].data as CapacityRow[]);
  return new Map(rows.map((row) => [key(row.date), row]));
}

beforeEach(() => {
  queryRawCalls.length = 0;
  deleteMany.mockClear();
  createMany.mockClear();
  receivedRows = [];
  shippedOrderRows = [];
  shippedUnitRows = [];
  shopTimezone = "America/Los_Angeles";
});

describe("the day boundary the warehouse's days are cut on", () => {
  it("cuts every one of the three reads on midnight in the shop's zone", async () => {
    receivedRows = [{ day: day(1), count: 1n }];
    await rebuildCapacityDays("shop_1");

    expect(queryRawCalls).toHaveLength(3);
    for (const call of queryRawCalls) {
      // A bare date_trunc cuts on UTC midnight — 4pm in Los Angeles — so the
      // merchant's whole evening trade landed on the next day's row.
      expect(call.sql).toContain("AT TIME ZONE 'UTC' AT TIME ZONE ");
      expect(call.sql).not.toMatch(/date_trunc\('day', "?\w+"?\)/);
      expect(call.values).toContain("America/Los_Angeles");
    }
  });

  it("falls back to UTC rather than letting an unusable zone kill the import", async () => {
    for (const bad of [null, "", "Mars/Olympus_Mons"]) {
      queryRawCalls.length = 0;
      shopTimezone = bad;
      receivedRows = [{ day: day(1), count: 1n }];

      await rebuildCapacityDays("shop_1");

      // Postgres throws on a zone it does not know, and this runs at the end of
      // the import — a bad value would cost the merchant the entire walk.
      expect(queryRawCalls[0]!.values, String(bad)).toContain("UTC");
    }
  });
});

describe("the statements rebuildCapacityDays reads from", () => {
  it("collapses an order's parcels to the day its last one left", async () => {
    receivedRows = [{ day: day(1), count: 1n }];
    await rebuildCapacityDays("shop_1");

    const shipped = queryRawCalls.find((c) => c.sql.includes("last_shipped"))!;

    // Counting "Fulfillment" rows directly is the defect: three parcels, three
    // orders fulfilled. The order has to be collapsed first.
    expect(shipped.sql).toContain('MAX("shippedAt")');
    expect(shipped.sql).toContain('GROUP BY "orderId"');
    expect(shipped.sql).toContain("date_trunc('day', last_shipped AT TIME ZONE");
  });

  it("excludes unshipped parcels by shippedAt, never by naming statuses", async () => {
    receivedRows = [{ day: day(1), count: 1n }];
    await rebuildCapacityDays("shop_1");

    const fulfilment = queryRawCalls.filter((c) => c.sql.includes('"Fulfillment"'));
    expect(fulfilment).toHaveLength(2);

    for (const call of fulfilment) {
      // One definition of "shipped" lives in `fulfillmentDidShip`. A status list
      // written here would be a second one, free to drift from it.
      expect(call.sql).toContain('"shippedAt" IS NOT NULL');
      expect(call.sql).not.toMatch(/status/i);
      expect(call.sql).not.toMatch(/CANCELLED|FAILURE/i);
    }
  });

  it("scopes every read to the one shop", async () => {
    receivedRows = [{ day: day(1), count: 1n }];
    await rebuildCapacityDays("shop_9");

    expect(queryRawCalls).toHaveLength(3);
    for (const call of queryRawCalls) {
      expect(call.sql).toContain('"shopId" = ');
      expect(call.values).toContain("shop_9");
    }
  });
});

describe("the rows rebuildCapacityDays writes", () => {
  it("carries the backlog forward across days, never below zero", async () => {
    receivedRows = [
      { day: day(3), count: 10n },
      { day: day(2), count: 4n },
      { day: day(1), count: 0n },
    ];
    shippedOrderRows = [
      { day: day(3), count: 2n },
      { day: day(2), count: 3n },
      { day: day(1), count: 20n },
    ];

    await rebuildCapacityDays("shop_1");
    const rows = writtenRows();

    // 10 in, 2 out.
    expect(rows.get(key(day(3)))!.backlogEnd).toBe(8);
    // +4 in, 3 out -> 14 received, 5 shipped.
    expect(rows.get(key(day(2)))!.backlogEnd).toBe(9);
    // A day that ships more than it ever received cannot owe negative orders.
    expect(rows.get(key(day(1)))!.backlogEnd).toBe(0);
  });

  it("writes a row for every day in between, not only the days with activity", async () => {
    receivedRows = [
      { day: day(4), count: 5n },
      { day: day(1), count: 5n },
    ];

    await rebuildCapacityDays("shop_1");
    const rows = writtenRows();

    // A missing day reads as "no data" on a chart; a genuinely quiet day is a
    // zero, and the warehouse had three of them.
    for (const n of [4, 3, 2, 1, 0]) {
      expect(rows.has(key(day(n))), `day -${n}`).toBe(true);
    }
    expect(rows.get(key(day(3)))!.ordersReceived).toBe(0);
    expect(rows.get(key(day(3)))!.ordersFulfilled).toBe(0);
    expect(rows.get(key(day(3)))!.backlogEnd).toBe(5);
  });

  it("keeps units on the day they shipped, independent of the order count", async () => {
    receivedRows = [{ day: day(2), count: 1n }];
    // One order, three parcels: one order fulfilled, twelve units moved.
    shippedOrderRows = [{ day: day(1), count: 1n }];
    shippedUnitRows = [{ day: day(1), units: 12n }];

    await rebuildCapacityDays("shop_1");
    const rows = writtenRows();

    expect(rows.get(key(day(1)))!.ordersFulfilled).toBe(1);
    expect(rows.get(key(day(1)))!.unitsFulfilled).toBe(12);
  });

  it("sets every row's capacity ceiling to the best day ever observed", async () => {
    receivedRows = [{ day: day(3), count: 30n }];
    shippedOrderRows = [
      { day: day(3), count: 4n },
      { day: day(2), count: 11n },
      { day: day(1), count: 7n },
    ];

    await rebuildCapacityDays("shop_1");
    const rows = [...writtenRows().values()];

    // Every alert on the Fulfilment screen is measured against this, so a
    // parcel counted as an order would raise it for the whole history.
    expect(rows.every((row) => row.maxDailyCapacity === 11)).toBe(true);
  });

  it("clears the shop's existing history before rewriting it", async () => {
    receivedRows = [{ day: day(1), count: 1n }];
    await rebuildCapacityDays("shop_1");

    expect(deleteMany).toHaveBeenCalledWith({ where: { shopId: "shop_1" } });
    expect(createMany).toHaveBeenCalled();
    expect(deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      createMany.mock.invocationCallOrder[0]!,
    );
  });

  it("stamps each row at UTC midnight, matching the day the SQL grouped on", async () => {
    receivedRows = [{ day: day(2), count: 1n }];
    await rebuildCapacityDays("shop_1");

    for (const row of writtenRows().values()) {
      expect(row.date.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(row.shopId).toBe("shop_1");
    }
  });

  it("touches nothing when the shop has no orders at all", async () => {
    await rebuildCapacityDays("shop_1");

    // A shop mid-import has no history to rebuild, and deleting what is there
    // would blank the screen rather than leave it stale.
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
});
