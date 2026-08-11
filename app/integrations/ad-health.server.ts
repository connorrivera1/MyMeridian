import { createHmac } from "node:crypto";

import {
  ConnectorHealthEventKind,
  ConnectorHealthStatus,
  ConnectorProvider,
  ConnectorStatus,
  type Connector,
} from "@prisma/client";

import prisma from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { withConnectorWork } from "./lease.server";

const AD_PROVIDERS = [
  ConnectorProvider.FACEBOOK_ADS,
  ConnectorProvider.GOOGLE_ADS,
  ConnectorProvider.TIKTOK_ADS,
] as const;

export const AD_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export interface AdHealthEnvironment {
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  MERIDIAN_GOOGLE_ADS_CLIENT_ID?: string;
  MERIDIAN_GOOGLE_ADS_CLIENT_SECRET?: string;
  MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  CONNECTOR_ALERT_WEBHOOK_URL?: string;
  CONNECTOR_ALERT_WEBHOOK_SECRET?: string;
}

function googleClientId(env: AdHealthEnvironment) {
  return env.MERIDIAN_GOOGLE_ADS_CLIENT_ID ?? env.GOOGLE_ADS_CLIENT_ID;
}

function googleClientSecret(env: AdHealthEnvironment) {
  return env.MERIDIAN_GOOGLE_ADS_CLIENT_SECRET ?? env.GOOGLE_ADS_CLIENT_SECRET;
}

function googleDeveloperToken(env: AdHealthEnvironment) {
  return env.MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN ?? env.GOOGLE_ADS_DEVELOPER_TOKEN;
}

export interface ProbeResult {
  healthy: boolean;
  authFailure: boolean;
  message: string;
  expiresAt?: Date | null;
}

function safeMessage(value: unknown, token?: string) {
  const message = String(value ?? "Unknown provider response").slice(0, 600);
  return token ? message.replaceAll(token, "[redacted]") : message;
}

