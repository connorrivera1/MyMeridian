import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("order keyset paging, against real Postgres", () => {
  let prisma: any;
  let loadOrderPage: typeof import("./order-page.server").loadOrderPage;
  let shopId: string;
  const range = {
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-12-31T23:59:59.999Z"),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    ({ loadOrderPage } = await import("./order-page.server"));

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const shop = await prisma.shop.create({
      data: {
        domain: `order-page-${nonce}.myshopify.com`,
        name: "Order Page Integration",
      },
    });
    shopId = shop.id;

    await prisma.order.createMany({
      data: Array.from({ length: 135 }, (_, index) => ({
        id: `order-page-${nonce}-${String(index).padStart(3, "0")}`,
        shopId,
        shopifyId: `gid://shopify/Order/${nonce}-${index}`,
        orderNumber: 10_000 + index,
        processedAt: new Date(Date.UTC(2026, 0, 1, 0, index, index % 60)),
        subtotal: "100.00",
        total: "100.00",
        channel: index % 3 === 0 ? "GOOGLE" : "DIRECT",
        contributionProfit: `${(index - 70) / 100}`,
        netProfit: `${(index - 70) / 100}`,
        materializedUnits: 1,
        computedAt: new Date("2026-08-12T00:00:00.000Z"),
      })),
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  const load = (over: Record<string, unknown> = {}) =>
    loadOrderPage({
      shopId,
      range,
      sort: "recent",
      channelFilter: null,
      requestedPage: 1,
      after: null,
      before: null,
      ...over,
    });

  it("walks forward and backward without overlap or dropped rows", async () => {
    const first = await load();
    const second = await load({
      requestedPage: 2,
      after: first!.nextCursor,
    });
    const third = await load({
      requestedPage: 3,
      after: second!.nextCursor,
    });

    expect(first!.rows).toHaveLength(60);
    expect(second!.rows).toHaveLength(60);
    expect(third!.rows).toHaveLength(15);
    const ids = [...first!.rows, ...second!.rows, ...third!.rows].map(
      (row) => row.orderId,
    );
    expect(new Set(ids).size).toBe(135);
    expect(first!.rows[0]!.orderNumber).toBe(10_134);
    expect(third!.nextCursor).toBeNull();

    const back = await load({
      requestedPage: 1,
      before: second!.previousCursor,
    });
    expect(back!.rows.map((row) => row.orderId)).toEqual(
      first!.rows.map((row) => row.orderId),
    );
  });

  it("uses the materialized profit key for best and worst sorts", async () => {
    const best = await load({ sort: "best" });
    const worst = await load({ sort: "worst" });

    expect(best!.rows[0]!.orderNumber).toBe(10_134);
    expect(worst!.rows[0]!.orderNumber).toBe(10_000);
  });

  it("applies channel filtering before counting and paging", async () => {
    const google = await load({ channelFilter: "GOOGLE" });
    expect(google!.total).toBe(45);
    expect(google!.rows).toHaveLength(45);
    expect(google!.rows.every((row) => row.channel === "GOOGLE")).toBe(true);
  });

  it("falls back to the live engine while any ledger row is incomplete", async () => {
    const target = await prisma.order.findFirst({ where: { shopId } });
    await prisma.order.update({
      where: { id: target.id },
      data: { computedAt: null },
    });
    await expect(load()).resolves.toBeNull();
    await prisma.order.update({
      where: { id: target.id },
      data: { computedAt: new Date("2026-08-12T00:00:00.000Z") },
    });
  });
});
