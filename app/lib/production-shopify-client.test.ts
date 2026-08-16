import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  STAGING_SHOPIFY_CLIENT_ID,
  validateProductionShopifyClient,
} from "./production-shopify-client.server";

describe("production Shopify client isolation", () => {
  it("keeps the hard-stop value synchronized with the staging config", () => {
    const config = readFileSync(
      join(import.meta.dirname, "..", "..", "shopify.app.staging.toml"),
      "utf8",
    );
    expect(config).toContain(`client_id = "${STAGING_SHOPIFY_CLIENT_ID}"`);
  });

  it("keeps the production configuration on its separately issued public app", () => {
    const config = readFileSync(
      join(import.meta.dirname, "..", "..", "shopify.app.production.toml"),
      "utf8",
    );
    expect(config).not.toContain(`client_id = "${STAGING_SHOPIFY_CLIENT_ID}"`);
    expect(config).toContain('handle = "mymeridian-1"');
  });

  it("rejects a production origin using the staging Shopify app", () => {
    expect(() =>
      validateProductionShopifyClient({
        SHOPIFY_APP_URL: "https://mymeridian.io",
        SHOPIFY_API_KEY: STAGING_SHOPIFY_CLIENT_ID,
      }),
    ).toThrow(/separately issued production public-app credentials/i);
  });

  it("does not block staging or a distinct production public app", () => {
    expect(() =>
      validateProductionShopifyClient({
        SHOPIFY_APP_URL: "https://staging.mymeridian.io",
        SHOPIFY_API_KEY: STAGING_SHOPIFY_CLIENT_ID,
      }),
    ).not.toThrow();
    expect(() =>
      validateProductionShopifyClient({
        SHOPIFY_APP_URL: "https://mymeridian.io",
        SHOPIFY_API_KEY: "a-different-production-client-id",
      }),
    ).not.toThrow();
  });
});
