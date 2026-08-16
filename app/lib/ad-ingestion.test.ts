import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdPlatformAdapter } from "./ad-platforms/types.server";

/**
 * The financial path of one connector-day, without Redis or HTTP: a fake
 * adapter supplies platform rows, an in-memory Prisma records what would be
 * written, and the assertions are about money, ledger state and connector
 * health transitions — the things a queue retry policy is built on.
 */

const invalidateAnalyticsCache = vi.fn();
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: (...args: unknown[]) =>
    invalidateAnalyticsCache(...args),
}));

vi.mock("~/lib/crypto.server", () => ({
  decryptSecret: (value: string) => value.replace(/^enc:/, ""),
  encryptSecret: (value: string) => `enc:${value}`,
}));

interface WindowRow {
  id: string;
  shopId: string;
  connectorId: string;
  day: Date;
  status: string;
  attempts: number;
  rowsWritten: number;
  contentHash: string | null;
  lastChangedAt: Date | null;
  lastError: string | null;
  syncedAt: Date | null;
}

let connectorRow: Record<string, unknown>;
let windowRows: WindowRow[];
let adSpendRows: Array<Record<string, unknown>>;
let exchangeRates: Array<{ day: Date; base: string; quote: string; rate: string }>;
let connectorUpdates: Array<Record<string, unknown>>;
let nextId = 1;

function windowFor(connectorId: string, day: Date): WindowRow | undefined {
  return windowRows.find(
    (row) =>
      row.connectorId === connectorId &&
      row.day.getTime() === day.getTime(),
  );
}

vi.mock("~/db.server", () => {
  const client: Record<string, unknown> = {
    connector: {
      findUnique: vi.fn(async () => ({ ...connectorRow })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        connectorUpdates.push(data);
        Object.assign(connectorRow, data);
        return { ...connectorRow };
      }),
    },
    adSyncWindow: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { connectorId_day: { connectorId: string; day: Date } };
        }) => {
          const found = windowFor(
            where.connectorId_day.connectorId,
            where.connectorId_day.day,
          );
          return found ? { ...found } : null;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = windowRows.find((candidate) => candidate.id === where.id)!;
          applyWindowUpdate(row, data);
          return { ...row };
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { connectorId_day: { connectorId: string; day: Date } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = windowFor(
            where.connectorId_day.connectorId,
            where.connectorId_day.day,
          );
          if (existing) {
            applyWindowUpdate(existing, update);
            return { ...existing };
          }
          const row: WindowRow = {
            id: `window_${nextId++}`,
            attempts: 0,
            rowsWritten: 0,
            contentHash: null,
            lastChangedAt: null,
            lastError: null,
            syncedAt: null,
            ...(create as object),
          } as WindowRow;
          windowRows.push(row);
          return { ...row };
        },
      ),
      createMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => windowRows.map((row) => ({ ...row }))),
    },
    adSpend: {
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { shopId: string; channel: string; date: Date };
        }) => {
          const before = adSpendRows.length;
          adSpendRows = adSpendRows.filter(
            (row) =>
              !(
                row.shopId === where.shopId &&
                row.channel === where.channel &&
                (row.date as Date).getTime() === where.date.getTime()
              ),
          );
          return { count: before - adSpendRows.length };
        },
      ),
      createMany: vi.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          adSpendRows.push(...data);
          return { count: data.length };
        },
      ),
    },
    exchangeRate: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            day_base_quote: { day: Date; base: string; quote: string };
          };
        }) => {
          const match = exchangeRates.find(
            (row) =>
              row.day.getTime() === where.day_base_quote.day.getTime() &&
              row.base === where.day_base_quote.base &&
              row.quote === where.day_base_quote.quote,
          );
          return match ? { ...match } : null;
        },
      ),
      findFirst: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  };
  client.$transaction = (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(client)
      : Promise.all(arg as unknown[]);
  return { default: client };
});

function applyWindowUpdate(row: WindowRow, data: Record<string, unknown>) {
  const record = row as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (
      value !== null &&
      typeof value === "object" &&
      "increment" in (value as object)
    ) {
      record[key] =
        ((record[key] as number | undefined) ?? 0) +
        (value as { increment: number }).increment;
    } else {
      record[key] = value;
    }
  }
}

const {
  googleLoginCustomerIdForConnector,
  ingestConnectorDay,
  retryShopCampaignsConnector,
} = await import(
  "./ad-ingestion.server"
);
const {
  AdProviderAuthError,
  AdProviderRateLimitError,
  AdProviderTransientError,
} = await import("./ad-platforms/types.server");
const { ShopCampaignsAccessError } = await import("./shop-campaigns.server");
const { contentHashFor } = await import("./ad-ingestion-plan");

