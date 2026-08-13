import {
  AdSyncWindowState,
  Channel,
  ConnectorProvider,
  ConnectorStatus,
  Prisma,
  type Connector,
} from "@prisma/client";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { contentHashFor } from "~/lib/ad-ingestion-plan";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { convertCents, fxRate } from "~/lib/fx.server";
import { googleAdsAdapter, refreshGoogleAccessToken } from "~/lib/ad-platforms/google.server";
import { metaAdapter } from "~/lib/ad-platforms/meta.server";
import { tiktokAdapter } from "~/lib/ad-platforms/tiktok.server";
import {
  fetchShopCampaignDailySpend,
  isShopCampaignsProtectedDataError,
  isShopCampaignsReportsAccessError,
  ShopCampaignsAccessError,
  SHOP_CAMPAIGNS_PROTECTED_DATA_ERROR,
  SHOP_CAMPAIGNS_REPORT_ACCESS_ERROR,
} from "~/lib/shop-campaigns.server";
import {
  AdProviderAuthError,
  AdProviderRateLimitError,
  type AdPlatformAdapter,
  type AdPlatformAuth,
  type ProviderDailySpend,
} from "~/lib/ad-platforms/types.server";

/**
 * One connector-day of ad-spend ingestion, from decrypted token to committed
 * rows and ledger stamp.
 *
 * This function is what the queue worker runs, but it does not know the queue
 * exists: given a connector id and an ISO day it is fully deterministic, which
 * is what lets the whole financial path be tested without Redis. Its
 * idempotency story is replacement — a channel-day is rewritten wholesale
 * inside a transaction with the ledger stamp, so a crash between any two
 * statements leaves either yesterday's complete truth or today's, never a mix.
 */

const GOOGLE_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 2_000;

const ADAPTERS: Partial<Record<ConnectorProvider, AdPlatformAdapter>> = {
  [ConnectorProvider.FACEBOOK_ADS]: metaAdapter,
  [ConnectorProvider.GOOGLE_ADS]: googleAdsAdapter,
  [ConnectorProvider.TIKTOK_ADS]: tiktokAdapter,
};

export function adapterForProvider(
  provider: ConnectorProvider,
): AdPlatformAdapter | null {
  return ADAPTERS[provider] ?? null;
}

export const PAID_AD_PROVIDERS = [
  ConnectorProvider.FACEBOOK_ADS,
  ConnectorProvider.GOOGLE_ADS,
  ConnectorProvider.TIKTOK_ADS,
  ConnectorProvider.SHOPIFY_SHOP_CAMPAIGNS,
] as const;

export interface IngestDeps {
  adapters?: Partial<Record<ConnectorProvider, AdPlatformAdapter>>;
  fetcher?: typeof fetch;
  now?: () => Date;
  shopCampaignsFetcher?: (
    shopDomain: string,
    day: string,
  ) => Promise<ProviderDailySpend[]>;
}

export type IngestOutcome =
  | { kind: "synced"; changed: boolean; rowsWritten: number }
  | { kind: "skipped"; reason: string };

function truncateError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

function decimal(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00";
}

/**
 * A usable access token for this connector, refreshing and persisting the
 * rotation when the provider requires it (Google's hourly OAuth tokens).
 */
async function freshAuth(
  connector: Connector,
  fetcher: typeof fetch,
  now: Date,
): Promise<AdPlatformAuth> {
  if (!connector.accessTokenEnc) {
    throw new AdProviderAuthError(
      connector.provider,
      "connector holds no access token",
    );
  }

  const needsRefresh =
    connector.provider === ConnectorProvider.GOOGLE_ADS &&
    connector.refreshTokenEnc !== null &&
    connector.tokenExpiresAt !== null &&
    connector.tokenExpiresAt.getTime() - now.getTime() <
      GOOGLE_TOKEN_REFRESH_MARGIN_MS;

  if (!needsRefresh) {
    return {
      accessToken: decryptSecret(connector.accessTokenEnc),
      refreshToken: connector.refreshTokenEnc
        ? decryptSecret(connector.refreshTokenEnc)
        : null,
    };
  }

  const refreshToken = decryptSecret(connector.refreshTokenEnc!);
  const rotated = await refreshGoogleAccessToken(refreshToken, fetcher);
  await prisma.connector.update({
    where: { id: connector.id },
    data: {
      accessTokenEnc: encryptSecret(rotated.accessToken),
      tokenExpiresAt: new Date(
        now.getTime() + rotated.expiresInSeconds * 1000,
      ),
    },
  });
  return { accessToken: rotated.accessToken, refreshToken };
}

