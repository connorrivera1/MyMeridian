import { smsProviderConfiguration } from "~/lib/mfa.server";
import { operatorConfiguration } from "~/lib/operator-config";
import { rateLimitConfiguration } from "~/lib/rate-limit.server";
import requirements from "../../config/production-readiness.json";

// This name-only manifest also powers scripts/production-preflight.mjs. It
// prevents the deploy-time readiness check and the no-deploy Fly inventory
// check from drifting apart. Redis is the durable queue/retry boundary, so it
// is required before launch-promised connector tokens can be accepted.
const PRODUCTION_REQUIRED = requirements.requiredEnvironment;

// Ad connections remain optional for a staging environment, where a provider
// can be deliberately unavailable while its OAuth flow is being exercised.
// Production declares this switch in fly.toml because Meta, Google Ads and
// TikTok are launch commitments. Keeping the list here makes /readyz the
// single source of truth for the exact server-side credentials that gate that
// promise; merchant tokens remain per-connector encrypted database records.
const LAUNCH_CONNECTOR_REQUIRED = requirements.launchConnectorSecrets;
const WEB_OAUTH_REQUIRED = requirements.webOAuthSecrets;

export function readinessConfiguration(env: NodeJS.ProcessEnv = process.env): {
  ready: boolean;
  missing: string[];
} {
  if (env.NODE_ENV !== "production") return { ready: true, missing: [] };
  const missing: string[] = PRODUCTION_REQUIRED.filter(
    (name) => !env[name]?.trim(),
  );
  if (env.MERIDIAN_REQUIRE_LAUNCH_CONNECTORS?.trim() === "true") {
    missing.push(
      ...LAUNCH_CONNECTOR_REQUIRED.filter((name) => !env[name]?.trim()),
    );
    if (env.MERIDIAN_ADS_WORKER_DISABLED?.trim() === "true") {
      missing.push("MERIDIAN_ADS_WORKER_DISABLED_FALSE");
    }
  }
  if (env.MERIDIAN_REQUIRE_WEB_OAUTH?.trim() === "true") {
    missing.push(
      ...WEB_OAUTH_REQUIRED.filter((name) => !env[name]?.trim()),
    );
  }
  const appUrl = env.SHOPIFY_APP_URL?.trim();
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (url.protocol !== "https:") missing.push("SHOPIFY_APP_URL_HTTPS");
      const host = url.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "shopify.dev" ||
        host.endsWith(".shopify.dev") ||
        host.endsWith(".example") ||
        host === "example.com" ||
        host.endsWith(".example.com")
      ) {
        missing.push("SHOPIFY_APP_URL_PRODUCTION_ORIGIN");
      }
    } catch {
      missing.push("SHOPIFY_APP_URL_VALID");
    }
  }
  const publicOrigin = env.MERIDIAN_PUBLIC_ORIGIN?.trim();
  if (publicOrigin && appUrl) {
    try {
      const publicUrl = new URL(publicOrigin);
      const shopifyUrl = new URL(appUrl);
      if (
        publicUrl.protocol !== "https:" ||
        publicUrl.origin !== shopifyUrl.origin
      ) {
        missing.push("MERIDIAN_PUBLIC_ORIGIN_MATCHES_SHOPIFY_APP_URL");
      }
    } catch {
      missing.push("MERIDIAN_PUBLIC_ORIGIN_VALID");
    }
  }
  const operator = operatorConfiguration(env);
  for (const name of operator.invalid) missing.push(`${name}_VALID`);
  if (rateLimitConfiguration(env).invalid) {
    missing.push("MERIDIAN_RATE_LIMIT_KEY_VALID");
  }
  const sms = smsProviderConfiguration(env);
  for (const name of sms.invalid) missing.push(`${name}_VALID`);
  const systemDatabaseUrl = env.DATABASE_URL?.trim();
  const tenantDatabaseUrl = env.MERIDIAN_TENANT_DATABASE_URL?.trim();
  if (systemDatabaseUrl && tenantDatabaseUrl) {
    try {
      const systemUser = new URL(systemDatabaseUrl).username;
      const tenantUser = new URL(tenantDatabaseUrl).username;
      if (!systemUser || !tenantUser || systemUser === tenantUser) {
        missing.push("MERIDIAN_TENANT_DATABASE_URL_LEAST_PRIVILEGED");
      }
    } catch {
      missing.push("MERIDIAN_TENANT_DATABASE_URL_VALID");
    }
  }
  return { ready: missing.length === 0, missing };
}
