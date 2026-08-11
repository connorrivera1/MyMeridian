import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Differential proof for bounded recomputation against real Postgres.
 *
 * The unit suite pins orchestration and the one-month admission boundary. This
 * suite proves the database-specific pieces a mock cannot: merchant-local
 * month discovery across DST, DATE handling for ad spend, materialised order
 * pennies, and the SQL customer aggregate/reset.
 *
 * Skipped unless MERIDIAN_TEST_DATABASE_URL points at a migrated throwaway DB.
 */
const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("bounded recompute, against real Postgres", () => {
  let prisma: any;
  let recomputeShopProfitability: any;
  let loadEngineOrders: any;
  let loadAdSpend: any;
  let loadCostRules: any;
  let computeProfitForPeriod: any;
  let toCents: any;
  let shopId: string;
  let customerId: string;
  let emptyCustomerId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

    ({ recomputeShopProfitability } = await import("./recompute.server"));
    ({ loadEngineOrders, loadAdSpend, loadCostRules } = await import(
      "~/data/queries.server"
    ));
    ({ computeProfitForPeriod } = await import("~/engine/profit"));
    ({ toCents } = await import("~/engine/money"));

    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const shop = await prisma.shop.create({
      data: {
        domain: `recompute-${nonce}.myshopify.com`,
        name: "Recompute Integration",
        currency: "USD",
        timezone: "America/Los_Angeles",
      },
    });
    shopId = shop.id;

    const [customer, emptyCustomer] = await Promise.all([
      prisma.customer.create({
        data: {
          shopId,
          shopifyId: `gid://shopify/Customer/${nonce}-active`,
          ordersCount: 999,
          lifetimeRevenue: "999.99",
          lifetimeProfit: "999.99",
          firstOrderAt: new Date("2030-01-01T00:00:00.000Z"),
        },
      }),
      prisma.customer.create({
        data: {
          shopId,
          shopifyId: `gid://shopify/Customer/${nonce}-empty`,
          ordersCount: 999,
          lifetimeRevenue: "999.99",
          lifetimeProfit: "999.99",
          firstOrderAt: new Date("2030-01-01T00:00:00.000Z"),
        },
      }),
    ]);
    customerId = customer.id;
    emptyCustomerId = emptyCustomer.id;

    await prisma.costRule.createMany({
      data: [
        {
          shopId,
          kind: "PAYMENT_FEE",
          label: "Processor",
          percentRate: "0.02900",
          fixedPerOrder: "0.3000",
        },
        {
          shopId,
          kind: "SHIPPING_DEFAULT",
          label: "Shipping",
          fixedPerOrder: "5.0000",
        },
        {
          shopId,
          kind: "PICK_PACK",
          label: "Pick and pack",
          fixedPerOrder: "2.0000",
          fixedPerItem: "0.5000",
        },
        {
          shopId,
          kind: "OVERHEAD_MONTHLY",
          label: "Overhead",
          monthlyAmount: "10.01",
        },
      ],
    });

    const nowOrder = new Date(Date.now() - 2 * 86_400_000);
    const postCutoffOrder = new Date(Date.now() + 60 * 60 * 1000);
    const orders = [
      {
        id: `recompute-${nonce}-jan-a`,
        shopifyId: `gid://shopify/Order/${nonce}-jan-a`,
        orderNumber: 7101,
        processedAt: new Date("2026-01-15T20:00:00.000Z"),
        subtotal: "123.45",
        discountTotal: "0.00",
        shippingCharged: "0.00",
        taxTotal: "12.35",
        total: "135.80",
        refundedTotal: "1.01",
        channel: "FACEBOOK",
        campaignId: "campaign-a",
      },
      {
        id: `recompute-${nonce}-jan-b`,
        shopifyId: `gid://shopify/Order/${nonce}-jan-b`,
        orderNumber: 7102,
        processedAt: new Date("2026-01-20T20:00:00.000Z"),
        subtotal: "100.00",
        total: "100.00",
        channel: "FACEBOOK",
        campaignId: null,
      },
      // Same merchant-local day, on opposite sides of LA's spring-forward.
      // The lexical ids also pin which order receives an indivisible ad penny.
      {
        id: `recompute-${nonce}-mar-a`,
        shopifyId: `gid://shopify/Order/${nonce}-mar-a`,
        orderNumber: 7103,
        processedAt: new Date("2026-03-08T09:30:00.000Z"),
        subtotal: "100.00",
        total: "100.00",
        channel: "GOOGLE",
        campaignId: null,
      },
      {
        id: `recompute-${nonce}-mar-b`,
        shopifyId: `gid://shopify/Order/${nonce}-mar-b`,
        orderNumber: 7104,
        processedAt: new Date("2026-03-08T10:30:00.000Z"),
        subtotal: "100.00",
        total: "100.00",
        channel: "GOOGLE",
        campaignId: null,
      },
      // Makes the run's final local month partial rather than historical/full.
      {
        id: `recompute-${nonce}-current`,
        shopifyId: `gid://shopify/Order/${nonce}-current`,
        orderNumber: 7105,
        processedAt: nowOrder,
        subtotal: "100.00",
        total: "100.00",
        channel: "DIRECT",
        campaignId: null,
      },
      // Linked to the active customer but beyond the frozen row cutoff. It
      // must stay out of both materialisation and the final SQL aggregates.
      {
        id: `recompute-${nonce}-post-cutoff`,
        shopifyId: `gid://shopify/Order/${nonce}-post-cutoff`,
        orderNumber: 7106,
        processedAt: postCutoffOrder,
        subtotal: "999.00",
        total: "999.00",
        channel: "DIRECT",
        campaignId: null,
      },
    ];

    for (const row of orders) {
      await prisma.order.create({
        data: {
          ...row,
          shopId,
          customerId,
          isFirstOrder: row.orderNumber === 7101,
          lineItems: {
            create: {
              shopId,
              shopifyId: `gid://shopify/LineItem/${row.orderNumber}`,
              title: "Integration item",
              quantity: row.orderNumber === 7101 ? 3 : 1,
              unitPrice: row.subtotal,
              unitCost: "1.2345",
            },
          },
        },
      });
    }

    // SQL DATE values surface at midnight UTC. For LA, the following day's
    // date is the instant that buckets onto the intended merchant-local day.
    await prisma.adSpend.createMany({
      data: [
        {
          shopId,
          date: new Date("2026-01-16T00:00:00.000Z"),
          channel: "FACEBOOK",
          campaignId: "campaign-a",
          spend: "1.01",
        },
        {
          shopId,
          date: new Date("2026-01-21T00:00:00.000Z"),
          channel: "FACEBOOK",
          spend: "0.37",
        },
        {
          shopId,
          date: new Date("2026-01-23T00:00:00.000Z"),
          channel: "FACEBOOK",
          spend: "0.19",
        },
        // No February orders: this month must still be discovered and charged.
        {
          shopId,
          date: new Date("2026-02-13T00:00:00.000Z"),
          channel: "TIKTOK",
          spend: "7.77",
        },
        {
          shopId,
          date: new Date("2026-03-09T00:00:00.000Z"),
          channel: "GOOGLE",
          spend: "0.01",
        },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  it("matches a one-shot engine result and materialises every order/customer exactly", async () => {
    const cutoff = new Date();
    const upperBound = new Date(cutoff.getTime() + 86_400_000);
    const fullRange = { from: new Date(0), to: cutoff };
    const [orders, spend, rules] = await Promise.all([
      loadEngineOrders(shopId, fullRange),
      loadAdSpend(shopId, fullRange),
      loadCostRules(shopId),
    ]);
    const earliest = orders[0]!.processedAt;
    const expected = computeProfitForPeriod(
      orders,
      spend,
      rules,
      "America/Los_Angeles",
      { from: earliest, to: upperBound },
    );

    const result = await recomputeShopProfitability(shopId);
    expect(result).toMatchObject({
      ordersUpdated: expected.orderCount,
      customersUpdated: 2,
      netProfitCents: expected.netProfitCents,
      unattributedAdSpendCents: expected.unattributedAdCostCents,
    });

    const storedOrders = await prisma.order.findMany({
      where: { shopId },
      select: {
        id: true,
        adCostAttributed: true,
        overheadAllocated: true,
        contributionProfit: true,
        netProfit: true,
        computedAt: true,
      },
      orderBy: { id: "asc" },
    });
    const expectedById = new Map<string, any>(
      expected.orders.map((row: any) => [row.orderId, row]),
    );

    for (const stored of storedOrders) {
      const row = expectedById.get(stored.id);
      if (!row) {
        expect(stored.id).toContain("-post-cutoff");
        expect(stored.computedAt).toBeNull();
        expect(toCents(stored.contributionProfit)).toBe(0);
        continue;
      }
      expect(toCents(stored.adCostAttributed)).toBe(row.adCostCents);
      expect(toCents(stored.overheadAllocated)).toBe(row.overheadCents);
      expect(toCents(stored.contributionProfit)).toBe(
        row.contributionProfitCents,
      );
      expect(toCents(stored.netProfit)).toBe(row.netProfitCents);
      expect(stored.computedAt).toBeInstanceOf(Date);
    }

    // The deterministic id tie-breaker awards the one March ad penny to -a.
    const march = storedOrders.filter((row: any) => row.id.includes("-mar-"));
    expect(march.map((row: any) => toCents(row.adCostAttributed))).toEqual([
      1, 0,
    ]);

    const [customer, emptyCustomer, shop] = await Promise.all([
      prisma.customer.findUniqueOrThrow({ where: { id: customerId } }),
      prisma.customer.findUniqueOrThrow({ where: { id: emptyCustomerId } }),
      prisma.shop.findUniqueOrThrow({ where: { id: shopId } }),
    ]);
    expect(customer.ordersCount).toBe(expected.orderCount);
    expect(toCents(customer.lifetimeRevenue)).toBe(
      expected.orders.reduce(
        (sum: number, row: any) => sum + row.netRevenueCents,
        0,
      ),
    );
    expect(toCents(customer.lifetimeProfit)).toBe(
      expected.orders.reduce(
        (sum: number, row: any) => sum + row.contributionProfitCents,
        0,
      ),
    );
    expect(customer.firstOrderAt).toEqual(earliest);

    expect(emptyCustomer).toMatchObject({
      ordersCount: 0,
      firstOrderAt: null,
    });
    expect(toCents(emptyCustomer.lifetimeRevenue)).toBe(0);
    expect(toCents(emptyCustomer.lifetimeProfit)).toBe(0);
    expect(shop.lastComputedAt).toBeInstanceOf(Date);
  });
});
