import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Differential proof that the large-window product rollup covers the same
 * orders as the order-side ledger, against real Postgres.
 *
 * No mock can catch what this is for. `Order.processedAt` is
 * `timestamp without time zone`, holding a UTC wall clock. The order side
 * filters it through Prisma's typed `gte`/`lte`; the product rollup is raw SQL
 * and binds the same JS Date as a `timestamptz`. Comparing a `timestamptz`
 * against a `timestamp` makes Postgres render the instant in the *session*
 * timezone first, so on an `America/New_York` connection both ends of the
 * window slide four hours (five in winter) earlier and the tail of the range
 * silently vanishes from the Products screen while the ledger still counts it.
 *
 * The bug is invisible unless the session timezone is not UTC, so this suite
 * pins the connection to America/New_York and puts orders inside the shifted
 * band on purpose.
 *
 * Skipped unless MERIDIAN_TEST_DATABASE_URL points at a migrated throwaway DB.
 */
const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)(
  "materialized product rollup covers the same window as the ledger",
  () => {
    let prisma: any;
    let loadMaterializedShopAnalytics: any;
    let shop: any;

    // 2026-08-03 in America/New_York is EDT (UTC-4). An order at 21:30Z is
    // 17:30 local, so a window ending at 23:30Z that gets rendered as 19:30
    // local drops it — while an order at 12:00Z survives either way.
    const EARLY = new Date("2026-08-03T12:00:00.000Z");
    const LATE = new Date("2026-08-03T21:30:00.000Z");
    const WINDOW_END = new Date("2026-08-03T23:30:00.000Z");

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_URL;
      process.env.TZ = "America/New_York";
      const { PrismaClient } = await import("@prisma/client");
      prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
      // The defect only shows on a non-UTC session, which is what a developer
      // laptop and any container with a TZ set actually run.
      await prisma.$executeRawUnsafe(
        `ALTER DATABASE "${new URL(TEST_URL!).pathname.slice(1)}" SET TIMEZONE TO 'America/New_York'`,
      );
      await prisma.$disconnect();
      prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

      ({ loadMaterializedShopAnalytics } = await import(
        "./materialized-analytics.server"
      ));

      shop = await prisma.shop.create({
        data: {
          domain: `tz-guard-${Date.now()}.myshopify.com`,
          name: "TZ Guard",
          currency: "USD",
          timezone: "America/New_York",
        },
      });

      const product = await prisma.product.create({
        data: {
          shopId: shop.id,
          shopifyId: "gid://shopify/Product/tzguard-1",
          title: "Boundary Widget",
          handle: "boundary-widget",
        },
      });
      const variant = await prisma.variant.create({
        data: {
          shopId: shop.id,
          productId: product.id,
          shopifyId: "gid://shopify/ProductVariant/tzguard-1",
          title: "Default",
          price: "50.00",
        },
      });

      let n = 0;
      for (const processedAt of [EARLY, LATE]) {
        n += 1;
        const order = await prisma.order.create({
          data: {
            shopId: shop.id,
            shopifyId: `gid://shopify/Order/tzguard-${n}`,
            orderNumber: 5000 + n,
            processedAt,
            channel: "DIRECT",
            subtotal: "50.00",
            discountTotal: "0",
            shippingCharged: "0",
            taxTotal: "0",
            total: "50.00",
            refundedTotal: "0",
            returnFeesRetained: "0",
            cogsTotal: "20.00",
            adCostAttributed: "0",
            overheadAllocated: "0",
            contributionProfit: "30.00",
            netProfit: "30.00",
            materializedPaymentFee: "0",
            materializedPickPackCost: "0",
            materializedOutboundShippingCost: "0",
            materializedReturnShippingCost: "0",
            materializedUnits: 1,
            materializedMissingCogs: false,
            materializedModeledCosts: false,
            computedAt: new Date("2026-08-04T00:00:00.000Z"),
          },
        });
        await prisma.orderLineItem.create({
          data: {
            shopId: shop.id,
            orderId: order.id,
            productId: product.id,
            variantId: variant.id,
            shopifyId: `gid://shopify/LineItem/tzguard-${n}`,
            title: "Boundary Widget",
            quantity: 1,
            refundedQty: 0,
            unitPrice: "50.00",
            discount: "0",
            unitCost: "20.00",
            cogsKnown: true,
          },
        });
      }
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      if (shop) {
        await prisma.orderLineItem.deleteMany({ where: { shopId: shop.id } });
        await prisma.order.deleteMany({ where: { shopId: shop.id } });
        await prisma.variant.deleteMany({ where: { shopId: shop.id } });
        await prisma.product.deleteMany({ where: { shopId: shop.id } });
        await prisma.shop.deleteMany({ where: { id: shop.id } });
      }
      await prisma.$disconnect();
    });

    it("confirms the session timezone is not UTC, or this proves nothing", async () => {
      const rows: any[] = await prisma.$queryRawUnsafe("SHOW TIMEZONE");
      expect(rows[0].TimeZone).toBe("America/New_York");
    });

    it("includes an order in the band the session timezone would shift away", async () => {
      const analytics = await loadMaterializedShopAnalytics(shop, {
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: WINDOW_END,
      });

      // Both orders are in the ledger.
      expect(analytics.period.orderCount).toBe(2);

      // And both must be in the product rollup. Before the fix the 21:30Z
      // order was dropped here and only here, so the screen showed one.
      const products = analytics.products;
      expect(products).toHaveLength(1);
      expect(products[0].ordersContaining).toBe(2);
      expect(products[0].units).toBe(2);
    });

    it("reconciles product totals against the order ledger to the cent", async () => {
      const analytics = await loadMaterializedShopAnalytics(shop, {
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: WINDOW_END,
      });
      const sum = (pick: (p: any) => number) =>
        analytics.products.reduce((total: number, p: any) => total + pick(p), 0);

      expect(sum((p) => p.cogsCents)).toBe(analytics.period.cogsCents);
      expect(sum((p) => p.netRevenueCents)).toBe(
        analytics.period.netRevenueCents,
      );
      expect(sum((p) => p.contributionProfitCents)).toBe(
        analytics.period.contributionProfitCents,
      );
    });
  },
);