function toAdSpendRows(
  shopId: string,
  channel: AdPlatformAdapter["channel"],
  day: string,
  rows: readonly ProviderDailySpend[],
  rate: number,
) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return rows.map((row) => ({
    shopId,
    date,
    channel,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    spend: new Prisma.Decimal(
      (convertCents(Math.round(Number(row.spend) * 100), rate) / 100).toFixed(2),
    ),
    impressions: row.impressions,
    clicks: row.clicks,
    platformConversions: row.conversions,
    platformRevenue: new Prisma.Decimal(
      (convertCents(Math.round(Number(row.revenue) * 100), rate) / 100).toFixed(
        2,
      ),
    ),
  }));
}

function toShopCampaignSpendRows(
  shopId: string,
  day: string,
  rows: readonly ProviderDailySpend[],
) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return rows.map((row) => ({
    shopId,
    date,
    channel: Channel.SHOP_CAMPAIGNS,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    // ShopifyQL documents every Shop Campaign money metric in the store's
    // currency, so unlike an external ad account no FX conversion is applied.
    spend: new Prisma.Decimal(decimal(row.spend)),
    impressions: 0,
    clicks: 0,
    // This is Shopify's campaign-attributed customer count, not a Meridian
    // order count. It remains separate from CAC's first-order cohort.
    platformConversions: row.conversions,
    // Shopify calls this campaign sales. It is a platform claim and stays
    // separate from Meridian's order-derived, refund-aware revenue.
    platformRevenue: new Prisma.Decimal(decimal(row.revenue)),
  }));
}

async function markWindowFailed(
  connector: Connector,
  day: string,
  error: unknown,
): Promise<void> {
  const date = new Date(`${day}T00:00:00.000Z`);
  const message = truncateError(error);
  await prisma.adSyncWindow.upsert({
    where: { connectorId_day: { connectorId: connector.id, day: date } },
    create: {
      shopId: connector.shopId,
      connectorId: connector.id,
      day: date,
      status: AdSyncWindowState.FAILED,
      attempts: 1,
      lastError: message,
    },
    update: {
      status: AdSyncWindowState.FAILED,
      attempts: { increment: 1 },
      lastError: message,
    },
  });
  await prisma.connector.update({
    where: { id: connector.id },
    data: { lastError: message },
  });
}

