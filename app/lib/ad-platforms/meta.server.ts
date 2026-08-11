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
 * Meta (Facebook/Instagram) Marketing API — campaign-level daily insights.
 *
 * One request per statistics day with `time_increment=1`, paginated with the
 * cursor Meta returns. Purchases are buried in the `actions`/`action_values`
 * arrays under several action types depending on pixel setup; the omni type
 * is preferred because it deduplicates across placements.
 */

const GRAPH_VERSION = "v21.0";
/** Overridable so staging and local debugging can point at a mock platform. */
const GRAPH_BASE =
  process.env.MERIDIAN_META_API_BASE ??
  `https://graph.facebook.com/${GRAPH_VERSION}`;
const PAGE_SIZE = 200;
const FETCH_TIMEOUT_MS = 30_000;

/** Meta error codes that mean the token, not the request, is the problem. */
const AUTH_ERROR_CODES = new Set([102, 190, 200, 10]);
/** Codes Meta documents as throttling. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004]);
const RATE_LIMIT_BACKOFF_MS = 60_000;

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
}

interface MetaAction {
  action_type?: string;
  value?: string | number;
}

export interface MetaInsightRow {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
}

interface MetaInsightsPage {
  data?: MetaInsightRow[];
  paging?: { next?: string };
}

const PURCHASE_ACTION_TYPES = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
];

function purchaseMetric(actions: MetaAction[] | undefined): number {
  if (!Array.isArray(actions)) return 0;
  for (const type of PURCHASE_ACTION_TYPES) {
    const match = actions.find((action) => action.action_type === type);
    if (match) return Number(match.value ?? 0) || 0;
  }
  return 0;
}

/** Pure: one Meta insights row → the provider-neutral shape. */
export function parseMetaInsightRow(row: MetaInsightRow): ProviderDailySpend {
  return {
    campaignId: String(row.campaign_id ?? ""),
    campaignName: row.campaign_name ?? null,
    spend: decimalString(row.spend),
    impressions: integerCount(row.impressions),
    clicks: integerCount(row.clicks),
    conversions: Math.round(purchaseMetric(row.actions)),
    revenue: decimalString(purchaseMetric(row.action_values)),
  };
}

/** Pure: map a non-OK Meta response onto the retry taxonomy. */
export function classifyMetaError(
  status: number,
  body: MetaErrorBody,
): AdProviderAuthError | AdProviderRateLimitError | AdProviderTransientError {
  const code = body.error?.code;
  const message = body.error?.message ?? `HTTP ${status}`;

  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return new AdProviderRateLimitError(
      ConnectorProvider.FACEBOOK_ADS,
      RATE_LIMIT_BACKOFF_MS,
    );
  }
  if (
    status === 401 ||
    status === 403 ||
    (code !== undefined && AUTH_ERROR_CODES.has(code))
  ) {
    return new AdProviderAuthError(ConnectorProvider.FACEBOOK_ADS, message);
  }
  return new AdProviderTransientError(ConnectorProvider.FACEBOOK_ADS, message);
}

async function metaRequest(
  url: string,
  fetcher: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AdProviderTransientError(
      ConnectorProvider.FACEBOOK_ADS,
      `network: ${String(error)}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as MetaErrorBody;
  if (!response.ok || body.error) {
    throw classifyMetaError(response.status, body);
  }
  return body;
}

function accountPath(accountId: string): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

export const metaAdapter: AdPlatformAdapter = {
  provider: ConnectorProvider.FACEBOOK_ADS,
  channel: Channel.FACEBOOK,

  async fetchAccountProfile(
    auth: AdPlatformAuth,
    accountId: string,
    fetcher: typeof fetch = fetch,
  ) {
    const url =
      `${GRAPH_BASE}/${accountPath(accountId)}` +
      `?fields=currency,name&access_token=${encodeURIComponent(auth.accessToken)}`;
    const body = (await metaRequest(url, fetcher)) as {
      currency?: string;
      name?: string;
    };
    return {
      currency: String(body.currency ?? "USD").toUpperCase(),
      displayName: body.name ?? null,
    };
  },

  async fetchDailySpend(
    auth: AdPlatformAuth,
    accountId: string,
    day: string,
    fetcher: typeof fetch = fetch,
  ) {
    const timeRange = encodeURIComponent(
      JSON.stringify({ since: day, until: day }),
    );
    let url: string | undefined =
      `${GRAPH_BASE}/${accountPath(accountId)}/insights` +
      `?level=campaign` +
      `&fields=campaign_id,campaign_name,spend,impressions,clicks,actions,action_values` +
      `&time_range=${timeRange}&time_increment=1&limit=${PAGE_SIZE}` +
      `&access_token=${encodeURIComponent(auth.accessToken)}`;

    const rows: ProviderDailySpend[] = [];
    // Meta pages with a fully-qualified `next` URL that already carries the
    // token. Bounded so a pathological cursor loop cannot spin forever.
    for (let page = 0; url && page < 50; page += 1) {
      const body = (await metaRequest(url, fetcher)) as MetaInsightsPage;
      for (const row of body.data ?? []) {
        const parsed = parseMetaInsightRow(row);
        if (parsed.campaignId !== "") rows.push(parsed);
      }
      url = body.paging?.next;
    }
    return rows;
  },
};
