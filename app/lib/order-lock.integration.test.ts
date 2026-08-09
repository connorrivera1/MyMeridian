import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The first test in this repository that touches a real database.
 *
 * Everything else mocks Prisma, which is the right call for assertions about
 * *which query* a function issues — but concurrency is not visible through a
 * mock. There is no isolation to violate and nothing to contend with, so a
 * mocked suite reports the delete-then-recreate race as passing whether the
 * lock is there or not. That is precisely the bug this file exists to pin.
 *
 * Skipped unless MERIDIAN_TEST_DATABASE_URL is set, so `npm test` stays
 * runnable with no database, which every other suite assumes. CI sets it —
 * see .github/workflows/ci.yml.
 *
 * To run locally against a throwaway cluster:
 *   MERIDIAN_TEST_DATABASE_URL=postgresql://… npx vitest run order-lock.integration
 */

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("withOrderLock, against a real Postgres", () => {
  let prisma: any;
  let withOrderLock: any;
  let shopId: string;
  let orderId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    ({ withOrderLock } = await import("./order-lock.server"));

    const shop = await prisma.shop.create({
      data: {
        domain: `lock-test-${Date.now()}.myshopify.com`,
        name: "Lock Test",
        currency: "USD",
        timezone: "UTC",
      },
    });
    shopId = shop.id;

    const order = await prisma.order.create({
      data: {
        shopId,
        shopifyId: `gid://shopify/Order/${Date.now()}`,
        orderNumber: 1001,
        processedAt: new Date(),
        subtotal: "100.00",
        total: "100.00",
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    // Cascades from Shop clear everything this test wrote.
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  /** One writer's full rewrite of the order's line items. */
  const rewrite = (label: string, count: number) =>
    withOrderLock(orderId, async (tx: any) => {
      await tx.orderLineItem.deleteMany({ where: { orderId } });
      // A real handler does mapping work between the delete and the insert.
      // Without a lock this is the window another writer slips into; the sleep
      // makes the race deterministic instead of leaving it to chance.
      await new Promise((r) => setTimeout(r, 60));
      await tx.orderLineItem.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          shopId,
          orderId,
          shopifyId: `gid://shopify/LineItem/${label}-${i}`,
          title: `${label} item ${i}`,
          quantity: 1,
          unitPrice: "10.00",
          discount: "0.00",
          unitCost: "4.0000",
          refundedQty: 0,
        })),
      });
    });

  it("serialises concurrent rewrites of the same order", async () => {
    // Both writers race the same order, exactly as orders/create followed by
    // orders/updated does — different webhook ids, so delivery idempotency
    // does not suppress either.
    const results = await Promise.allSettled([
      rewrite("A", 3),
      rewrite("B", 3),
    ]);

    // Neither may fail. In production the two writers carry the *same* line
    // item ids, so unlocked, one loses to a unique violation on
    // (orderId, shopifyId) and its webhook delivery is gone for good.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    // Exactly one writer's rows survive — not a merge, not a partial set.
    // This is the assertion that fails without the lock: the writers use
    // distinct ids here, so instead of colliding they interleave and both
    // sets land, leaving the order with double the line items it has.
    const rows = await prisma.orderLineItem.findMany({
      where: { orderId },
      select: { shopifyId: true },
    });
    expect(rows).toHaveLength(3);

    const owners = new Set(
      rows.map((r: { shopifyId: string }) => r.shopifyId.split("/").pop()!.split("-")[0]),
    );
    expect(owners.size).toBe(1);
  });

  it("never exposes an order with zero line items mid-rewrite", async () => {
    // The subtler failure: interleaved as A-delete, A-create, B-delete,
    // B-create the data converges, but a dashboard reading between B's delete
    // and B's create sees no line items, computes zero COGS, and reports 100%
    // margin — failing in the direction that looks like good news.
    let sawEmpty = false;
    let polling = true;

    const poll = (async () => {
      while (polling) {
        const n = await prisma.orderLineItem.count({ where: { orderId } });
        if (n === 0) sawEmpty = true;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    await Promise.all([rewrite("C", 4), rewrite("D", 4)]);
    polling = false;
    await poll;

    expect(sawEmpty).toBe(false);
    expect(await prisma.orderLineItem.count({ where: { orderId } })).toBe(4);
  });
});
