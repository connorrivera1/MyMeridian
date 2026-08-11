import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("checkout and usage persistence, against real Postgres", () => {
  let prisma: any;
  let shop: { id: string; domain: string };
  let recordOrderUsage: typeof import("./usage-meter.server").recordOrderUsage;
  let processCheckoutsWebhook: typeof import("./webhook-processors.server").processCheckoutsWebhook;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    const dbModule = await import("~/db.server");
    prisma = dbModule.default;
    ({ recordOrderUsage } = await import("./usage-meter.server"));
    ({ processCheckoutsWebhook } = await import("./webhook-processors.server"));
    shop = await prisma.shop.create({
      data: {
        domain: `checkout-usage-${Date.now()}.myshopify.com`,
        name: "Checkout usage integration",
        planName: "starter",
      },
    });
  });

  afterAll(async () => {
    if (!prisma || !shop) return;
    await prisma.shop.delete({ where: { id: shop.id } });
    await prisma.$disconnect();
  });

  it("counts concurrent orders exactly once and persists a checkout projection", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recordOrderUsage(shop.id, `order:${shop.id}:${index}`),
      ),
    );
    expect(results.filter((result) => result.counted)).toHaveLength(20);

    const meter = await prisma.usageMeter.findFirstOrThrow({
      where: { shopId: shop.id, metric: "orders" },
    });
    expect(meter.used).toBe(20);
    expect(
      await recordOrderUsage(shop.id, `order:${shop.id}:0`),
    ).toMatchObject({ counted: false, used: 20 });

    await processCheckoutsWebhook({
      shopDomain: shop.domain,
      topic: "CHECKOUTS_CREATE",
      webhookId: "checkout-integration-1",
      isReplay: false,
      payload: {
        token: "checkout-token",
        currency: "USD",
        total_price: "42.00",
        created_at: "2026-08-11T10:00:00Z",
        updated_at: "2026-08-11T10:01:00Z",
        line_items: [{ quantity: 2, variant_id: 7, price: "21.00" }],
      },
    });

    const checkout = await prisma.checkout.findUniqueOrThrow({
      where: { shopId_token: { shopId: shop.id, token: "checkout-token" } },
    });
    expect(checkout.totalQuantity).toBe(2);
    expect(Number(checkout.total)).toBe(42);
  });
});
