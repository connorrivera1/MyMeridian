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
    });
    expect(result.missing).toEqual(["SHOPIFY_APP_URL_HTTPS"]);
  });
});