const DAY = "2026-08-10";
const DATE = new Date(`${DAY}T00:00:00.000Z`);

const PLATFORM_ROWS = [
  {
    campaignId: "c1",
    campaignName: "Prospecting",
    spend: "100.00",
    impressions: 5000,
    clicks: 120,
    conversions: 7,
    revenue: "612.00",
  },
];

function fakeAdapter(
  overrides: Partial<AdPlatformAdapter> = {},
): AdPlatformAdapter {
  return {
    provider: "FACEBOOK_ADS",
    channel: "FACEBOOK",
    fetchAccountProfile: vi.fn(async () => ({
      currency: "USD",
      displayName: "Fake Account",
    })),
    fetchDailySpend: vi.fn(async () => PLATFORM_ROWS),
    ...overrides,
  } as AdPlatformAdapter;
}

function deps(adapter: AdPlatformAdapter) {
  return { adapters: { FACEBOOK_ADS: adapter } as never };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
  connectorRow = {
    id: "conn_1",
    shopId: "shop_1",
    provider: "FACEBOOK_ADS",
    status: "CONNECTED",
    externalAccountId: "act_1",
    displayName: null,
    accessTokenEnc: "enc:meta-token",
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    accountCurrency: "USD",
    lastSyncedAt: null,
    lastError: "previous transient noise",
    lastDeepSyncAt: null,
    shop: {
      id: "shop_1",
      domain: "merchant.myshopify.com",
      currency: "USD",
      isDemo: false,
    },
  };
  windowRows = [];
  adSpendRows = [];
  exchangeRates = [];
  connectorUpdates = [];
});

