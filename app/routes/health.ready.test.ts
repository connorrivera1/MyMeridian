import { describe, expect, it } from "vitest";

import { readinessConfiguration } from "~/lib/readiness.server";

describe("production readiness", () => {
  const mfaProviders = {
    DIRECT_DATABASE_URL: "postgres://migration@db/app",
    RESEND_API_KEY: "resend-test-key",
    MERIDIAN_EMAIL_FROM: "MyMeridian <security@example.com>",
    MERIDIAN_SUPPORT_EMAIL: "support@example.com",
    MERIDIAN_WAITLIST_UNSUBSCRIBE_KEY: "waitlist-unsubscribe-test-key",
    TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
    TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
    TWILIO_API_KEY_SECRET: "c".repeat(32),
    TWILIO_VERIFY_SERVICE_SID: `VA${"d".repeat(32)}`,
    MERIDIAN_REDIS_URL: "rediss://redis.example.test:6379",
  };
  it("does not impose deployed secrets on local development", () => {
    expect(readinessConfiguration({ NODE_ENV: "development" })).toEqual({
      ready: true,
      missing: [],
    });
  });

  it("requires the production trust and persistence boundary", () => {
    const result = readinessConfiguration({ NODE_ENV: "production" });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain("DATABASE_URL");
    expect(result.missing).toContain("DIRECT_DATABASE_URL");
    expect(result.missing).toContain("MERIDIAN_TENANT_DATABASE_URL");
    expect(result.missing).toContain("MERIDIAN_WAITLIST_UNSUBSCRIBE_KEY");
    expect(result.missing).toContain("MERIDIAN_CUSTOMER_ERASURE_KEY");
    expect(result.missing).toContain("MERIDIAN_OPERATOR_TOTP_SECRET");
  });

  it("requires every launch-promised ad connector only when production opts in", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      MERIDIAN_REQUIRE_LAUNCH_CONNECTORS: "true",
    });

    expect(result.missing).toEqual(
      expect.arrayContaining([
        "META_APP_ID",
        "META_APP_SECRET",
        "MERIDIAN_GOOGLE_ADS_CLIENT_ID",
        "MERIDIAN_GOOGLE_ADS_CLIENT_SECRET",
        "MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN",
        "TIKTOK_APP_ID",
        "TIKTOK_APP_SECRET",
      ]),
    );
  });

  it("requires browser sign-in credentials only when production opts in", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      MERIDIAN_REQUIRE_WEB_OAUTH: "true",
    });

    expect(result.missing).toEqual(
      expect.arrayContaining([
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "MICROSOFT_CLIENT_ID",
        "MICROSOFT_CLIENT_SECRET",
      ]),
    );
  });

  it("refuses a launch configuration that disables connector ingestion", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      MERIDIAN_REQUIRE_LAUNCH_CONNECTORS: "true",
      MERIDIAN_ADS_WORKER_DISABLED: "true",
      ...mfaProviders,
      META_APP_ID: "meta-id",
      META_APP_SECRET: "meta-secret",
      MERIDIAN_GOOGLE_ADS_CLIENT_ID: "google-id",
      MERIDIAN_GOOGLE_ADS_CLIENT_SECRET: "google-secret",
      MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN: "developer-token",
      TIKTOK_APP_ID: "tiktok-id",
      TIKTOK_APP_SECRET: "tiktok-secret",
    });

    expect(result.missing).toContain("MERIDIAN_ADS_WORKER_DISABLED_FALSE");
  });

  it("accepts a complete production launch configuration", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      ...mfaProviders,
      DATABASE_URL: "postgres://meridian-app-system@db.example.test/meridian",
      DIRECT_DATABASE_URL: "postgres://migrator@db.example.test/meridian",
      MERIDIAN_TENANT_DATABASE_URL:
        "postgres://meridian-app-tenant@db.example.test/meridian",
      SHOPIFY_API_KEY: "shopify-key",
      SHOPIFY_API_SECRET: "shopify-secret",
      MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY: "x".repeat(32),
      SHOPIFY_APP_URL: "https://mymeridian.io",
      MERIDIAN_PUBLIC_ORIGIN: "https://mymeridian.io",
      MERIDIAN_ENCRYPTION_KEY: "encryption-key",
      MERIDIAN_CUSTOMER_ERASURE_KEY: "erasure-key",
      MERIDIAN_OPERATOR_EMAIL: "operator@mymeridian.io",
      MERIDIAN_OPERATOR_PASSWORD_HASH:
        "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      MERIDIAN_OPERATOR_TOTP_SECRET: [
        "GEZDGNBV",
        "GY3TQOJQ",
        "GEZDGNBV",
        "GY3TQOJQ",
      ].join(""),
      MERIDIAN_OPERATOR_SESSION_KEY: "x".repeat(32),
      MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 1).toString("base64"),
      MERIDIAN_REQUIRE_LAUNCH_CONNECTORS: "true",
      MERIDIAN_ADS_WORKER_DISABLED: "false",
      META_APP_ID: "meta-id",
      META_APP_SECRET: "meta-secret",
      MERIDIAN_GOOGLE_ADS_CLIENT_ID: "google-ads-client",
      MERIDIAN_GOOGLE_ADS_CLIENT_SECRET: "google-ads-secret",
      MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN: "google-ads-developer-token",
      TIKTOK_APP_ID: "tiktok-id",
      TIKTOK_APP_SECRET: "tiktok-secret",
      MERIDIAN_REQUIRE_WEB_OAUTH: "true",
      GOOGLE_CLIENT_ID: "google-web-client",
      GOOGLE_CLIENT_SECRET: "google-web-secret",
      MICROSOFT_CLIENT_ID: "microsoft-client",
      MICROSOFT_CLIENT_SECRET: "microsoft-secret",
    });

    expect(result).toEqual({ ready: true, missing: [] });
  });

  it("allows staging to verify its core readiness while a launch provider is still external", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      ...mfaProviders,
      DATABASE_URL: "postgres://system@db/app",
      DIRECT_DATABASE_URL: "postgres://migration@db/app",
      MERIDIAN_TENANT_DATABASE_URL: "postgres://tenant@db/app",
      SHOPIFY_API_KEY: "key",
      SHOPIFY_API_SECRET: "secret",
      SHOPIFY_APP_URL: "https://staging.mymeridian.io",
      MERIDIAN_PUBLIC_ORIGIN: "https://staging.mymeridian.io",
      MERIDIAN_ENCRYPTION_KEY: "enc",
      MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY: "x".repeat(32),
      MERIDIAN_CUSTOMER_ERASURE_KEY: "erase",
      MERIDIAN_OPERATOR_EMAIL: "publisher@example.com",
      MERIDIAN_OPERATOR_PASSWORD_HASH:
        "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      MERIDIAN_OPERATOR_TOTP_SECRET: [
        "GEZDGNBV",
        "GY3TQOJQ",
        "GEZDGNBV",
        "GY3TQOJQ",
      ].join(""),
      MERIDIAN_OPERATOR_SESSION_KEY: "x".repeat(32),
      MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 1).toString("base64"),
    });

    expect(result).toEqual({ ready: true, missing: [] });
  });

  it("rejects a non-HTTPS production callback origin", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://system@db/app",
      MERIDIAN_TENANT_DATABASE_URL: "postgres://tenant@db/app",
      SHOPIFY_API_KEY: "key",
      SHOPIFY_API_SECRET: "secret",
      SHOPIFY_APP_URL: "http://app.example.com",
      MERIDIAN_PUBLIC_ORIGIN: "http://app.example.com",
    MERIDIAN_ENCRYPTION_KEY: "enc",
    MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY: "x".repeat(32),
      MERIDIAN_CUSTOMER_ERASURE_KEY: "erase",
      MERIDIAN_OPERATOR_EMAIL: "publisher@example.com",
      MERIDIAN_OPERATOR_PASSWORD_HASH:
        "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      MERIDIAN_OPERATOR_TOTP_SECRET: [
        "GEZDGNBV",
        "GY3TQOJQ",
        "GEZDGNBV",
        "GY3TQOJQ",
      ].join(""),
      MERIDIAN_OPERATOR_SESSION_KEY: "x".repeat(32),
      MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 1).toString("base64"),
      ...mfaProviders,
    });
    expect(result.missing).toEqual([
      "SHOPIFY_APP_URL_HTTPS",
      "SHOPIFY_APP_URL_PRODUCTION_ORIGIN",
      "MERIDIAN_PUBLIC_ORIGIN_MATCHES_SHOPIFY_APP_URL",
    ]);
  });

  it("rejects local and Shopify placeholder production origins", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://system@db/app",
      MERIDIAN_TENANT_DATABASE_URL: "postgres://tenant@db/app",
      SHOPIFY_API_KEY: "key",
      SHOPIFY_API_SECRET: "secret",
      MERIDIAN_ENCRYPTION_KEY: "enc",
      MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY: "x".repeat(32),
      MERIDIAN_CUSTOMER_ERASURE_KEY: "erase",
      MERIDIAN_OPERATOR_EMAIL: "publisher@example.com",
      MERIDIAN_OPERATOR_PASSWORD_HASH:
        "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      MERIDIAN_OPERATOR_TOTP_SECRET: [
        "GEZDGNBV",
        "GY3TQOJQ",
        "GEZDGNBV",
        "GY3TQOJQ",
      ].join(""),
      MERIDIAN_OPERATOR_SESSION_KEY: "x".repeat(32),
      MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 1).toString("base64"),
      ...mfaProviders,
    };
    for (const appUrl of [
      "https://shopify.dev/apps/default-app-home",
      "https://localhost:3130",
      "https://app.example.com",
    ]) {
      expect(
        readinessConfiguration({
          ...base,
          SHOPIFY_APP_URL: appUrl,
          MERIDIAN_PUBLIC_ORIGIN: appUrl,
        }).missing,
      ).toContain("SHOPIFY_APP_URL_PRODUCTION_ORIGIN");
    }
  });

  it("rejects malformed operator security material", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://system@db/app",
      MERIDIAN_TENANT_DATABASE_URL: "postgres://tenant@db/app",
      SHOPIFY_API_KEY: "key",
      SHOPIFY_API_SECRET: "secret",
      SHOPIFY_APP_URL: "https://app.example.com",
      MERIDIAN_PUBLIC_ORIGIN: "https://app.example.com",
      MERIDIAN_ENCRYPTION_KEY: "enc",
      MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY: "x".repeat(32),
      MERIDIAN_CUSTOMER_ERASURE_KEY: "erase",
      MERIDIAN_OPERATOR_EMAIL: "not-an-email",
      MERIDIAN_OPERATOR_PASSWORD_HASH: "plain text",
      MERIDIAN_OPERATOR_TOTP_SECRET: "not-base32",
      MERIDIAN_OPERATOR_SESSION_KEY: "short",
      MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 1).toString("base64"),
      ...mfaProviders,
    });
    expect(result.missing).toEqual([
      "SHOPIFY_APP_URL_PRODUCTION_ORIGIN",
      "MERIDIAN_OPERATOR_EMAIL_VALID",
      "MERIDIAN_OPERATOR_PASSWORD_HASH_VALID",
      "MERIDIAN_OPERATOR_TOTP_SECRET_VALID",
      "MERIDIAN_OPERATOR_SESSION_KEY_VALID",
    ]);
  });

  it("rejects using the privileged database login for merchant requests", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://same-user@db/app",
      MERIDIAN_TENANT_DATABASE_URL: "postgres://same-user@db/app",
    });
    expect(result.missing).toContain(
      "MERIDIAN_TENANT_DATABASE_URL_LEAST_PRIVILEGED",
    );
  });

  it("requires public email links to use the canonical Shopify origin", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://system@db/app",
      MERIDIAN_TENANT_DATABASE_URL: "postgres://tenant@db/app",
      SHOPIFY_API_KEY: "key",
      SHOPIFY_API_SECRET: "secret",
      SHOPIFY_APP_URL: "https://mymeridian.io",
      MERIDIAN_PUBLIC_ORIGIN: "https://staging.mymeridian.io",
      MERIDIAN_ENCRYPTION_KEY: "enc",
      MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY: "x".repeat(32),
      MERIDIAN_CUSTOMER_ERASURE_KEY: "erase",
      MERIDIAN_OPERATOR_EMAIL: "publisher@example.com",
      MERIDIAN_OPERATOR_PASSWORD_HASH:
        "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      MERIDIAN_OPERATOR_TOTP_SECRET: [
        "GEZDGNBV",
        "GY3TQOJQ",
        "GEZDGNBV",
        "GY3TQOJQ",
      ].join(""),
      MERIDIAN_OPERATOR_SESSION_KEY: "x".repeat(32),
      MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 1).toString("base64"),
      ...mfaProviders,
    });
    expect(result.missing).toEqual([
      "MERIDIAN_PUBLIC_ORIGIN_MATCHES_SHOPIFY_APP_URL",
    ]);
  });
});
