import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Metadata projection, expiry, shop scoping and collection timestamps are
 * database boundaries. This suite runs only when a throwaway Postgres URL is
 * supplied, alongside the other opt-in integration tests.
 */
const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("privacy handoff, against a real Postgres", () => {
  let prisma: any;
  let listDataRequests: (shopId: string, options?: any) => Promise<any>;
  let collectDataRequestForDownload: (
    shopId: string,
    id: string,
    now?: Date,
  ) => Promise<any>;
  let redactCustomerEverywhere: (input: any) => Promise<any>;
  let shopId: string;
  let otherShopId: string;
  let shopDomain: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.MERIDIAN_CUSTOMER_ERASURE_KEY ||= Buffer.alloc(32, 18).toString(
      "base64",
    );
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    ({ listDataRequests, collectDataRequestForDownload } =
      await import("./data-request.server"));
    ({ redactCustomerEverywhere } = await import("./customer-erasure.server"));

    const marker = Date.now();
    shopDomain = `privacy-handoff-${marker}.myshopify.com`;
    const [shop, otherShop] = await Promise.all([
      prisma.shop.create({
        data: { domain: shopDomain, name: "Privacy Handoff", timezone: "UTC" },
      }),
      prisma.shop.create({
        data: {
          domain: `privacy-other-${marker}.myshopify.com`,
          name: "Privacy Other",
          timezone: "UTC",
        },
      }),
    ]);
    shopId = shop.id;
    otherShopId = otherShop.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.shop.deleteMany({
      where: { id: { in: [shopId, otherShopId].filter(Boolean) } },
    });
    await prisma.$disconnect();
  });

  it("shows every live uncollected obligation and paginates collected metadata", async () => {
    const marker = `privacy-list-${Date.now()}`;
    const now = new Date("2026-08-10T12:00:00.000Z");
    const expiresAt = new Date("2026-09-01T12:00:00.000Z");
    await prisma.dataRequest.createMany({
      data: [
        ...Array.from({ length: 31 }, (_, index) => ({
          shopId,
          webhookId: `${marker}-outstanding-${index}`,
          shopifyCustomerId: `outstanding-${index}`,
          customerEmail: `outstanding-${index}@example.com`,
          requestedAt: new Date(now.getTime() + index * 1_000),
          ordersIncluded: index,
          report: { privateReport: `outstanding-${index}` },
          expiresAt,
        })),
        ...Array.from({ length: 30 }, (_, index) => ({
          shopId,
          webhookId: `${marker}-collected-${index}`,
          shopifyCustomerId: `collected-${index}`,
          customerEmail: `collected-${index}@example.com`,
          requestedAt: new Date(now.getTime() + index * 1_000),
          ordersIncluded: index,
          report: { privateReport: `collected-${index}` },
          collectedAt: new Date(now.getTime() + index * 2_000),
          expiresAt,
        })),
      ],
    });

    const listed = await listDataRequests(shopId, { now, historyPage: 2 });

    expect(listed.outstanding).toHaveLength(31);
    expect(listed.history).toHaveLength(5);
    expect(listed.collectedTotal).toBe(30);
    expect(listed.historyPage).toBe(2);
    expect(listed.historyPageCount).toBe(2);
    expect(JSON.stringify(listed)).not.toContain("privateReport");
    expect(listed.outstanding[0].shopifyCustomerId).toBe("outstanding-0");

    await prisma.dataRequest.deleteMany({
      where: { shopId, webhookId: { startsWith: marker } },
    });
  });

  it("atomically stamps an active download, preserves the first timestamp, and rejects foreign or expired rows", async () => {
    const marker = `privacy-download-${Date.now()}`;
    const now = new Date("2026-08-10T13:00:00.000Z");
    const requestedAt = new Date("2026-08-05T12:00:00.000Z");
    const [active, expired, foreign] = await Promise.all([
      prisma.dataRequest.create({
        data: {
          shopId,
          webhookId: `${marker}-active`,
          shopifyCustomerId: "active-customer",
          requestedAt,
          report: { secret: "active-report" },
          expiresAt: new Date("2026-09-05T12:00:00.000Z"),
        },
      }),
      prisma.dataRequest.create({
        data: {
          shopId,
          webhookId: `${marker}-expired`,
          shopifyCustomerId: "expired-customer",
          requestedAt,
          report: { secret: "expired-report" },
          expiresAt: new Date("2026-08-09T12:00:00.000Z"),
        },
      }),
      prisma.dataRequest.create({
        data: {
          shopId: otherShopId,
          webhookId: `${marker}-foreign`,
          shopifyCustomerId: "foreign-customer",
          requestedAt,
          report: { secret: "foreign-report" },
          expiresAt: new Date("2026-09-05T12:00:00.000Z"),
        },
      }),
    ]);

    await expect(
      collectDataRequestForDownload(shopId, active.id, now),
    ).resolves.toEqual({
      report: { secret: "active-report" },
      requestedAt,
    });
    await expect(
      collectDataRequestForDownload(
        shopId,
        active.id,
        new Date(now.getTime() + 60_000),
      ),
    ).resolves.toEqual({
      report: { secret: "active-report" },
      requestedAt,
    });
    await expect(
      collectDataRequestForDownload(shopId, foreign.id, now),
    ).resolves.toBeNull();
    await expect(
      collectDataRequestForDownload(shopId, expired.id, now),
    ).resolves.toBeNull();

    const stored = await prisma.dataRequest.findUniqueOrThrow({
      where: { id: active.id },
    });
    expect(stored.collectedAt).toEqual(now);

    await prisma.dataRequest.deleteMany({
      where: { webhookId: { startsWith: marker } },
    });
  });

  it("clears linked attribution and matching queue URLs without touching a same-email stable id", async () => {
    const marker = Date.now();
    const sharedEmail = `shared-privacy-${marker}@example.com`;
    const customerAId = `${marker}01`;
    const customerBId = `${marker}02`;
    const [customerA, customerB] = await Promise.all([
      prisma.customer.create({
        data: {
          shopId,
          shopifyId: `gid://shopify/Customer/${customerAId}`,
          email: sharedEmail,
        },
      }),
      prisma.customer.create({
        data: {
          shopId,
          shopifyId: `gid://shopify/Customer/${customerBId}`,
          email: sharedEmail,
        },
      }),
    ]);
    const orderData = (suffix: string, customerId: string) => ({
      shopId,
      shopifyId: `gid://shopify/Order/${marker}${suffix}`,
      orderNumber: Number(`${String(marker).slice(-5)}${suffix}`),
      processedAt: new Date(),
      customerId,
      subtotal: "50.00",
      total: "50.00",
      campaignId: `campaign-${suffix}`,
      campaignName: `Personal ${sharedEmail}`,
      utmSource: `customer-${suffix}`,
      utmMedium: "email",
      utmCampaign: `customer-${suffix}-${sharedEmail}`,
      landingSite: `/offer?email=${encodeURIComponent(sharedEmail)}`,
      isFirstOrder: true,
    });
    const [orderA, orderB] = await Promise.all([
      prisma.order.create({ data: orderData("1", customerA.id) }),
      prisma.order.create({ data: orderData("2", customerB.id) }),
    ]);
    const [queuedA, queuedB] = await Promise.all([
      prisma.webhookEvent.create({
        data: {
          webhookId: `privacy-order-a-${marker}`,
          shopId,
          shopDomain,
          topic: "ORDERS_UPDATED",
          payload: {
            id: `${marker}1`,
            total_price: "50.00",
            landing_site: `/offer?email=${encodeURIComponent(sharedEmail)}`,
            referring_site: `https://personal.example/${customerAId}`,
            customer: { id: customerAId, email: sharedEmail },
          },
        },
      }),
      prisma.webhookEvent.create({
        data: {
          webhookId: `privacy-order-b-${marker}`,
          shopId,
          shopDomain,
          topic: "ORDERS_UPDATED",
          payload: {
            id: `${marker}2`,
            total_price: "50.00",
            landing_site: `/offer?email=${encodeURIComponent(sharedEmail)}`,
            referring_site: `https://personal.example/${customerBId}`,
            customer: { id: customerBId, email: sharedEmail },
          },
        },
      }),
    ]);

    await redactCustomerEverywhere({
      shopId,
      webhookId: `privacy-redact-${marker}`,
      customer: { id: customerAId, email: sharedEmail },
    });

    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: orderA.id } }),
    ).resolves.toMatchObject({
      customerId: null,
      isFirstOrder: false,
      campaignId: null,
      campaignName: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      landingSite: null,
    });
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: orderB.id } }),
    ).resolves.toMatchObject({
      customerId: customerB.id,
      campaignId: "campaign-2",
      landingSite: `/offer?email=${encodeURIComponent(sharedEmail)}`,
    });
    await expect(
      prisma.webhookEvent.findUniqueOrThrow({ where: { id: queuedA.id } }),
    ).resolves.toMatchObject({
      processedAt: null,
      payload: { id: `${marker}1`, total_price: "50.00" },
    });
    await expect(
      prisma.webhookEvent.findUniqueOrThrow({ where: { id: queuedB.id } }),
    ).resolves.toMatchObject({
      processedAt: null,
      payload: expect.objectContaining({
        landing_site: `/offer?email=${encodeURIComponent(sharedEmail)}`,
        customer: { id: customerBId, email: sharedEmail },
      }),
    });
    await expect(
      prisma.customer.findUnique({ where: { id: customerA.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.customer.findUnique({ where: { id: customerB.id } }),
    ).resolves.toMatchObject({ email: sharedEmail });
  });
});
