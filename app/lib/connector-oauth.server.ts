import { createHash, randomBytes } from "node:crypto";

import {
  ConnectorHealthStatus,
  ConnectorProvider,
  ConnectorStatus,
  Prisma,
} from "@prisma/client";

import prisma from "~/db.server";
import { storeConnectorCredentials } from "~/integrations/ad-health.server";
import { decryptSecret } from "~/lib/crypto.server";

const STATE_TTL_MS = 10 * 60 * 1_000;
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/adwords";

export const CONNECTOR_PROVIDER_SLUGS = ["meta", "google", "tiktok"] as const;
export type ConnectorProviderSlug = (typeof CONNECTOR_PROVIDER_SLUGS)[number];

type AdConnectorProvider =
  | typeof ConnectorProvider.FACEBOOK_ADS
  | typeof ConnectorProvider.GOOGLE_ADS
  | typeof ConnectorProvider.TIKTOK_ADS;

const PROVIDER_BY_SLUG: Record<ConnectorProviderSlug, AdConnectorProvider> = {
  meta: ConnectorProvider.FACEBOOK_ADS,
  google: ConnectorProvider.GOOGLE_ADS,
  tiktok: ConnectorProvider.TIKTOK_ADS,
};

export function connectorProviderForSlug(value: string): AdConnectorProvider | null {
  return CONNECTOR_PROVIDER_SLUGS.includes(value as ConnectorProviderSlug)
    ? PROVIDER_BY_SLUG[value as ConnectorProviderSlug]
    : null;
}

function hashState(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(name: string, aliases: string[] = []): string {
  for (const key of [name, ...aliases]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  throw new Error(`${name} is not configured.`);
}

export function connectorOAuthConfigured(slug: ConnectorProviderSlug): boolean {
  try {
    if (slug === "meta") {
      required("META_APP_ID");
      required("META_APP_SECRET");
    } else if (slug === "google") {
      required("MERIDIAN_GOOGLE_ADS_CLIENT_ID", ["GOOGLE_ADS_CLIENT_ID"]);
      required("MERIDIAN_GOOGLE_ADS_CLIENT_SECRET", ["GOOGLE_ADS_CLIENT_SECRET"]);
      required("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", ["GOOGLE_ADS_DEVELOPER_TOKEN"]);
    } else {
      required("TIKTOK_APP_ID");
      required("TIKTOK_APP_SECRET");
    }
    return true;
  } catch {
    return false;
  }
}

export function connectorCallbackUrl(origin: string, slug: ConnectorProviderSlug): string {
  return new URL(`/connections/${slug}/callback`, origin).toString();
}

export function authorizationUrlFor(input: {
  slug: ConnectorProviderSlug;
  origin: string;
  state: string;
}): string {
  const redirectUri = connectorCallbackUrl(input.origin, input.slug);
  if (input.slug === "meta") {
    const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    url.search = new URLSearchParams({
      client_id: required("META_APP_ID"),
      redirect_uri: redirectUri,
      state: input.state,
      scope: "ads_read",
      response_type: "code",
    }).toString();
    return url.toString();
  }
  if (input.slug === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: required("MERIDIAN_GOOGLE_ADS_CLIENT_ID", ["GOOGLE_ADS_CLIENT_ID"]),
      redirect_uri: redirectUri,
      state: input.state,
      response_type: "code",
      scope: GOOGLE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    }).toString();
    return url.toString();
  }
  const url = new URL("https://ads.tiktok.com/marketing_api/auth");
  url.search = new URLSearchParams({
    app_id: required("TIKTOK_APP_ID"),
    redirect_uri: redirectUri,
    state: input.state,
  }).toString();
  return url.toString();
}

