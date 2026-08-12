import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;
const suite = TEST_URL ? describe : describe.skip;

suite("operator read models on PostgreSQL", () => {
  let prisma: typeof import("~/db.server").default;
  let loadOperatorOverview: typeof import("./operator-data.server").loadOperatorOverview;
  let loadOperatorStore: typeof import("./operator-data.server").loadOperatorStore;
  let shopId = "";
  const privateMarker = `PRIVATE-${Date.now()}`;
  const now = new Date("2026-08-11T20:00:00Z");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    ({ default: prisma } = await import("~/db.server"));
    ({ loadOperatorOverview, loadOperatorStore } = await import(
      "./operator-data.server"
    ));

    const shop = await prisma.shop.create({
      data: {
        domain: `operator-data-${Date.now()}.myshopify.com`,
        name: `Merchant ${privateMarker}`,
        email: `merchant-${privateMarker}@example.com`,
        installedAt: new Date("2026-08-01T00:00:00Z"),
        lastSyncedAt: new Date("2026-08-11T19:00:00Z"),
        syncStatus: "FAILED",
        syncError: `customer email leaked ${privateMarker}`,
        grantedScopes: "read_orders,read_products",
        subscription: {
          create: {
            plan: "starter",
            interval: "monthly",
            status: "active",
            trialEndsAt: new Date("2026-08-05T00:00:00Z"),
          },
        },
      },
    });
    shopId = shop.id;
    const connector = await prisma.connector.create({
      data: {
        shopId,
        provider: "GOOGLE_ADS",
        status: "CONNECTED",
        healthStatus: "UNHEALTHY",
        accessTokenEnc: privateMarker,
        lastError: privateMarker,
        consecutiveFailures: 3,
      },
    });
    await Promise.all([
      prisma.webhookEvent.create({
        data: {
          webhookId: `operator-webhook-${Date.now()}`,
          shopId,
          shopDomain: shop.domain,
          topic: "orders/create",
          payload: { customer: privateMarker },
          error: privateMarker,
          attempts: 2,
          receivedAt: new Date("2026-08-11T18:00:00Z"),
        },
      }),
      prisma.recalcJob.create({
        data: {
          shopId,
          kind: "BUNDLE_DETECTION",
          status: "FAILED",
          payload: { private: privateMarker },
          error: privateMarker,
          attempts: 2,
        },
      }),
      prisma.merchantNotification.create({
        data: {
          shopId,
          kind: "ANOMALY_ALERT",
          status: "FAILED",
          recipient: `recipient-${privateMarker}@example.com`,
          subject: privateMarker,
          payload: { private: privateMarker },
          dedupeKey: `operator-notification-${Date.now()}`,
          error: privateMarker,
          attempts: 2,
        },
      }),
      prisma.adSyncWindow.create({
        data: {
          shopId,
          connectorId: connector.id,
          day: new Date("2026-08-11T00:00:00Z"),
          status: "FAILED",
          attempts: 2,
          lastError: privateMarker,
        },
      }),
      prisma.connectorHealthEvent.create({
        data: {
          shopId,
          connectorId: connector.id,
          provider: "GOOGLE_ADS",
          kind: "CHECK_FAILED",
          status: "UNHEALTHY",
          message: privateMarker,
          createdAt: new Date("2026-08-11T19:30:00Z"),
        },
      }),
    ]);
  });

  afterAll(async () => {
    if (!prisma) return;
    if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  it("calculates business and failure metrics without exposing raw errors or payloads", async () => {
    const overview = await loadOperatorOverview(now);
    expect(overview.revenue.activePayingStores).toBeGreaterThanOrEqual(1);
    expect(overview.revenue.mrrCents).toBeGreaterThanOrEqual(4_900);
    expect(overview.failures).toMatchObject({
      failedImports: expect.any(Number),
      webhookFailures: expect.any(Number),
      recalcFailures: expect.any(Number),
      notificationFailures: expect.any(Number),
      adSyncFailures: expect.any(Number),
    });
    expect(overview.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "GOOGLE_ADS", connectedStores: 1 }),
      ]),
    );
    expect(overview.alerts.map((alert) => alert.kind)).toEqual(
      expect.arrayContaining([
        "import",
        "webhook",
        "recalculation",
        "notification",
        "ad_sync",
        "connector",
      ]),
    );
    expect(JSON.stringify(overview)).not.toContain(privateMarker);
  });

  it("returns only PII-minimized store support status", async () => {
    const store = await loadOperatorStore(shopId);
    expect(store).toMatchObject({
      id: shopId,
      syncStatus: "FAILED",
      subscription: { plan: "starter", status: "active" },
      connectors: [
        expect.objectContaining({
          provider: "GOOGLE_ADS",
          status: "CONNECTED",
          healthStatus: "UNHEALTHY",
        }),
      ],
      jobHealth: expect.objectContaining({
        failedWebhooks: 1,
        failedRecalcJobs: 1,
        failedNotifications: 1,
        failedAdSyncWindows: 1,
      }),
    });
    expect(JSON.stringify(store)).not.toContain(privateMarker);
  });
});