describe("ingestConnectorDay", () => {
  it("uses an MCC only when the selected Google advertiser retained one", () => {
    expect(
      googleLoginCustomerIdForConnector({
        provider: "GOOGLE_ADS",
        externalAccountId: "1234567890",
        availableAccounts: [
          { id: "1234567890", loginCustomerId: "9000000000" },
        ],
      } as never),
    ).toBe("9000000000");
    expect(
      googleLoginCustomerIdForConnector({
        provider: "GOOGLE_ADS",
        externalAccountId: "1234567890",
        availableAccounts: [{ id: "1234567890" }],
      } as never),
    ).toBeNull();
    expect(
      googleLoginCustomerIdForConnector({
        provider: "FACEBOOK_ADS",
        externalAccountId: "1234567890",
        availableAccounts: [{ id: "1234567890", loginCustomerId: "9000000000" }],
      } as never),
    ).toBeNull();
    expect(
      googleLoginCustomerIdForConnector({
        provider: "GOOGLE_ADS",
        externalAccountId: null,
        availableAccounts: [],
      } as never),
    ).toBeNull();
    expect(
      googleLoginCustomerIdForConnector({
        provider: "GOOGLE_ADS",
        externalAccountId: "1234567890",
        availableAccounts: [{ id: "1234567890", loginCustomerId: "not-a-customer" }],
      } as never),
    ).toBeNull();
    expect(
      googleLoginCustomerIdForConnector({
        provider: "GOOGLE_ADS",
        externalAccountId: "1234567890",
        availableAccounts: null,
      } as never),
    ).toBeNull();
    expect(
      googleLoginCustomerIdForConnector({
        provider: "GOOGLE_ADS",
        externalAccountId: "1234567890",
        availableAccounts: [{ id: "different-account" }],
      } as never),
    ).toBeNull();
  });

  it("writes the day's rows, stamps the ledger and heals the connector", async () => {
    const outcome = await ingestConnectorDay("conn_1", DAY, deps(fakeAdapter()));

    expect(outcome).toEqual({ kind: "synced", changed: true, rowsWritten: 1 });
    expect(adSpendRows).toHaveLength(1);
    expect(adSpendRows[0]).toMatchObject({
      shopId: "shop_1",
      channel: "FACEBOOK",
      campaignId: "c1",
      impressions: 5000,
      clicks: 120,
      platformConversions: 7,
    });
    expect(String(adSpendRows[0]!.spend)).toBe("100");
    expect((adSpendRows[0]!.date as Date).toISOString()).toBe(
      DATE.toISOString(),
    );

    const window = windowFor("conn_1", DATE)!;
    expect(window.status).toBe("SYNCED");
    expect(window.rowsWritten).toBe(1);
    expect(window.contentHash).toBe(contentHashFor(PLATFORM_ROWS));
    // The durable recompute signal commits with the rows it describes.
    expect(window.lastChangedAt).toBeInstanceOf(Date);

    expect(connectorRow.status).toBe("CONNECTED");
    expect(connectorRow.lastError).toBeNull();
    expect(connectorRow.lastSyncedAt).toBeInstanceOf(Date);
    expect(invalidateAnalyticsCache).toHaveBeenCalledTimes(1);
  });

  it("replaces the whole channel-day, dropping campaigns the platform no longer reports", async () => {
    adSpendRows.push({
      shopId: "shop_1",
      channel: "FACEBOOK",
      date: DATE,
      campaignId: "deleted-upstream",
      spend: "55.00",
    });

    await ingestConnectorDay("conn_1", DAY, deps(fakeAdapter()));

    expect(
      adSpendRows.some((row) => row.campaignId === "deleted-upstream"),
    ).toBe(false);
    expect(adSpendRows).toHaveLength(1);
  });

  it("skips the rewrite and the profit invalidation when a restatement poll changed nothing", async () => {
    await ingestConnectorDay("conn_1", DAY, deps(fakeAdapter()));
    invalidateAnalyticsCache.mockClear();
    const writesBefore = adSpendRows.length;
    const changedAtAfterFirstSync = windowFor("conn_1", DATE)!.lastChangedAt;

    const outcome = await ingestConnectorDay("conn_1", DAY, deps(fakeAdapter()));

    expect(outcome).toEqual({ kind: "synced", changed: false, rowsWritten: 0 });
    expect(adSpendRows).toHaveLength(writesBefore);
    expect(invalidateAnalyticsCache).not.toHaveBeenCalled();
    // Liveness is still stamped: the poll happened and answered — but the
    // change marker is not, or every idle poll would re-flag profit as stale.
    const window = windowFor("conn_1", DATE)!;
    expect(window.attempts).toBe(2);
    expect(window.lastChangedAt).toBe(changedAtAfterFirstSync);
  });

  it("converts a foreign-currency ad account at the stored day rate", async () => {
    connectorRow.accountCurrency = "EUR";
    exchangeRates.push({ day: DATE, base: "EUR", quote: "USD", rate: "1.1" });

    await ingestConnectorDay("conn_1", DAY, deps(fakeAdapter()));

    // €100.00 spend and €612.00 platform revenue at 1.1.
    expect(String(adSpendRows[0]!.spend)).toBe("110");
    expect(String(adSpendRows[0]!.platformRevenue)).toBe("673.2");
  });

  it("pins the account currency from the platform on first sync", async () => {
    connectorRow.accountCurrency = null;
    const adapter = fakeAdapter();

    await ingestConnectorDay("conn_1", DAY, deps(adapter));

    expect(adapter.fetchAccountProfile).toHaveBeenCalledTimes(1);
    expect(connectorRow.accountCurrency).toBe("USD");
  });

  it("marks the connector ERROR and the window FAILED on an auth failure", async () => {
    const adapter = fakeAdapter({
      fetchDailySpend: vi.fn(async () => {
        throw new AdProviderAuthError("FACEBOOK_ADS", "token expired");
      }),
    });

    await expect(
      ingestConnectorDay("conn_1", DAY, deps(adapter)),
    ).rejects.toBeInstanceOf(AdProviderAuthError);

    expect(connectorRow.status).toBe("ERROR");
    expect(String(connectorRow.lastError)).toContain("token expired");
    expect(windowFor("conn_1", DATE)!.status).toBe("FAILED");
  });

  it("records a transient failure on the ledger but leaves the connector CONNECTED", async () => {
    const adapter = fakeAdapter({
      fetchDailySpend: vi.fn(async () => {
        throw new AdProviderTransientError("FACEBOOK_ADS", "HTTP 502");
      }),
    });

    await expect(
      ingestConnectorDay("conn_1", DAY, deps(adapter)),
    ).rejects.toBeInstanceOf(AdProviderTransientError);

    const window = windowFor("conn_1", DATE)!;
    expect(window.status).toBe("FAILED");
    expect(window.lastError).toContain("HTTP 502");
    expect(connectorRow.status).toBe("CONNECTED");
    expect(String(connectorRow.lastError)).toContain("HTTP 502");
  });

  it("passes a rate limit through untouched — the day is not failed, it is deferred", async () => {
    const adapter = fakeAdapter({
      fetchDailySpend: vi.fn(async () => {
        throw new AdProviderRateLimitError("FACEBOOK_ADS", 60_000);
      }),
    });

    await expect(
      ingestConnectorDay("conn_1", DAY, deps(adapter)),
    ).rejects.toBeInstanceOf(AdProviderRateLimitError);

    expect(windowFor("conn_1", DATE)).toBeUndefined();
    expect(connectorRow.status).toBe("CONNECTED");
  });

  it("never ingests into a demo shop", async () => {
    (connectorRow.shop as Record<string, unknown>).isDemo = true;
    const outcome = await ingestConnectorDay("conn_1", DAY, deps(fakeAdapter()));
    expect(outcome.kind).toBe("skipped");
    expect(adSpendRows).toHaveLength(0);
  });

  it("skips a disconnected connector without touching anything", async () => {
    connectorRow.status = "DISCONNECTED";
    const outcome = await ingestConnectorDay("conn_1", DAY, deps(fakeAdapter()));
    expect(outcome.kind).toBe("skipped");
    expect(connectorUpdates).toHaveLength(0);
  });

  it("writes active Shop Campaigns in store currency and keeps their provider sales separate", async () => {
    connectorRow.provider = "SHOPIFY_SHOP_CAMPAIGNS";
    connectorRow.externalAccountId = null;
    connectorRow.accessTokenEnc = null;
    const fetchShopCampaigns = vi.fn(async () => [
      {
        campaignId: "shop-campaign:Autumn prospecting",
        campaignName: "Autumn prospecting",
        spend: "23.45",
        impressions: 0,
        clicks: 0,
        conversions: 4,
        revenue: "167.00",
      },
    ]);

    const outcome = await ingestConnectorDay("conn_1", DAY, {
      shopCampaignsFetcher: fetchShopCampaigns,
    });

    expect(outcome).toEqual({ kind: "synced", changed: true, rowsWritten: 1 });
    expect(fetchShopCampaigns).toHaveBeenCalledWith("merchant.myshopify.com", DAY);
    expect(adSpendRows).toEqual([
      expect.objectContaining({
        shopId: "shop_1",
        channel: "SHOP_CAMPAIGNS",
        campaignId: "shop-campaign:Autumn prospecting",
        platformConversions: 4,
      }),
    ]);
    expect(String(adSpendRows[0]!.spend)).toBe("23.45");
    expect(String(adSpendRows[0]!.platformRevenue)).toBe("167");
  });

  it("records no Shop Campaigns as a completed empty source, not a missing sync", async () => {
    connectorRow.provider = "SHOPIFY_SHOP_CAMPAIGNS";
    const outcome = await ingestConnectorDay("conn_1", DAY, {
      shopCampaignsFetcher: vi.fn(async () => []),
    });

    expect(outcome).toEqual({ kind: "synced", changed: true, rowsWritten: 0 });
    expect(adSpendRows).toHaveLength(0);
    expect(windowFor("conn_1", DATE)).toMatchObject({
      status: "SYNCED",
      rowsWritten: 0,
    });
    expect(connectorRow.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("persists an observed zero-spend Shop Campaign row rather than treating it as absent", async () => {
    connectorRow.provider = "SHOPIFY_SHOP_CAMPAIGNS";
    await ingestConnectorDay("conn_1", DAY, {
      shopCampaignsFetcher: vi.fn(async () => [
        {
          campaignId: "shop-campaign:Paused",
          campaignName: "Paused",
          spend: "0.00",
          impressions: 0,
          clicks: 0,
          conversions: 0,
          revenue: "0.00",
        },
      ]),
    });

    expect(adSpendRows).toHaveLength(1);
    expect(String(adSpendRows[0]!.spend)).toBe("0");
    expect(windowFor("conn_1", DATE)?.rowsWritten).toBe(1);
  });

  it("replaces a late ShopifyQL restatement without touching another tenant's spend", async () => {
    connectorRow.provider = "SHOPIFY_SHOP_CAMPAIGNS";
    adSpendRows.push({
      shopId: "shop_other",
      channel: "SHOP_CAMPAIGNS",
      date: DATE,
      campaignId: "other-store",
      spend: "99.00",
    });
    const fetchShopCampaigns = vi
      .fn()
      .mockResolvedValueOnce([
        {
          campaignId: "shop-campaign:Autumn",
          campaignName: "Autumn",
          spend: "10.00",
          impressions: 0,
          clicks: 0,
          conversions: 1,
          revenue: "40.00",
        },
      ])
      .mockResolvedValueOnce([
        {
          campaignId: "shop-campaign:Autumn",
          campaignName: "Autumn",
          spend: "12.00",
          impressions: 0,
          clicks: 0,
          conversions: 1,
          revenue: "40.00",
        },
      ]);

    await ingestConnectorDay("conn_1", DAY, { shopCampaignsFetcher: fetchShopCampaigns });
    const changedAt = windowFor("conn_1", DATE)!.lastChangedAt;
    await ingestConnectorDay("conn_1", DAY, {
      shopCampaignsFetcher: fetchShopCampaigns,
      now: () => new Date("2026-08-11T00:00:00Z"),
    });

    expect(String(adSpendRows.find((row) => row.shopId === "shop_1")!.spend)).toBe("12");
    expect(adSpendRows.find((row) => row.shopId === "shop_other")).toMatchObject({
      campaignId: "other-store",
      spend: "99.00",
    });
    expect(windowFor("conn_1", DATE)!.lastChangedAt).not.toBe(changedAt);
  });

  it("re-polls a stale Shop Campaigns window without rewriting unchanged data", async () => {
    connectorRow.provider = "SHOPIFY_SHOP_CAMPAIGNS";
    const fetchShopCampaigns = vi.fn(async () => [
      {
        campaignId: "shop-campaign:Autumn",
        campaignName: "Autumn",
        spend: "10.00",
        impressions: 0,
        clicks: 0,
        conversions: 1,
        revenue: "40.00",
      },
    ]);

    await ingestConnectorDay("conn_1", DAY, { shopCampaignsFetcher: fetchShopCampaigns });
    const changedAt = windowFor("conn_1", DATE)!.lastChangedAt;
    invalidateAnalyticsCache.mockClear();

    const outcome = await ingestConnectorDay("conn_1", DAY, {
      shopCampaignsFetcher: fetchShopCampaigns,
      now: () => new Date("2026-08-11T00:00:00Z"),
    });

    expect(outcome).toEqual({ kind: "synced", changed: false, rowsWritten: 0 });
    expect(windowFor("conn_1", DATE)).toMatchObject({
      attempts: 2,
      lastChangedAt: changedAt,
    });
    expect(invalidateAnalyticsCache).not.toHaveBeenCalled();
  });

  it("records a temporary ShopifyQL failure for the scheduler to retry", async () => {
    connectorRow.provider = "SHOPIFY_SHOP_CAMPAIGNS";
    await expect(
      ingestConnectorDay("conn_1", DAY, {
        shopCampaignsFetcher: vi.fn(async () => {
          throw new Error("ShopifyQL temporarily unavailable");
        }),
      }),
    ).rejects.toThrow("temporarily unavailable");

    expect(connectorRow).toMatchObject({ status: "CONNECTED" });
    expect(windowFor("conn_1", DATE)).toMatchObject({ status: "FAILED" });
  });

  it("pauses on missing ShopifyQL approval, then supports an explicit retry", async () => {
    connectorRow.provider = "SHOPIFY_SHOP_CAMPAIGNS";
    const blocked = new Error(
      "Level 2 protected customer data is not approved; request access",
    );
    await expect(
      ingestConnectorDay("conn_1", DAY, {
        shopCampaignsFetcher: vi.fn(async () => {
          throw blocked;
        }),
      }),
    ).rejects.toBeInstanceOf(ShopCampaignsAccessError);
    expect(connectorRow.status).toBe("ERROR");
    expect(windowFor("conn_1", DATE)).toMatchObject({ status: "FAILED" });

    connectorRow.status = "ERROR";
    const retry = await retryShopCampaignsConnector(
      "shop_1",
      new Date("2026-08-10T12:00:00Z"),
      { shopCampaignsFetcher: vi.fn(async () => []) },
    );
    expect(connectorRow.status).toBe("CONNECTED");
    expect(retry).toMatchObject({ ok: true });
  });

  it("pauses rather than retrying a report-access denial as a financial zero", async () => {
    connectorRow.provider = "SHOPIFY_SHOP_CAMPAIGNS";
    await expect(
      ingestConnectorDay("conn_1", DAY, {
        shopCampaignsFetcher: vi.fn(async () => {
          throw new Error("read_reports access scope is required");
        }),
      }),
    ).rejects.toBeInstanceOf(ShopCampaignsAccessError);

    expect(connectorRow).toMatchObject({ status: "ERROR" });
    expect(String(connectorRow.lastError)).toContain("reports access");
    expect(windowFor("conn_1", DATE)).toMatchObject({ status: "FAILED" });
  });
});
