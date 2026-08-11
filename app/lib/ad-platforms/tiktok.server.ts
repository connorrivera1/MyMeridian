import { Channel, ConnectorProvider } from "@prisma/client";

import {
  AdProviderAuthError,
  AdProviderRateLimitError,
  AdProviderTransientError,
  decimalString,
  integerCount,
  type AdPlatformAdapter,
  type AdPlatformAuth,
  type ProviderDailySpend,
} from "./types.server";

/**
 * TikTok Business API — the integrated report at campaign granularity.
 *
 * TikTok answers HTTP 200 for almost everything and signals failure in the
 * body's `code`, so classification reads the envelope, not the status line.
 */

/** Overridable so staging and local debugging can point at a mock platform. */
const API_BASE =
  process.env.MERIDIAN_TIKTOK_API_BASE ??
  "https://business-api.tiktok.com/open_api/v1.3";
const PAGE_SIZE = 200;
const FETCH_TIMEOUT_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

/** Body codes TikTok documents for auth problems. */
const AUTH_CODES = new Set([40001, 40100, 40101, 40102, 40104, 40105]);
/** Body codes for throttling. */
const RATE_LIMIT_CODES = new Set([40016, 40100_1, 50002]);

export interface TikTokReportRow {
  dimensions?: { campaign_id?: string };
  metrics?: {
    campaign_name?: string;
    spend?: string | number;
    impressions?: string | number;
    clicks?: string | number;
    conversion?: string | number;
    total_complete_payment_rate?: string | number;
    total_onsite_shopping_value?: string | number;
    complete_payment?: string | number;
  };
}

interface TikTokEnvelope {
  code?: number;
  message?: string;
  data?: {
    list?: TikTokReportRow[];
    page_info?: { page?: number; total_page?: number };
    currency?: string;
    name?: string;
  };
}

/** Pure: one report row → the provider-neutral shape. */
export function parseTikTokReportRow(row: TikTokReportRow): ProviderDailySpend {
  const metrics = row.metrics ?? {};
  // TikTok's purchase-value metric name varies by report/account type; take
  // the first one present rather than guessing wrong and reporting zero.
  const revenue =
    metrics.total_onsite_shopping_value ??
    metrics.total_complete_payment_rate ??
    0;
  const conversions = metrics.complete_payment ?? metrics.conversion ?? 0;

  return {
    campaignId: String(row.dimensions?.campaign_id ?? ""),
    campaignName: metrics.campaign_name ?? null,
    spend: decimalString(metrics.spend),
    impressions: integerCount(metrics.impressions),
    clicks: integerCount(metrics.clicks),
    conversions: integerCount(conversions),
    revenue: decimalString(revenue),
  };
}

/** Pure: map a TikTok envelope onto the retry taxonomy; null means success. */
export function classifyTikTokEnvelope(
  status: number,
  envelope: TikTokEnvelope,
):
  | AdProviderAuthError
  | AdProviderRateLimitError
  | AdProviderTransientError
  | null {
  const code = envelope.code ?? (status >= 400 ? status : 0);
  if (code === 0) return null;

  const message = envelope.message ?? `code ${code}`;
  if (status === 429 || RATE_LIMIT_CODES.has(code)) {
    return new AdProviderRateLimitError(
      ConnectorProvider.TIKTOK_ADS,
      RATE_LIMIT_BACKOFF_MS,
    );
  }
  if (status === 401 || status === 403 || AUTH_CODES.has(code)) {
    return new AdProviderAuthError(ConnectorProvider.TIKTOK_ADS, message);
  }
  return new AdProviderTransientError(ConnectorProvider.TIKTOK_ADS, message);
}

async function tiktokRequest(
  path: string,
  params: Record<string, string>,
  auth: AdPlatformAuth,
  fetcher: typeof fetch,
): Promise<TikTokEnvelope> {
  const search = new URLSearchParams(params).toString();
  let response: Response;
  try {
    response = await fetcher(`${API_BASE}${path}?${search}`, {
      headers: { "Access-Token": auth.accessToken },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AdProviderTransientError(
      ConnectorProvider.TIKTOK_ADS,
      `network: ${String(error)}`,
    );
  }

  const envelope = (await response
    .json()
    .catch(() => ({}))) as TikTokEnvelope;
  const failure = classifyTikTokEnvelope(response.status, envelope);
  if (failure) throw failure;
  return envelope;
}

export const tiktokAdapter: AdPlatformAdapter = {
  provider: ConnectorProvider.TIKTOK_ADS,
  channel: Channel.TIKTOK,

  async fetchAccountProfile(
    auth: AdPlatformAuth,
    accountId: string,
    fetcher: typeof fetch = fetch,
  ) {
    const envelope = await tiktokRequest(
      "/advertiser/info/",
      { advertiser_ids: JSON.stringify([accountId]) },
      auth,
      fetcher,
    );
    const info = (envelope.data?.list?.[0] ?? {}) as {
      currency?: string;
      name?: string;
    };
    return {
      currency: String(info.currency ?? "USD").toUpperCase(),
      displayName: info.name ?? null,
    };
  },

  async fetchDailySpend(
    auth: AdPlatformAuth,
    accountId: string,
    day: string,
    fetcher: typeof fetch = fetch,
  ) {
    const rows: ProviderDailySpend[] = [];
    // TikTok pages by number and reports the total; bounded regardless.
    for (let page = 1; page <= 50; page += 1) {
      const envelope = await tiktokRequest(
        "/report/integrated/get/",
        {
          advertiser_id: accountId,
          report_type: "BASIC",
          data_level: "AUCTION_CAMPAIGN",
          dimensions: JSON.stringify(["campaign_id"]),
          metrics: JSON.stringify([
            "campaign_name",
            "spend",
            "impressions",
            "clicks",
            "conversion",
            "complete_payment",
            "total_onsite_shopping_value",
          ]),
          start_date: day,
          end_date: day,
          page: String(page),
          page_size: String(PAGE_SIZE),
        },
        auth,
        fetcher,
      );

      for (const row of envelope.data?.list ?? []) {
        const parsed = parseTikTokReportRow(row);
        if (parsed.campaignId !== "") rows.push(parsed);
      }

      const pageInfo = envelope.data?.page_info;
      if (!pageInfo || (pageInfo.page ?? page) >= (pageInfo.total_page ?? 1)) {
        break;
      }
    }
    return rows;
  },
};