/** Ingest one statistics day for one connector. Throws for the worker's retry policy. */
export async function ingestConnectorDay(
  connectorId: string,
  day: string,
  deps: IngestDeps = {},
): Promise<IngestOutcome> {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now?.() ?? new Date();

  const connector = await prisma.connector.findUnique({
    where: { id: connectorId },
    include: {
      shop: { select: { id: true, domain: true, currency: true, isDemo: true } },
    },
  });
  if (!connector) return { kind: "skipped", reason: "connector missing" };
  if (connector.shop.isDemo) {
    return { kind: "skipped", reason: "demo shops never ingest live spend" };
  }
  if (connector.status === ConnectorStatus.DISCONNECTED) {
    return { kind: "skipped", reason: "connector disconnected" };
  }
  if (connector.provider === ConnectorProvider.SHOPIFY_SHOP_CAMPAIGNS) {
    return ingestShopCampaignsDay(connector, day, now, deps);
  }
  if (!connector.externalAccountId) {
    return { kind: "skipped", reason: "no ad account selected" };
  }

  const adapter =
    deps.adapters?.[connector.provider] ?? adapterForProvider(connector.provider);
  if (!adapter) {
    return { kind: "skipped", reason: `no adapter for ${connector.provider}` };
  }

  try {
    const auth = await freshAuth(connector, fetcher, now);

    // Pin the billing currency once; spend in a currency we have not pinned
    // cannot be converted honestly.
    let accountCurrency = connector.accountCurrency;
    if (!accountCurrency) {
      const profile = await adapter.fetchAccountProfile(
        auth,
        connector.externalAccountId,
        fetcher,
      );
      accountCurrency = profile.currency;
      await prisma.connector.update({
        where: { id: connector.id },
        data: {
          accountCurrency,
          displayName: connector.displayName ?? profile.displayName,
        },
      });
    }

    const fetched = await adapter.fetchDailySpend(
      auth,
      connector.externalAccountId,
      day,
      fetcher,
    );

    const hash = contentHashFor(fetched);
    const date = new Date(`${day}T00:00:00.000Z`);
    const existing = await prisma.adSyncWindow.findUnique({
      where: { connectorId_day: { connectorId: connector.id, day: date } },
    });

    if (
      existing?.status === AdSyncWindowState.SYNCED &&
      existing.contentHash === hash
    ) {
      // A restatement poll that restated nothing. Stamp liveness, skip the
      // rewrite, and — the part that matters — skip invalidating profit.
      await prisma.adSyncWindow.update({
        where: { id: existing.id },
        data: { syncedAt: now, attempts: { increment: 1 }, lastError: null },
      });
      await prisma.connector.update({
        where: { id: connector.id },
        data: { lastSyncedAt: now, lastError: null },
      });
      return { kind: "synced", changed: false, rowsWritten: 0 };
    }

    const rate = await fxRate(date, accountCurrency, connector.shop.currency, fetcher);
    const rows = toAdSpendRows(
      connector.shopId,
      adapter.channel,
      day,
      fetched,
      rate,
    );

    // Replacement is the idempotency mechanism: campaigns deleted upstream
    // disappear here too, and a crash mid-transaction leaves the previous
    // complete day, never half of each.
    await prisma.$transaction(async (tx) => {
      await tx.adSpend.deleteMany({
        where: { shopId: connector.shopId, channel: adapter.channel, date },
      });
      if (rows.length > 0) {
        await tx.adSpend.createMany({ data: rows });
      }
      await tx.adSyncWindow.upsert({
        where: { connectorId_day: { connectorId: connector.id, day: date } },
        create: {
          shopId: connector.shopId,
          connectorId: connector.id,
          day: date,
          status: AdSyncWindowState.SYNCED,
          attempts: 1,
          rowsWritten: rows.length,
          contentHash: hash,
          syncedAt: now,
          lastChangedAt: now,
        },
        update: {
          status: AdSyncWindowState.SYNCED,
          attempts: { increment: 1 },
          rowsWritten: rows.length,
          contentHash: hash,
          syncedAt: now,
          // In the same transaction as the rows it describes: if this commit
          // lands, the stale-profit sweep can always see it, no matter what
          // happens to the in-flight recompute enqueue afterwards.
          lastChangedAt: now,
          lastError: null,
        },
      });
      await tx.connector.update({
        where: { id: connector.id },
        data: {
          lastSyncedAt: now,
          lastError: null,
          // A connector that had erred and now answers again has healed.
          status: ConnectorStatus.CONNECTED,
        },
      });
    });

    invalidateAnalyticsCache();
    return { kind: "synced", changed: true, rowsWritten: rows.length };
  } catch (error) {
    if (error instanceof AdProviderRateLimitError) {
      // Not a failure of this day — the platform asked us to slow down. The
      // ledger row stays due and the worker delays the whole provider queue.
      throw error;
    }
    if (error instanceof AdProviderAuthError) {
      await prisma.connector.update({
        where: { id: connector.id },
        data: {
          status: ConnectorStatus.ERROR,
          lastError: truncateError(error),
        },
      });
      await markWindowFailed(connector, day, error);
      throw error;
    }
    await markWindowFailed(connector, day, error);
    throw error;
  }
}

/**
 * Ingest the ShopifyQL Shop Campaigns source without an additional OAuth
 * credential. Its daily replacement semantics are intentionally identical to
 * the other spend connectors: a late Shopify restatement replaces one complete
 * channel-day and updates the durable sync ledger in the same transaction.
 */