async function json(response: Response): Promise<Record<string, any>> {
  try {
    return (await response.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

export async function probeAdToken(
  provider: ConnectorProvider,
  token: string,
  env: AdHealthEnvironment = process.env as AdHealthEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<ProbeResult> {
  if (provider === ConnectorProvider.FACEBOOK_ADS) {
    if (!env.META_APP_ID || !env.META_APP_SECRET) {
      return { healthy: false, authFailure: false, message: "Meta app credentials are not configured." };
    }
    const url = new URL("https://graph.facebook.com/debug_token");
    url.searchParams.set("input_token", token);
    url.searchParams.set("access_token", `${env.META_APP_ID}|${env.META_APP_SECRET}`);
    const response = await fetcher(url, { headers: { Accept: "application/json" } });
    const body = await json(response);
    const valid = response.ok && body.data?.is_valid === true;
    if (!valid) {
      return {
        healthy: false,
        authFailure:
          response.status === 401 ||
          response.status === 403 ||
          body.data?.is_valid === false,
        message: safeMessage(
          body.error?.message ?? "Meta rejected the access token.",
          token,
        ),
        expiresAt: body.data?.expires_at
          ? new Date(Number(body.data.expires_at) * 1000)
          : null,
      };
    }

    // A valid token is not enough: the merchant may have removed every ad
    // account while the token itself remains active. Probe actual account
    // access so that this state is treated as a connector disconnect.
    const accountsResponse = await fetcher(
      "https://graph.facebook.com/me/adaccounts?fields=id&limit=1",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
    );
    const accountsBody = await json(accountsResponse);
    const accounts = Array.isArray(accountsBody.data) ? accountsBody.data : [];
    const hasAccountAccess = accountsResponse.ok && accounts.length > 0;
    return {
      healthy: hasAccountAccess,
      authFailure:
        accountsResponse.status === 401 ||
        accountsResponse.status === 403 ||
        (accountsResponse.ok && accounts.length === 0),
      message: hasAccountAccess
        ? "Meta token can access an ad account."
        : accountsResponse.ok
          ? "Meta token is valid but no ad accounts are accessible."
          : safeMessage(
              accountsBody.error?.message ??
                `Meta ad-account access returned HTTP ${accountsResponse.status}.`,
              token,
            ),
      expiresAt: body.data?.expires_at ? new Date(Number(body.data.expires_at) * 1000) : null,
    };
  }

  if (provider === ConnectorProvider.GOOGLE_ADS) {
    const developerToken = googleDeveloperToken(env);
    if (!developerToken) {
      return { healthy: false, authFailure: false, message: "Google Ads developer token is not configured." };
    }
    const response = await fetcher(
      "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          Accept: "application/json",
        },
      },
    );
    const body = await json(response);
    const resources = Array.isArray(body.resourceNames) ? body.resourceNames : [];
    const healthy = response.ok && resources.length > 0;
    return {
      healthy,
      authFailure:
        response.status === 401 ||
        response.status === 403 ||
        (response.ok && resources.length === 0),
      message: healthy
        ? "Google Ads token can list accessible customers."
        : response.ok
          ? "Google Ads token is valid but no customers are accessible."
        : safeMessage(body.error?.message ?? `Google Ads returned HTTP ${response.status}.`, token),
    };
  }

  if (provider === ConnectorProvider.TIKTOK_ADS) {
    const response = await fetcher(
      "https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/",
      { headers: { "Access-Token": token, Accept: "application/json" } },
    );
    const body = await json(response);
    const advertisers = Array.isArray(body.data?.list) ? body.data.list : [];
    const providerAccepted = response.ok && Number(body.code) === 0;
    const healthy = providerAccepted && advertisers.length > 0;
    return {
      healthy,
      authFailure:
        response.status === 401 ||
        response.status === 403 ||
        (providerAccepted && advertisers.length === 0) ||
        (!healthy && /token|auth|permission/i.test(String(body.message ?? ""))),
      message: healthy
        ? "TikTok token can list authorized advertisers."
        : providerAccepted
          ? "TikTok token is valid but no advertisers are authorized."
        : safeMessage(body.message ?? `TikTok returned HTTP ${response.status}.`, token),
    };
  }

  return { healthy: false, authFailure: false, message: `${provider} is not an ad connector.` };
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
  env: AdHealthEnvironment = process.env as AdHealthEnvironment,
  fetcher: typeof fetch = fetch,
) {
  const clientId = googleClientId(env);
  const clientSecret = googleClientSecret(env);
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth client credentials are not configured.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const response = await fetcher("https://www.googleapis.com/oauth2/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = await json(response);
  if (!response.ok || !result.access_token) {
    throw new Error(safeMessage(result.error_description ?? result.error ?? `Google OAuth returned HTTP ${response.status}.`, refreshToken));
  }
  return {
    token: String(result.access_token),
    expiresAt: new Date(Date.now() + Math.max(60, Number(result.expires_in ?? 3600)) * 1000),
  };
}

export function nextHealthCheckAt(now: Date, consecutiveFailures: number) {
  if (consecutiveFailures <= 0) return new Date(now.getTime() + AD_HEALTH_INTERVAL_MS);
  const delay = Math.min(MAX_BACKOFF_MS, AD_HEALTH_INTERVAL_MS * 2 ** Math.min(10, consecutiveFailures - 1));
  return new Date(now.getTime() + delay);
}

export async function sendConnectorAlert(
  payload: Record<string, unknown>,
  env: AdHealthEnvironment = process.env as AdHealthEnvironment,
  fetcher: typeof fetch = fetch,
) {
  if (!env.CONNECTOR_ALERT_WEBHOOK_URL) return { sent: false, reason: "No alert webhook is configured." };
  const url = new URL(env.CONNECTOR_ALERT_WEBHOOK_URL);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("CONNECTOR_ALERT_WEBHOOK_URL must use HTTPS outside localhost.");
  }
  if (!env.CONNECTOR_ALERT_WEBHOOK_SECRET) {
    throw new Error("CONNECTOR_ALERT_WEBHOOK_SECRET is required when an alert webhook is configured.");
  }
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", env.CONNECTOR_ALERT_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Meridian-Signature": `sha256=${signature}`,
    },
    body,
  });
  if (!response.ok) throw new Error(`Connector alert webhook returned HTTP ${response.status}.`);
  return { sent: true, reason: null };
}

