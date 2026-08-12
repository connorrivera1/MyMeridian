import { smsProviderConfiguration } from "~/lib/mfa.server";
import { operatorConfiguration } from "~/lib/operator-config";
import { rateLimitConfiguration } from "~/lib/rate-limit.server";

const PRODUCTION_REQUIRED = [
  "DATABASE_URL",
  "MERIDIAN_TENANT_DATABASE_URL",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "MERIDIAN_ENCRYPTION_KEY",
  "MERIDIAN_CUSTOMER_ERASURE_KEY",
  "MERIDIAN_OPERATOR_EMAIL",
  "MERIDIAN_OPERATOR_PASSWORD_HASH",
  "MERIDIAN_OPERATOR_TOTP_SECRET",
  "MERIDIAN_OPERATOR_SESSION_KEY",
  "MERIDIAN_RATE_LIMIT_KEY",
  "RESEND_API_KEY",
  "MERIDIAN_EMAIL_FROM",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_VERIFY_SERVICE_SID",
] as const;

export function readinessConfiguration(env: NodeJS.ProcessEnv = process.env): {
  ready: boolean;
  missing: string[];
} {
  if (env.NODE_ENV !== "production") return { ready: true, missing: [] };
  const missing: string[] = PRODUCTION_REQUIRED.filter(
    (name) => !env[name]?.trim(),
  );
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
