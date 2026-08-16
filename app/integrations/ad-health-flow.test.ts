import {
  ConnectorHealthStatus,
  ConnectorProvider,
  ConnectorStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MERIDIAN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const mocks = vi.hoisted(() => ({
  connectorFindMany: vi.fn(),
  connectorUpdate: vi.fn(),
  connectorUpsert: vi.fn(),
  eventCreate: vi.fn(),
  eventUpdate: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    connector: {
      findMany: (...args: unknown[]) => mocks.connectorFindMany(...args),
      update: (...args: unknown[]) => mocks.connectorUpdate(...args),
      upsert: (...args: unknown[]) => mocks.connectorUpsert(...args),
    },
    connectorHealthEvent: {
      create: (...args: unknown[]) => mocks.eventCreate(...args),
      update: (...args: unknown[]) => mocks.eventUpdate(...args),
    },
  },
}));
vi.mock("./lease.server", () => ({
  withConnectorWork: async (
    _connectorId: string,
    _purpose: string,
    _now: Date,
    work: () => Promise<unknown>,
  ) => ({ claimed: true, value: await work() }),
}));

const { encryptSecret } = await import("~/lib/crypto.server");
const { checkAdConnector, runAdConnectorHealthSweep, storeConnectorCredentials } = await import("./ad-health.server");

function connector(overrides: Record<string, unknown> = {}) {
  return {
    id: "connector_1",
    shopId: "shop_1",
    shop: { domain: "northwind.myshopify.com" },
    provider: ConnectorProvider.TIKTOK_ADS,
    accessTokenEnc: encryptSecret("primary-token"),
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    standbyAccessTokenEnc: null,
    standbyRefreshTokenEnc: null,
    standbyTokenExpiresAt: null,
    consecutiveFailures: 0,
    failoverCount: 0,
    status: ConnectorStatus.CONNECTED,
    healthStatus: ConnectorHealthStatus.HEALTHY,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectorFindMany.mockResolvedValue([]);
  mocks.connectorUpdate.mockResolvedValue({});
  mocks.connectorUpsert.mockResolvedValue({});
  mocks.eventCreate.mockImplementation(async ({ data }) => ({ id: "event_1", ...data }));
  mocks.eventUpdate.mockResolvedValue({});
});