export async function beginConnectorOAuth(input: {
  shopId: string;
  slug: ConnectorProviderSlug;
  origin: string;
}): Promise<string> {
  const provider = PROVIDER_BY_SLUG[input.slug];
  // Resolve configuration before persisting a state that can never complete.
  const state = randomBytes(32).toString("base64url");
  const authorizationUrl = authorizationUrlFor({ ...input, state });
  const now = new Date();
  await prisma.$transaction([
    prisma.connectorOAuthState.deleteMany({
      where: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] },
    }),
    prisma.connectorOAuthState.create({
      data: {
        shopId: input.shopId,
        provider,
        tokenHash: hashState(state),
        expiresAt: new Date(now.getTime() + STATE_TTL_MS),
      },
    }),
  ]);
  return authorizationUrl;
}

async function consumeState(state: string, provider: ConnectorProvider) {
  if (!state || state.length > 512) throw new Error("OAuth state is missing or invalid.");
  const now = new Date();
  const record = await prisma.connectorOAuthState.findUnique({
    where: { tokenHash: hashState(state) },
  });
  if (!record || record.provider !== provider || record.usedAt || record.expiresAt <= now) {
    throw new Error("OAuth state expired or was already used.");
  }
  const consumed = await prisma.connectorOAuthState.updateMany({
    where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (consumed.count !== 1) throw new Error("OAuth state was already used.");
  return record;
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json().catch(() => ({}))) as Record<string, any>;
}

function providerFailure(provider: string, response: Response, body: Record<string, any>): Error {
  const detail = String(
    body.error_description ?? body.error?.message ?? body.message ?? body.error ?? "unknown response",
  ).slice(0, 500);
  return new Error(`${provider} authorization failed (${response.status}): ${detail}`);
}

type ExchangedConnector = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  externalAccountId: string;
  displayName?: string | null;
  accountCurrency?: string | null;
  accounts: Array<{ id: string; name: string | null; currency: string | null }>;
};

