import {
  ConnectorHealthEventKind,
  ConnectorHealthStatus,
  ConnectorProvider,
  ConnectorStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("connector autonomy, against real PostgreSQL", () => {
  let prisma: any;
  let shopId: string;
  let connectorId: string;
  let claimConnectorWork: typeof import("./lease.server").claimConnectorWork;
  let releaseConnectorWork: typeof import("./lease.server").releaseConnectorWork;
  let checkAdConnector: typeof import("./ad-health.server").checkAdConnector;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.MERIDIAN_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    ({ claimConnectorWork, releaseConnectorWork } = await import("./lease.server"));
    ({ checkAdConnector } = await import("./ad-health.server"));
    const { encryptSecret } = await import("~/lib/crypto.server");

    const shop = await prisma.shop.create({
      data: {
        domain: `connector-autonomy-${Date.now()}.myshopify.com`,
        name: "Connector autonomy integration",
        currency: "USD",
        timezone: "UTC",
      },
    });
    shopId = shop.id;
    const connector = await prisma.connector.create({
      data: {
        shopId,
        provider: ConnectorProvider.FACEBOOK_ADS,
        status: ConnectorStatus.CONNECTED,
        healthStatus: ConnectorHealthStatus.HEALTHY,
        accessTokenEnc: encryptSecret("expired-meta-token"),
      },
    });
    connectorId = connector.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  it("commits exactly one work-lease winner under contention", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z");
    const claims = await Promise.all([
      claimConnectorWork(connectorId, "ad-health", now),
      claimConnectorWork(connectorId, "ad-health", now),
    ]);
    const winners = claims.filter((token): token is string => Boolean(token));
    expect(winners).toHaveLength(1);
    expect(claims.filter((token) => token === null)).toHaveLength(1);

    await releaseConnectorWork(connectorId, winners[0]!);
    await expect(
      claimConnectorWork(connectorId, "ad-health", new Date(now.getTime() + 1)),
    ).resolves.toMatch(/^ad-health:/);
  });

  it("durably persists a confirmed disconnect and signed-alert receipt", async () => {
    const connector = await prisma.connector.findUniqueOrThrow({
      where: { id: connectorId },
      include: { shop: { select: { domain: true } } },
    });
    const fetcher = async (url: URL | RequestInfo, init?: RequestInit) => {
      if (String(url).startsWith("https://graph.facebook.com/")) {
        return new Response(
          JSON.stringify({ data: { is_valid: false }, error: { message: "Token revoked" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      expect(String(url)).toBe("https://alerts.example.test/connector");
      expect((init?.headers as Record<string, string>)["X-Meridian-Signature"])
        .toMatch(/^sha256=[a-f0-9]{64}$/);
      return new Response(null, { status: 204 });
    };

    await checkAdConnector(
      connector,
      new Date("2026-08-11T12:05:00.000Z"),
      {
        META_APP_ID: "meta-app",
        META_APP_SECRET: "meta-secret",
        CONNECTOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/connector",
        CONNECTOR_ALERT_WEBHOOK_SECRET: "alert-secret",
      },
      fetcher as typeof fetch,
    );

    await expect(prisma.connector.findUniqueOrThrow({ where: { id: connectorId } }))
      .resolves.toMatchObject({
        status: ConnectorStatus.DISCONNECTED,
        healthStatus: ConnectorHealthStatus.UNHEALTHY,
        consecutiveFailures: 1,
        lastError: "Token revoked",
      });
    const events = await prisma.connectorHealthEvent.findMany({
      where: { connectorId },
      orderBy: { createdAt: "asc" },
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: ConnectorHealthEventKind.CHECK_FAILED,
        status: ConnectorHealthStatus.UNHEALTHY,
        notifiedAt: expect.any(Date),
      }),
      expect.objectContaining({
        kind: ConnectorHealthEventKind.ALERT_SENT,
        status: ConnectorHealthStatus.UNHEALTHY,
      }),
    ]));
  });
});