type HealthConnector = Pick<
  Connector,
  | "id" | "shopId" | "provider" | "accessTokenEnc" | "refreshTokenEnc"
  | "tokenExpiresAt" | "standbyAccessTokenEnc" | "standbyRefreshTokenEnc"
  | "standbyTokenExpiresAt" | "consecutiveFailures" | "failoverCount"
  | "status" | "healthStatus"
> & { shop: { domain: string } };

async function recordEvent(
  connector: HealthConnector,
  kind: ConnectorHealthEventKind,
  status: ConnectorHealthStatus,
  message: string,
  attempt: number,
) {
  return prisma.connectorHealthEvent.create({
    data: {
      shopId: connector.shopId,
      connectorId: connector.id,
      provider: connector.provider,
      kind,
      status,
      message: message.slice(0, 1000),
      attempt,
    },
  });
}

async function refreshPrimary(
  connector: HealthConnector,
  now: Date,
  env: AdHealthEnvironment,
  fetcher: typeof fetch,
) {
  if (connector.provider !== ConnectorProvider.GOOGLE_ADS || !connector.refreshTokenEnc) return null;
  const refreshed = await refreshGoogleAccessToken(decryptSecret(connector.refreshTokenEnc), env, fetcher);
  await prisma.connector.update({
    where: { id: connector.id },
    data: { accessTokenEnc: encryptSecret(refreshed.token), tokenExpiresAt: refreshed.expiresAt },
  });
  await recordEvent(connector, ConnectorHealthEventKind.TOKEN_REFRESHED, ConnectorHealthStatus.HEALTHY, "Google Ads access token refreshed before probe.", connector.consecutiveFailures + 1);
  return refreshed;
}

async function persistConnectorFailure(
  connector: HealthConnector,
  now: Date,
  env: AdHealthEnvironment,
  fetcher: typeof fetch,
  message: string,
  confirmedDisconnect = false,
) {
  const safeFailure = safeMessage(message);
  const failures = connector.consecutiveFailures + 1;
  const unhealthy = confirmedDisconnect || failures >= 3;
  const status = unhealthy ? ConnectorHealthStatus.UNHEALTHY : ConnectorHealthStatus.DEGRADED;
  const event = await recordEvent(connector, ConnectorHealthEventKind.CHECK_FAILED, status, safeFailure, failures);
  await prisma.connector.update({
    where: { id: connector.id },
    data: {
      status: confirmedDisconnect
        ? ConnectorStatus.DISCONNECTED
        : failures >= 3
          ? ConnectorStatus.ERROR
          : ConnectorStatus.CONNECTED,
      healthStatus: status,
      lastHealthCheckedAt: now,
      nextHealthCheckAt: nextHealthCheckAt(now, failures),
      consecutiveFailures: failures,
      lastError: safeFailure.slice(0, 1000),
    },
  });

  // A provider-auth rejection is a confirmed disconnect, not a speculative
  // outage: notify on the transition immediately. Operational failures need
  // three consecutive probes. Failure three is also one bounded escalation
  // for a disconnect that remains unresolved; later retries do not spam.
  const shouldAlert =
    (confirmedDisconnect && connector.status !== ConnectorStatus.DISCONNECTED) ||
    failures === 3;
  if (shouldAlert) {
    try {
      const alert = await sendConnectorAlert({
        type: "meridian.connector.unhealthy",
        eventId: event.id,
        shop: connector.shop.domain,
        provider: connector.provider,
        status,
        consecutiveFailures: failures,
        confirmedDisconnect,
        message: safeFailure,
        checkedAt: now.toISOString(),
      }, env, fetcher);
      if (alert.sent) {
        await prisma.connectorHealthEvent.update({
          where: { id: event.id },
          data: { notifiedAt: now },
        });
        await recordEvent(connector, ConnectorHealthEventKind.ALERT_SENT, status, "Signed connector-health alert delivered.", failures);
      } else {
        await recordEvent(
          connector,
          ConnectorHealthEventKind.ALERT_FAILED,
          status,
          alert.reason ?? "Connector alert was not delivered.",
          failures,
        );
        console.error(`[connector-health] ${connector.shop.domain} ${connector.provider}: ${safeFailure}`);
      }
    } catch (error) {
      await recordEvent(connector, ConnectorHealthEventKind.ALERT_FAILED, status, safeMessage(error), failures);
      console.error(`[connector-health] alert failed for ${connector.shop.domain} ${connector.provider}`, error);
    }
  }

  return { healthy: false, failedOver: false, message: safeFailure };
}