describe("autonomous ad connector recovery", () => {
  it("bootstraps a missing connector row while encrypting the credential", async () => {
    await storeConnectorCredentials({
      shopId: "shop_1",
      provider: ConnectorProvider.GOOGLE_ADS,
      accessToken: "new-primary-token",
    });

    expect(mocks.connectorUpsert).toHaveBeenCalledWith({
      where: { shopId_provider: { shopId: "shop_1", provider: ConnectorProvider.GOOGLE_ADS } },
      create: expect.objectContaining({
        shopId: "shop_1",
        provider: ConnectorProvider.GOOGLE_ADS,
        accessTokenEnc: expect.any(String),
        status: ConnectorStatus.CONNECTED,
      }),
      update: expect.objectContaining({
        accessTokenEnc: expect.any(String),
        status: ConnectorStatus.CONNECTED,
      }),
    });
    const encrypted = mocks.connectorUpsert.mock.calls[0]![0].create.accessTokenEnc;
    expect(encrypted).not.toContain("new-primary-token");
  });

  it("promotes only a standby token that passes a live provider probe", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40001, message: "Access token invalid" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, message: "OK", data: { list: [{ advertiser_id: "1" }] } }), { status: 200 }));

    const result = await checkAdConnector(
      connector({ standbyAccessTokenEnc: encryptSecret("standby-token") }),
      new Date("2026-08-11T12:00:00Z"),
      {},
      fetcher,
    );

    expect(result).toMatchObject({ healthy: true, failedOver: true });
    expect(mocks.connectorUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        accessTokenEnc: expect.any(String),
        standbyAccessTokenEnc: null,
        failoverCount: { increment: 1 },
      }),
    }));
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "FAILOVER_ACTIVATED" }),
    }));
  });

  it("does not promote standby credentials for a transient provider outage", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Provider unavailable" }), { status: 503 }),
    );

    const result = await checkAdConnector(
      connector({ standbyAccessTokenEnc: encryptSecret("standby-token") }),
      new Date("2026-08-11T12:00:00Z"),
      {},
      fetcher,
    );

    expect(result).toMatchObject({ healthy: false, failedOver: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.connectorUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ standbyAccessTokenEnc: null }),
    }));
  });

  it("marks an authoritative token rejection disconnected and alerts immediately", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).startsWith("https://graph.facebook.com/")) {
        return new Response(JSON.stringify({ data: { is_valid: false } }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    await checkAdConnector(
      connector({ provider: ConnectorProvider.FACEBOOK_ADS }),
      new Date("2026-08-11T12:00:00Z"),
      {
        META_APP_ID: "meta-app",
        META_APP_SECRET: "meta-secret",
        CONNECTOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
        CONNECTOR_ALERT_WEBHOOK_SECRET: "alert-secret",
      },
      fetcher,
    );

    expect(mocks.connectorUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: ConnectorStatus.DISCONNECTED,
        healthStatus: ConnectorHealthStatus.UNHEALTHY,
        consecutiveFailures: 1,
      }),
    }));
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("alerts.example.test"))).toBe(true);
  });

  it("records a durable alert failure when a disconnect receiver is absent", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 40001, message: "Access token invalid" }), { status: 200 }),
    );

    await checkAdConnector(
      connector(),
      new Date("2026-08-11T12:00:00Z"),
      {},
      fetcher,
    );

    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: "ALERT_FAILED",
        message: "No alert webhook or support-email destination is configured.",
      }),
    }));
  });

  it("does not repeat the immediate alert on every disconnected retry", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).startsWith("https://graph.facebook.com/")) {
        return new Response(JSON.stringify({ data: { is_valid: false } }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    await checkAdConnector(
      connector({
        provider: ConnectorProvider.FACEBOOK_ADS,
        status: ConnectorStatus.DISCONNECTED,
        healthStatus: ConnectorHealthStatus.UNHEALTHY,
        consecutiveFailures: 1,
      }),
      new Date("2026-08-11T12:05:00Z"),
      {
        META_APP_ID: "meta-app",
        META_APP_SECRET: "meta-secret",
        CONNECTOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
        CONNECTOR_ALERT_WEBHOOK_SECRET: "alert-secret",
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("alerts.example.test"))).toBe(false);
  });

  it("marks the third failure unhealthy and delivers a signed notification", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo, _init?: RequestInit) => {
      void _init;
      if (String(url).startsWith("https://graph.facebook.com/")) {
        return new Response(JSON.stringify({ data: { is_valid: false }, error: { message: "Expired token" } }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    const result = await checkAdConnector(
      connector({
        provider: ConnectorProvider.FACEBOOK_ADS,
        consecutiveFailures: 2,
      }),
      new Date("2026-08-11T12:00:00Z"),
      {
        META_APP_ID: "meta-app",
        META_APP_SECRET: "meta-secret",
        CONNECTOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
        CONNECTOR_ALERT_WEBHOOK_SECRET: "alert-secret",
      },
      fetcher,
    );

    expect(result.healthy).toBe(false);
    expect(mocks.connectorUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: ConnectorStatus.DISCONNECTED,
        healthStatus: ConnectorHealthStatus.UNHEALTHY,
        consecutiveFailures: 3,
      }),
    }));
    expect(mocks.eventUpdate).toHaveBeenCalledWith({
      where: { id: "event_1" },
      data: { notifiedAt: new Date("2026-08-11T12:00:00Z") },
    });
    const alertCall = fetcher.mock.calls.find(([url]) => String(url).includes("alerts.example.test"));
    expect(alertCall?.[1]?.headers).toMatchObject({
      "X-Meridian-Signature": expect.stringMatching(/^sha256=/),
    });
  });

  it("records malformed encrypted credentials instead of swallowing a crashed sweep", async () => {
    mocks.connectorFindMany.mockResolvedValue([
      connector({ accessTokenEnc: "not-an-envelope", consecutiveFailures: 2 }),
    ]);

    await expect(runAdConnectorHealthSweep(new Date("2026-08-11T12:00:00Z"))).resolves.toBe(1);

    expect(mocks.connectorFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: expect.arrayContaining([ConnectorStatus.DISCONNECTED]) },
      }),
    }));

    expect(mocks.connectorUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: ConnectorStatus.ERROR,
        healthStatus: ConnectorHealthStatus.UNHEALTHY,
        consecutiveFailures: 3,
        lastError: expect.stringContaining("Malformed secret envelope"),
      }),
    }));
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "CHECK_FAILED", attempt: 3 }),
    }));
  });
});