export async function exchangeConnectorCode(input: {
  slug: ConnectorProviderSlug;
  code: string;
  origin: string;
  fetcher?: typeof fetch;
}): Promise<ExchangedConnector> {
  const fetcher = input.fetcher ?? fetch;
  const redirectUri = connectorCallbackUrl(input.origin, input.slug);
  if (input.slug === "meta") {
    const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    tokenUrl.search = new URLSearchParams({
      client_id: required("META_APP_ID"),
      client_secret: required("META_APP_SECRET"),
      redirect_uri: redirectUri,
      code: input.code,
    }).toString();
    const tokenResponse = await fetcher(tokenUrl, { headers: { Accept: "application/json" } });
    const tokenBody = await json(tokenResponse);
    if (!tokenResponse.ok || !tokenBody.access_token) throw providerFailure("Meta", tokenResponse, tokenBody);
    // Meta's code exchange returns a short-lived user token. Convert it to the
    // documented long-lived token before persistence so a connector does not
    // die hours after onboarding with no refresh path.
    const longLivedUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    longLivedUrl.search = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: required("META_APP_ID"),
      client_secret: required("META_APP_SECRET"),
      fb_exchange_token: String(tokenBody.access_token),
    }).toString();
    const longLivedResponse = await fetcher(longLivedUrl, { headers: { Accept: "application/json" } });
    const longLivedBody = await json(longLivedResponse);
    if (!longLivedResponse.ok || !longLivedBody.access_token) {
      throw providerFailure("Meta long-lived token", longLivedResponse, longLivedBody);
    }
    const accessToken = String(longLivedBody.access_token);
    const accountsResponse = await fetcher(
      "https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,currency&limit=100",
      { headers: { authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    );
    const accountsBody = await json(accountsResponse);
    const accounts = Array.isArray(accountsBody.data) ? accountsBody.data : [];
    const account = accounts[0];
    if (!accountsResponse.ok || !account?.id) throw providerFailure("Meta ad-account discovery", accountsResponse, accountsBody);
    return {
      accessToken,
      expiresAt: longLivedBody.expires_in
        ? new Date(Date.now() + Number(longLivedBody.expires_in) * 1000)
        : null,
      externalAccountId: String(account.id),
      displayName: account.name ? String(account.name) : null,
      accountCurrency: account.currency ? String(account.currency).toUpperCase() : null,
      accounts: accounts
        .filter((value: any) => value?.id)
        .map((value: any) => ({
          id: String(value.id),
          name: value.name ? String(value.name) : null,
          currency: value.currency ? String(value.currency).toUpperCase() : null,
        })),
    };
  }

  if (input.slug === "google") {
    const tokenResponse = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: required("MERIDIAN_GOOGLE_ADS_CLIENT_ID", ["GOOGLE_ADS_CLIENT_ID"]),
        client_secret: required("MERIDIAN_GOOGLE_ADS_CLIENT_SECRET", ["GOOGLE_ADS_CLIENT_SECRET"]),
        redirect_uri: redirectUri,
        code: input.code,
      }),
    });
    const tokenBody = await json(tokenResponse);
    if (!tokenResponse.ok || !tokenBody.access_token || !tokenBody.refresh_token) {
      throw providerFailure("Google", tokenResponse, tokenBody);
    }
    const accessToken = String(tokenBody.access_token);
    const accountsResponse = await fetcher(
      "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "developer-token": required("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", ["GOOGLE_ADS_DEVELOPER_TOKEN"]),
          Accept: "application/json",
        },
      },
    );
    const accountsBody = await json(accountsResponse);
    const resources = Array.isArray(accountsBody.resourceNames) ? accountsBody.resourceNames : [];
    const resource = resources[0];
    if (!accountsResponse.ok || !resource) throw providerFailure("Google Ads account discovery", accountsResponse, accountsBody);
    return {
      accessToken,
      refreshToken: String(tokenBody.refresh_token),
      expiresAt: new Date(Date.now() + Number(tokenBody.expires_in ?? 3600) * 1000),
      externalAccountId: String(resource).replace(/^customers\//, ""),
      displayName: `Google Ads ${String(resource).replace(/^customers\//, "")}`,
      accounts: resources.map((value: unknown) => {
        const id = String(value).replace(/^customers\//, "");
        return { id, name: `Google Ads ${id}`, currency: null };
      }),
    };
  }

  const tokenResponse = await fetcher(
    "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: required("TIKTOK_APP_ID"),
        secret: required("TIKTOK_APP_SECRET"),
        auth_code: input.code,
      }),
    },
  );
  const tokenBody = await json(tokenResponse);
  const accessToken = tokenBody.data?.access_token;
  if (!tokenResponse.ok || Number(tokenBody.code) !== 0 || !accessToken) {
    throw providerFailure("TikTok", tokenResponse, tokenBody);
  }
  const accountsResponse = await fetcher(
    "https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/",
    { headers: { "Access-Token": String(accessToken), Accept: "application/json" } },
  );
  const accountsBody = await json(accountsResponse);
  const accounts = accountsBody.data?.list;
  const accountList = Array.isArray(accounts) ? accounts : [];
  const account = accountList[0];
  const accountId = account?.advertiser_id ?? account?.advertiser_id_str;
  if (!accountsResponse.ok || Number(accountsBody.code) !== 0 || !accountId) {
    throw providerFailure("TikTok ad-account discovery", accountsResponse, accountsBody);
  }
  return {
    accessToken: String(accessToken),
    externalAccountId: String(accountId),
    displayName: account.advertiser_name ? String(account.advertiser_name) : null,
    accounts: accountList
      .map((value: any) => ({
        id: String(value?.advertiser_id ?? value?.advertiser_id_str ?? ""),
        name: value?.advertiser_name ? String(value.advertiser_name) : null,
        currency: value?.currency ? String(value.currency).toUpperCase() : null,
      }))
      .filter((value: { id: string }) => value.id !== ""),
  };
}

