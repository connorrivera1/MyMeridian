import { Decimal } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const orderCount = vi.fn();
const orderFindMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    order: {
      count: (...args: unknown[]) => orderCount(...args),
      findMany: (...args: unknown[]) => orderFindMany(...args),
    },
  },
}));

const { ORDER_PAGE_SIZE } = await import("./order-page");
const { loadOrderPage } = await import("./order-page.server");

const RANGE = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-31T23:59:59.999Z"),
};

function row(index: number, profit = index) {
  const money = (value: number) => new Decimal(value);
  return {
    id: `order_${String(index).padStart(3, "0")}`,
    orderNumber: 1_000 + index,
    processedAt: new Date(`2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`),
    customerId: null,
    channel: "DIRECT",
    campaignId: null,
    isFirstOrder: false,
    subtotal: money(100),
    discountTotal: money(0),
    shippingCharged: money(10),
    total: money(118),
    taxTotal: money(8),
    refundedTotal: money(0),
    returnFeesRetained: money(0),
    cogsTotal: money(30),
    adCostAttributed: money(5),
    overheadAllocated: money(4),
    contributionProfit: money(55),
    netProfit: money(profit),
    materializedPaymentFee: money(3),
    materializedPickPackCost: money(2),
    materializedOutboundShippingCost: money(5),
    materializedReturnShippingCost: money(0),
    materializedUnits: 2,
    materializedMissingCogs: false,
    materializedModeledCosts: true,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    shopId: "shop_1",
    range: RANGE,
    sort: "recent" as const,
    channelFilter: null,
    requestedPage: 1,
    after: null,
    before: null,
    ...overrides,
  };
}

function counts(all: number, computed = all, filtered = computed) {
  orderCount
    .mockResolvedValueOnce(all)
    .mockResolvedValueOnce(computed)
    .mockResolvedValueOnce(filtered);
}

describe("order table keyset page loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed to the live engine while the materialized ledger is incomplete", async () => {
    counts(10, 9, 9);

    await expect(loadOrderPage(input())).resolves.toBeNull();
    expect(orderFindMany).not.toHaveBeenCalled();
  });

  it("loads one bounded recent page and emits a bound forward cursor", async () => {
    counts(70);
    orderFindMany.mockResolvedValue(
      Array.from({ length: ORDER_PAGE_SIZE + 1 }, (_, index) => row(index + 1)),
    );

    const page = await loadOrderPage(input({ requestedPage: Number.NaN }));

    expect(page).toMatchObject({ total: 70, page: 1, pageCount: 2 });
    expect(page?.rows).toHaveLength(ORDER_PAGE_SIZE);
    expect(page?.previousCursor).toBeNull();
    expect(page?.nextCursor).toEqual(expect.any(String));
    expect(orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: ORDER_PAGE_SIZE + 1,
        orderBy: [{ processedAt: "desc" }, { id: "desc" }],
      }),
    );

    counts(70);
    orderFindMany.mockResolvedValueOnce([row(62), row(63)]);
    const next = await loadOrderPage(
      input({ requestedPage: 99, after: page?.nextCursor ?? null }),
    );
    expect(next?.previousCursor).toEqual(expect.any(String));
    expect(next?.nextCursor).toBeNull();
    expect(orderFindMany.mock.calls.at(-1)?.[0]).not.toHaveProperty("skip");
    expect(orderFindMany.mock.calls.at(-1)?.[0].where.OR).toBeDefined();
  });

  it("reverses a backward page and emits both navigation cursors", async () => {
    counts(130);
    orderFindMany.mockResolvedValue(
      Array.from({ length: ORDER_PAGE_SIZE + 1 }, (_, index) => row(index + 1)),
    );
    const first = await loadOrderPage(input());

    counts(130);
    orderFindMany.mockResolvedValueOnce(
      Array.from({ length: ORDER_PAGE_SIZE + 1 }, (_, index) => row(index + 70)),
    );
    const previous = await loadOrderPage(
      input({ before: first?.nextCursor ?? null }),
    );

    expect(previous?.previousCursor).toEqual(expect.any(String));
    expect(previous?.nextCursor).toEqual(expect.any(String));
    expect(previous?.rows[0]?.orderNumber).toBe(1_129);
    expect(orderFindMany.mock.calls.at(-1)?.[0].orderBy).toEqual([
      { processedAt: "asc" },
      { id: "asc" },
    ]);
  });

  it("binds cursors to sort, channel and range and rejects malformed values", async () => {
    counts(70, 70, 70);
    orderFindMany.mockResolvedValue(
      Array.from({ length: ORDER_PAGE_SIZE + 1 }, (_, index) =>
        row(index + 1, 100 - index),
      ),
    );
    const best = await loadOrderPage(
      input({ sort: "best", channelFilter: "DIRECT" }),
    );

    counts(70, 70, 70);
    orderFindMany.mockResolvedValueOnce([row(3, 30)]);
    await loadOrderPage(
      input({
        sort: "best",
        channelFilter: "DIRECT",
        after: best?.nextCursor ?? null,
      }),
    );
    expect(orderFindMany.mock.calls.at(-1)?.[0].where.OR).toBeDefined();

    counts(4);
    orderFindMany.mockResolvedValueOnce([row(4, -10)]);
    await loadOrderPage(
      input({
        sort: "worst",
        channelFilter: "NOT_A_CHANNEL",
        requestedPage: -50,
        after: best?.nextCursor ?? null,
      }),
    );
    expect(orderFindMany.mock.calls.at(-1)?.[0]).toMatchObject({
      skip: 0,
      orderBy: [{ netProfit: "asc" }, { id: "asc" }],
    });

    counts(4);
    orderFindMany.mockResolvedValueOnce([]);
    await loadOrderPage(input({ after: "{" }));
    expect(orderFindMany.mock.calls.at(-1)?.[0]).toHaveProperty("skip", 0);

    counts(4);
    orderFindMany.mockResolvedValueOnce([]);
    await loadOrderPage(input({ after: "x".repeat(1_025) }));
    expect(orderFindMany.mock.calls.at(-1)?.[0]).toHaveProperty("skip", 0);
  });
});
