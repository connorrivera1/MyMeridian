import { describe, expect, it } from "vitest";

import { readinessConfiguration } from "./health.ready";

describe("production readiness", () => {
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
    expect(result.missing).toContain("MERIDIAN_CUSTOMER_ERASURE_KEY");
    expect(result.missing).toContain("MERIDIAN_OPERATOR_TOTP_SECRET");
  });

  it("rejects a non-HTTPS production callback origin", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://db",
      SHOPIFY_API_KEY: "key",
      SHOPIFY_API_SECRET: "secret",
      SHOPIFY_APP_URL: "http://app.example.com",
      MERIDIAN_ENCRYPTION_KEY: "enc",
      MERIDIAN_CUSTOMER_ERASURE_KEY: "erase",
      MERIDIAN_OPERATOR_EMAIL: "publisher@example.com",
      MERIDIAN_OPERATOR_PASSWORD_HASH:
        "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      MERIDIAN_OPERATOR_TOTP_SECRET:
        "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      MERIDIAN_OPERATOR_SESSION_KEY: "x".repeat(32),
    });
    expect(result.missing).toEqual(["SHOPIFY_APP_URL_HTTPS"]);
  });

  it("rejects malformed operator security material", () => {
    const result = readinessConfiguration({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://db",
      SHOPIFY_API_KEY: "key",
      SHOPIFY_API_SECRET: "secret",
      SHOPIFY_APP_URL: "https://app.example.com",
      MERIDIAN_ENCRYPTION_KEY: "enc",
      MERIDIAN_CUSTOMER_ERASURE_KEY: "erase",
      MERIDIAN_OPERATOR_EMAIL: "not-an-email",
      MERIDIAN_OPERATOR_PASSWORD_HASH: "plain text",
      MERIDIAN_OPERATOR_TOTP_SECRET: "not-base32",
      MERIDIAN_OPERATOR_SESSION_KEY: "short",
    });
    expect(result.missing).toEqual([
      "MERIDIAN_OPERATOR_EMAIL_VALID",
      "MERIDIAN_OPERATOR_PASSWORD_HASH_VALID",
      "MERIDIAN_OPERATOR_TOTP_SECRET_VALID",
      "MERIDIAN_OPERATOR_SESSION_KEY_VALID",
    ]);
  });
});