async function ingestShopCampaignsDay(
  connector: Connector & {
    shop: { id: string; currency: string; isDemo: boolean; domain?: string };
  },
  day: string,
  now: Date,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const domain = connector.shop.domain;
  if (!domain) {
    const error = new Error("Shop Campaigns connector has no Shopify domain");
    await markWindowFailed(connector, day, error);
    throw error;
  }

  try {
    const fetched = await (deps.shopCampaignsFetcher ?? fetchShopCampaignDailySpend)(
      domain,
      day,
    );
    const hash = contentHashFor(fetched);
    const date = new Date(`${day}T00:00:00.000Z`);
    const existing = await prisma.adSyncWindow.findUnique({
      where: { connectorId_day: { connectorId: connector.id, day: date } },
    });

    if (
      existing?.status === AdSyncWindowState.SYNCED &&
      existing.contentHash === hash
    ) {
      await prisma.adSyncWindow.update({
        where: { id: existing.id },
        data: { syncedAt: now, attempts: { increment: 1 }, lastError: null },
      });
      await prisma.connector.update({
        where: { id: connector.id },
        data: { lastSyncedAt: now, lastError: null },
      });
      return { kind: "synced", changed: false, rowsWritten: 0 };
    }

    const rows = toShopCampaignSpendRows(connector.shopId, day, fetched);
    await prisma.$transaction(async (tx) => {
      await tx.adSpend.deleteMany({
        where: {
          shopId: connector.shopId,
          channel: Channel.SHOP_CAMPAIGNS,
          date,
        },
      });
      if (rows.length > 0) await tx.adSpend.createMany({ data: rows });
      await tx.adSyncWindow.upsert({
        where: { connectorId_day: { connectorId: connector.id, day: date } },
        create: {
          shopId: connector.shopId,
          connectorId: connector.id,
          day: date,
          status: AdSyncWindowState.SYNCED,
          attempts: 1,
          rowsWritten: rows.length,
          contentHash: hash,
          syncedAt: now,
          lastChangedAt: now,
        },
        update: {
          status: AdSyncWindowState.SYNCED,
          attempts: { increment: 1 },
          rowsWritten: rows.length,
          contentHash: hash,
          syncedAt: now,
          lastChangedAt: now,
          lastError: null,
        },
      });
      await tx.connector.update({
        where: { id: connector.id },
        data: {
          status: ConnectorStatus.CONNECTED,
          lastSyncedAt: now,
          lastError: null,
        },
      });
    });
    invalidateAnalyticsCache();
    return { kind: "synced", changed: true, rowsWritten: rows.length };
  } catch (error) {
    const protectedDataBlocked = isShopCampaignsProtectedDataError(error);
    const reportsAccessBlocked = isShopCampaignsReportsAccessError(error);
    const message = protectedDataBlocked
      ? SHOP_CAMPAIGNS_PROTECTED_DATA_ERROR
      : reportsAccessBlocked
        ? SHOP_CAMPAIGNS_REPORT_ACCESS_ERROR
        : truncateError(error);
    await markWindowFailed(connector, day, new Error(message));
    if (protectedDataBlocked || reportsAccessBlocked) {
      // Approval does not alter an OAuth scope. Stop background retries until
      // a merchant retries after the publisher's Shopify approval changes.
      await prisma.connector.update({
        where: { id: connector.id },
        data: { status: ConnectorStatus.ERROR, lastError: message },
      });
      throw new ShopCampaignsAccessError(message);
    }
    throw error;
  }
}

/**
 * Ledger rows for every day the horizon says this connector owes. Idempotent;
 * the scheduler calls it each cycle so brand-new days and freshly connected
 * accounts both materialise as visible PENDING work.
 */
export async function ensureSyncWindows(
  connector: Pick<Connector, "id" | "shopId">,
  days: readonly string[],
): Promise<void> {
  if (days.length === 0) return;
  await prisma.adSyncWindow.createMany({
    data: days.map((day) => ({
      shopId: connector.shopId,
      connectorId: connector.id,
      day: new Date(`${day}T00:00:00.000Z`),
      status: AdSyncWindowState.PENDING,
    })),
    skipDuplicates: true,
  });
}