export async function checkAdConnector(
  connector: HealthConnector,
  now = new Date(),
  env: AdHealthEnvironment = process.env as AdHealthEnvironment,
  fetcher: typeof fetch = fetch,
) {
  if (!AD_PROVIDERS.includes(connector.provider as (typeof AD_PROVIDERS)[number])) {
    throw new Error(`${connector.provider} is not an ad connector.`);
  }
  if (!connector.accessTokenEnc) throw new Error(`${connector.provider} has no encrypted access token.`);

  let accessToken = decryptSecret(connector.accessTokenEnc);
  let failedOver = false;
  let proactiveRefreshFailure: string | null = null;
  if (
    connector.provider === ConnectorProvider.GOOGLE_ADS &&
    connector.refreshTokenEnc &&
    (!connector.tokenExpiresAt || connector.tokenExpiresAt.getTime() <= now.getTime() + REFRESH_EARLY_MS)
  ) {
    try {
      const refreshed = await refreshPrimary(connector, now, env, fetcher);
      if (refreshed) accessToken = refreshed.token;
    } catch (error) {
      proactiveRefreshFailure = `Proactive Google token refresh failed: ${safeMessage(error)}`;
    }
  }

  let probe = await probeAdToken(connector.provider, accessToken, env, fetcher);
  if (probe.healthy && proactiveRefreshFailure) {
    probe = { healthy: false, authFailure: false, message: proactiveRefreshFailure };
  }
  if (!probe.healthy && probe.authFailure && connector.provider === ConnectorProvider.GOOGLE_ADS && connector.refreshTokenEnc) {
    try {
      const refreshed = await refreshPrimary(connector, now, env, fetcher);
      if (refreshed) probe = await probeAdToken(connector.provider, refreshed.token, env, fetcher);
    } catch (error) {
      probe = { healthy: false, authFailure: true, message: safeMessage(error) };
    }
  }

  // Never rotate credentials for a timeout, quota response or provider 5xx.
  // Standby promotion is reserved for an authoritative authentication failure.
  if (!probe.healthy && probe.authFailure && connector.standbyAccessTokenEnc) {
    let standbyToken: string | undefined;
    try {
      standbyToken = decryptSecret(connector.standbyAccessTokenEnc);
      const standby = await probeAdToken(connector.provider, standbyToken, env, fetcher);
      if (standby.healthy) {
        await prisma.connector.update({
          where: { id: connector.id },
          data: {
            accessTokenEnc: connector.standbyAccessTokenEnc,
            refreshTokenEnc: connector.standbyRefreshTokenEnc,
            tokenExpiresAt: standby.expiresAt ?? connector.standbyTokenExpiresAt,
            standbyAccessTokenEnc: null,
            standbyRefreshTokenEnc: null,
            standbyTokenExpiresAt: null,
            failoverCount: { increment: 1 },
          },
        });
        await recordEvent(connector, ConnectorHealthEventKind.FAILOVER_ACTIVATED, ConnectorHealthStatus.HEALTHY, "Primary token disconnected; independently verified standby credential promoted.", connector.consecutiveFailures + 1);
        probe = standby;
        failedOver = true;
      } else {
        probe = {
          ...probe,
          message: `${probe.message} Standby credential was also rejected: ${standby.message}`,
        };
      }
    } catch (error) {
      probe = {
        ...probe,
        message: `${probe.message} Standby credential check failed: ${safeMessage(error, standbyToken)}`,
      };
    }
  }

  if (probe.healthy) {
    await prisma.connector.update({
      where: { id: connector.id },
      data: {
        status: ConnectorStatus.CONNECTED,
        healthStatus: ConnectorHealthStatus.HEALTHY,
        lastHealthCheckedAt: now,
        lastHealthyAt: now,
        nextHealthCheckAt: nextHealthCheckAt(now, 0),
        consecutiveFailures: 0,
        lastError: null,
        ...(probe.expiresAt ? { tokenExpiresAt: probe.expiresAt } : {}),
      },
    });
    await recordEvent(connector, ConnectorHealthEventKind.CHECK_PASSED, ConnectorHealthStatus.HEALTHY, probe.message, 1);
    return { healthy: true, failedOver, message: probe.message };
  }

  return persistConnectorFailure(
    connector,
    now,
    env,
    fetcher,
    probe.message,
    probe.authFailure,
  );
}