export async function finishConnectorOAuth(input: {
  slug: ConnectorProviderSlug;
  state: string;
  code: string;
  origin: string;
}): Promise<{ shopId: string; provider: ConnectorProvider; externalAccountId: string }> {
  const provider = PROVIDER_BY_SLUG[input.slug];
  const state = await consumeState(input.state, provider);
  const token = await exchangeConnectorCode(input);
  const connector = await storeConnectorCredentials({
    shopId: state.shopId,
    provider,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
  });
  await prisma.connector.update({
    where: { id: connector.id },
    data: {
      externalAccountId: token.externalAccountId,
      displayName: token.displayName ?? null,
      accountCurrency: token.accountCurrency ?? null,
      availableAccounts: token.accounts,
      lastError: null,
    },
  });
  return { shopId: state.shopId, provider, externalAccountId: token.externalAccountId };
}

const DISCONNECTABLE_PROVIDERS = new Set<ConnectorProvider>([
  ConnectorProvider.FACEBOOK_ADS,
  ConnectorProvider.GOOGLE_ADS,
  ConnectorProvider.TIKTOK_ADS,
  ConnectorProvider.SHIPSTATION,
]);

/** Revoke provider access where supported, then irreversibly remove local secrets. */
export async function disconnectConnector(input: {
  shopId: string;
  provider: ConnectorProvider;
  fetcher?: typeof fetch;
}): Promise<{ remoteRevoked: boolean }> {
  if (!DISCONNECTABLE_PROVIDERS.has(input.provider)) {
    throw new Error("That data source cannot be disconnected here.");
  }
  const connector = await prisma.connector.findFirst({
    where: { shopId: input.shopId, provider: input.provider },
  });
  if (!connector) throw new Error("Connector not found.");
  const fetcher = input.fetcher ?? fetch;
  let remoteRevoked = true;
  if (connector.accessTokenEnc) {
    const accessToken = decryptSecret(connector.accessTokenEnc);
    try {
      let response: Response | null = null;
      if (input.provider === ConnectorProvider.FACEBOOK_ADS) {
        response = await fetcher("https://graph.facebook.com/v21.0/me/permissions", {
          method: "DELETE",
          headers: { authorization: `Bearer ${accessToken}` },
        });
      } else if (input.provider === ConnectorProvider.GOOGLE_ADS) {
        const token = connector.refreshTokenEnc
          ? decryptSecret(connector.refreshTokenEnc)
          : accessToken;
        response = await fetcher("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
        });
      } else if (input.provider === ConnectorProvider.TIKTOK_ADS) {
        response = await fetcher(
          "https://business-api.tiktok.com/open_api/v1.3/oauth2/revoke_token/",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              app_id: required("TIKTOK_APP_ID"),
              secret: required("TIKTOK_APP_SECRET"),
              access_token: accessToken,
            }),
          },
        );
      } else if (connector.webhookId) {
        response = await fetcher(
          `https://api.shipstation.com/v2/environment/webhooks/${encodeURIComponent(connector.webhookId)}`,
          { method: "DELETE", headers: { "API-Key": accessToken } },
        );
      }
      remoteRevoked = response === null || response.ok || response.status === 404;
    } catch {
      remoteRevoked = false;
    }
  }
  await prisma.connector.update({
    where: { id: connector.id },
    data: {
      status: ConnectorStatus.DISCONNECTED,
      healthStatus: ConnectorHealthStatus.UNKNOWN,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      standbyAccessTokenEnc: null,
      standbyRefreshTokenEnc: null,
      standbyTokenExpiresAt: null,
      externalAccountId: null,
      displayName: null,
      accountCurrency: null,
      availableAccounts: Prisma.DbNull,
      webhookId: null,
      webhookSecretEnc: null,
      webhookRegisteredAt: null,
      nextHealthCheckAt: null,
      lastError: remoteRevoked
        ? null
        : "Local credentials were removed, but the provider did not confirm remote revocation.",
    },
  });
  return { remoteRevoked };
}

export async function purgeExpiredConnectorOAuthStates(now = new Date()): Promise<number> {
  const deleted = await prisma.connectorOAuthState.deleteMany({
    where: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] },
  });
  return deleted.count;
}
