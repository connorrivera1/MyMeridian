import type { Channel, ConnectorProvider } from "@prisma/client";

/**
 * The contract every ad-platform adapter satisfies, and the error taxonomy the
 * worker's retry policy is built on.
 *
 * The taxonomy is the resilience mechanism: a 429 must delay the whole
 * provider's queue (the limit is per ad account or app, not per job), an
 * expired token must fail fast and mark the connector rather than burn seven
 * retries, and a 500 must back off and try again. Collapsing those into one
 * generic error is how polling systems either hammer a platform or silently
 * stop syncing.
 */

export class AdProviderAuthError extends Error {
  readonly kind = "auth" as const;

  constructor(provider: ConnectorProvider, detail: string) {
    super(`${provider}: authorization failed — ${detail}`);
    this.name = "AdProviderAuthError";
  }
}

export class AdProviderRateLimitError extends Error {
  readonly kind = "rate-limit" as const;

  constructor(
    provider: ConnectorProvider,
    /** How long the platform asked us to stay away. */
    readonly retryAfterMs: number,
  ) {
    super(`${provider}: rate limited, retry after ${retryAfterMs}ms`);
    this.name = "AdProviderRateLimitError";
  }
}

export class AdProviderTransientError extends Error {
  readonly kind = "transient" as const;

  constructor(provider: ConnectorProvider, detail: string) {
    super(`${provider}: transient failure — ${detail}`);
    this.name = "AdProviderTransientError";
  }
}

/** One campaign's performance for one statistics day, as the platform reports it. */
export interface ProviderDailySpend {
  campaignId: string;
  campaignName: string | null;
  /** Decimal string in the ad account's billing currency. */
  spend: string;
  impressions: number;
  clicks: number;
  /** What the platform claims it converted/drove — kept, never trusted. */
  conversions: number;
  /** Decimal string, account currency; "0.00" when the platform reports none. */
  revenue: string;
}

export interface AdAccountProfile {
  /** ISO 4217 billing currency of the ad account. */
  currency: string;
  displayName: string | null;
}

export interface AdPlatformAuth {
  accessToken: string;
  /** Present only for providers whose tokens rotate (Google). */
  refreshToken?: string | null;
  /**
   * Google Ads requires the managing customer id when the selected advertiser
   * is reachable only through an MCC. Directly authorized advertisers leave
   * this unset; sending their own id as a manager header is not equivalent.
   */
  loginCustomerId?: string | null;
}

export interface AdPlatformAdapter {
  provider: ConnectorProvider;
  channel: Channel;
  /** Account metadata — read at connect/first sync to pin the currency. */
  fetchAccountProfile(
    auth: AdPlatformAuth,
    accountId: string,
    fetcher?: typeof fetch,
  ): Promise<AdAccountProfile>;
  /** All campaign rows for one statistics day, fully paginated. */
  fetchDailySpend(
    auth: AdPlatformAuth,
    accountId: string,
    day: string,
    fetcher?: typeof fetch,
  ): Promise<ProviderDailySpend[]>;
}

/** Decimal-string coercion for money fields platforms send as number or string. */
export function decimalString(value: unknown): string {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00";
}

export function integerCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}