export async function runAdConnectorHealthSweep(now = new Date()) {
  const connectors = await prisma.connector.findMany({
    where: {
      provider: { in: [...AD_PROVIDERS] },
      status: {
        in: [
          ConnectorStatus.CONNECTED,
          ConnectorStatus.DISCONNECTED,
          ConnectorStatus.ERROR,
        ],
      },
      accessTokenEnc: { not: null },
      OR: [{ nextHealthCheckAt: null }, { nextHealthCheckAt: { lte: now } }],
    },
    include: { shop: { select: { domain: true } } },
  });
  const results = await Promise.allSettled(connectors.map((connector) =>
    withConnectorWork(connector.id, "ad-health", now, async () => {
      try {
        return await checkAdConnector(connector, now);
      } catch (error) {
        return persistConnectorFailure(
          connector,
          now,
          process.env as AdHealthEnvironment,
          fetch,
          `Connector health check crashed: ${safeMessage(error)}`,
        );
      }
    }),
  ));
  for (const result of results) {
    if (result.status === "rejected") console.error("[connector-health] failed to persist connector health", result.reason);
  }
  return connectors.length;
}

export async function storeConnectorCredentials(input: {
  shopId: string;
  provider: (typeof AD_PROVIDERS)[number] | typeof ConnectorProvider.SHIPSTATION;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  standby?: boolean;
}) {
  const access = encryptSecret(input.accessToken);
  const refresh = input.refreshToken ? encryptSecret(input.refreshToken) : null;
  const standbyData = {
    standbyAccessTokenEnc: access,
    standbyRefreshTokenEnc: refresh,
    standbyTokenExpiresAt: input.expiresAt ?? null,
  };
  const primaryData = {
    accessTokenEnc: access,
    refreshTokenEnc: refresh,
    tokenExpiresAt: input.expiresAt ?? null,
    status: ConnectorStatus.CONNECTED,
    healthStatus: ConnectorHealthStatus.UNKNOWN,
    nextHealthCheckAt: new Date(),
    consecutiveFailures: 0,
    lastError: null,
  };
  return prisma.connector.upsert({
    where: { shopId_provider: { shopId: input.shopId, provider: input.provider } },
    create: {
      shopId: input.shopId,
      provider: input.provider,
      ...(input.standby ? standbyData : primaryData),
    },
    update: input.standby ? standbyData : primaryData,
  });
}
