import { Channel, ConnectorProvider } from "@prisma/client";

import {
  AdProviderAuthError,
  AdProviderRateLimitError,
  AdProviderTransientError,
  decimalString,
  integerCount,
  type AdAccountProfile,
  type AdPlatformAdapter,
  type AdPlatformAuth,
  type ProviderDailySpend,
} from "./types.server";

/**
 * Google Ads API — one GAQL `searchStream` per statistics day at campaign
 * granularity.
 *
 * Costs arrive in micros of the account currency. OAuth access tokens rotate
 * hourly; the ingester refreshes through `refreshGoogleAccessToken` below and
 * an auth failure *after* a refresh is a real revocation, not staleness.
 */

const API_VERSION = "v18";
const ADS_BASE = `https://googleads.googleapis.com/${API_VERSION}`;
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FETCH_TIMEOUT_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;

export interface GoogleAdsRow {
  campaign?: { id?: string | number; name?: string };
  metrics?: {
    costMicros?: string | number;
    impressions?: string | number;
    clicks?: string | number;
    conversions?: string | number;
    conversionsValue?: string | number;
  };
  customer?: { currencyCode?: string; descriptiveName?: string };
}

interface GoogleAdsStreamChunk {
  results?: GoogleAdsRow[];
}

interface GoogleAdsErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

/** Pure: one GAQL result row → the provider-neutral shape. */
export function parseGoogleAdsRow(row: GoogleAdsRow): ProviderDailySpend {
  const costMicros = Number(row.metrics?.costMicros ?? 0);
  return {
    campaignId: String(row.campaign?.id ?? ""),
    campaignName: row.campaign?.name ?? null,
    spend: decimalString(costMicros / 1_000_000),
    impressions: integerCount(row.metrics?.impressions),
    clicks: integerCount(row.metrics?.clicks),
    // Google reports fractional attributed conversions; keep the platform's
    // own rounding out of it until display.
    conversions: Math.round(Number(row.metrics?.conversions ?? 0) || 0),
    revenue: decimalString(row.metrics?.conversionsValue),
  };
}

/** Pure: map an error response onto the retry taxonomy. */
export function classifyGoogleAdsError(
  status: number,
  body: GoogleAdsErrorBody,
): AdProviderAuthError | AdProviderRateLimitError | AdProviderTransientError {
  const grpcStatus = body.error?.status ?? "";
  const message = body.error?.message ?? `HTTP ${status}`;

  if (status === 429 || grpcStatus === "RESOURCE_EXHAUSTED") {
    return new AdProviderRateLimitError(
      ConnectorProvider.GOOGLE_ADS,
      RATE_LIMIT_BACKOFF_MS,
    );
  }
  if (
    status === 401 ||
    status === 403 ||
    grpcStatus === "UNAUTHENTICATED" ||
    grpcStatus === "PERMISSION_DENIED"
  ) {
    return new AdProviderAuthError(ConnectorProvider.GOOGLE_ADS, message);
  }
  return new AdProviderTransientError(ConnectorProvider.GOOGLE_ADS, message);
}

function developerToken(): string {
  const token = process.env.MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!token) {
    throw new AdProviderAuthError(
      ConnectorProvider.GOOGLE_ADS,
      "MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN is not configured",
    );
  }
  return token;
}

/**
 * Exchange a refresh token for a fresh access token. Exported for the
 * ingester, which persists the rotated token back onto the connector.
 */
export async function refreshGoogleAccessToken(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const clientId = process.env.MERIDIAN_GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.MERIDIAN_GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AdProviderAuthError(
      ConnectorProvider.GOOGLE_ADS,
      "MERIDIAN_GOOGLE_ADS_CLIENT_ID/SECRET are not configured",
    );
  }

  let response: Response;
  try {
    response = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AdProviderTransientError(
      ConnectorProvider.GOOGLE_ADS,
      `token refresh network: ${String(error)}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    // invalid_grant means the merchant revoked access; that is an auth fact,
    // not a retry candidate.
    throw new AdProviderAuthError(
      ConnectorProvider.GOOGLE_ADS,
      body.error_description ?? body.error ?? `token HTTP ${response.status}`,
    );
  }
  return {
    accessToken: body.access_token,
    expiresInSeconds: body.expires_in ?? 3600,
  };
}

async function googleAdsSearch(
  auth: AdPlatformAuth,
  accountId: string,
  query: string,
  fetcher: typeof fetch,
): Promise<GoogleAdsRow[]> {
  const customerId = accountId.replace(/-/g, "");
  // Resolved before the request so a missing token surfaces as the auth
  // configuration fact it is, not as a "network failure" the worker retries.
  const devToken = developerToken();
  let response: Response;
  try {
    response = await fetcher(
      `${ADS_BASE}/customers/${customerId}/googleAds:searchStream`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "developer-token": devToken,
          "login-customer-id": customerId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new AdProviderTransientError(
      ConnectorProvider.GOOGLE_ADS,
      `network: ${String(error)}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const errorBody = (Array.isArray(body) ? body[0] : body) as
      | GoogleAdsErrorBody
      | undefined;
    throw classifyGoogleAdsError(response.status, errorBody ?? {});
  }

  // searchStream answers with an array of chunks, each carrying results.
  const chunks = (Array.isArray(body) ? body : [body]) as GoogleAdsStreamChunk[];
  return chunks.flatMap((chunk) => chunk.results ?? []);
}

export const googleAdsAdapter: AdPlatformAdapter = {
  provider: ConnectorProvider.GOOGLE_ADS,
  channel: Channel.GOOGLE,

  async fetchAccountProfile(
    auth: AdPlatformAuth,
    accountId: string,
    fetcher: typeof fetch = fetch,
  ): Promise<AdAccountProfile> {
    const rows = await googleAdsSearch(
      auth,
      accountId,
      "SELECT customer.currency_code, customer.descriptive_name FROM customer",
      fetcher,
    );
    const customer = rows[0]?.customer;
    return {
      currency: String(customer?.currencyCode ?? "USD").toUpperCase(),
      displayName: customer?.descriptiveName ?? null,
    };
  },

  async fetchDailySpend(
    auth: AdPlatformAuth,
    accountId: string,
    day: string,
    fetcher: typeof fetch = fetch,
  ) {
    const rows = await googleAdsSearch(
      auth,
      accountId,
      `SELECT campaign.id, campaign.name, metrics.cost_micros, ` +
        `metrics.impressions, metrics.clicks, metrics.conversions, ` +
        `metrics.conversions_value ` +
        `FROM campaign WHERE segments.date = '${day}' ` +
        `AND campaign.status != 'REMOVED'`,
      fetcher,
    );
    return rows
      .map(parseGoogleAdsRow)
      .filter((row) => row.campaignId !== "");
  },
};