export interface ConnectorSyncState {
  connector: Connector;
  syncedDays: Set<string>;
  earliestWindowDay: string | null;
}

/** Everything the planner needs about one connector, in one read. */
export async function loadConnectorSyncState(
  connectorId: string,
): Promise<ConnectorSyncState | null> {
  const connector = await prisma.connector.findUnique({
    where: { id: connectorId },
  });
  if (!connector) return null;

  const windows = await prisma.adSyncWindow.findMany({
    where: { connectorId },
    select: { day: true, status: true },
    orderBy: { day: "asc" },
  });

  const syncedDays = new Set<string>();
  for (const window of windows) {
    if (window.status === AdSyncWindowState.SYNCED) {
      syncedDays.add(window.day.toISOString().slice(0, 10));
    }
  }

  return {
    connector,
    syncedDays,
    earliestWindowDay:
      windows.length > 0
        ? windows[0]!.day.toISOString().slice(0, 10)
        : null,
  };
}

/**
 * Shops whose synced spend changed after their last profit materialisation.
 *
 * The durable recompute signal. The fast path — enqueue straight after a
 * changed ingest — can be lost to a crash between the ledger commit and the
 * queue add, or to a Redis flush; this query re-derives the debt from the
 * ledger itself, so the scheduling cycle can always pay it.
 */
export async function listShopsWithStaleProfit(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ shopId: string }>>`
    SELECT DISTINCT w."shopId"
    FROM "AdSyncWindow" w
    JOIN "Shop" s ON s.id = w."shopId"
    WHERE w."lastChangedAt" IS NOT NULL
      AND (s."lastComputedAt" IS NULL OR w."lastChangedAt" > s."lastComputedAt")
  `;
  return rows.map((row) => row.shopId);
}

/** Connectors the scheduler should be polling for this whole deployment. */
export async function listPollableConnectors(): Promise<
  Array<Pick<Connector, "id" | "shopId" | "provider">>
> {
  return prisma.connector.findMany({
    where: {
      shop: { isDemo: false, uninstalledAt: null },
      OR: [
        {
          provider: {
            in: [
              ConnectorProvider.FACEBOOK_ADS,
              ConnectorProvider.GOOGLE_ADS,
              ConnectorProvider.TIKTOK_ADS,
            ],
          },
          status: { in: [ConnectorStatus.CONNECTED, ConnectorStatus.ERROR] },
          externalAccountId: { not: null },
          accessTokenEnc: { not: null },
        },
        {
          provider: ConnectorProvider.SHOPIFY_SHOP_CAMPAIGNS,
          status: ConnectorStatus.CONNECTED,
        },
      ],
    },
    select: { id: true, shopId: true, provider: true },
  });
}

/** Retry the ShopifyQL source after the publisher's Level 2 approval changes. */
export async function retryShopCampaignsConnector(
  shopId: string,
  now = new Date(),
  deps: IngestDeps = {},
) {
  const connector = await prisma.connector.findUnique({
    where: {
      shopId_provider: {
        shopId,
        provider: ConnectorProvider.SHOPIFY_SHOP_CAMPAIGNS,
      },
    },
    select: { id: true },
  });
  if (!connector) {
    return {
      ok: false as const,
      message: "Shop Campaigns is not configured for this store.",
    };
  }

  await prisma.connector.update({
    where: { id: connector.id },
    data: { status: ConnectorStatus.CONNECTED, lastError: null },
  });
  try {
    const result = await ingestConnectorDay(
      connector.id,
      now.toISOString().slice(0, 10),
      { ...deps, now: () => now },
    );
    return result.kind === "synced"
      ? {
          ok: true as const,
          message: "Shop Campaigns reporting is active.",
        }
      : { ok: false as const, message: result.reason };
  } catch {
    const refreshed = await prisma.connector.findUnique({
      where: { id: connector.id },
      select: { lastError: true },
    });
    return {
      ok: false as const,
      message:
        refreshed?.lastError ?? "Shop Campaigns could not be reconnected.",
    };
  }
}
