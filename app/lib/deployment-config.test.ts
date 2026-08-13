import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const read = (relative: string) =>
  readFileSync(join(REPO_ROOT, relative), "utf8");

describe("production deployment configuration", () => {
  it("pins Shopify, OAuth and relative webhooks to the canonical origin", () => {
    const config = read("shopify.app.production.toml");

    expect(config).toContain('application_url = "https://mymeridian.io"');
    expect(config).toContain(
      'redirect_urls = [ "https://mymeridian.io/auth/callback" ]',
    );
    expect(config).toContain("automatically_update_urls_on_dev = false");
    expect(config).toContain('uri = "/webhooks/gdpr/customers-data-request"');
    expect(config).not.toMatch(/localhost|127\.0\.0\.1|shopify\.dev|trycloudflare/i);
  });

  it("keeps the landing page canonical and every public help document linked", () => {
    const landing = read("site/index.html");

    expect(landing).toContain(
      '<link rel="canonical" href="https://mymeridian.io/" />',
    );
    expect(landing).toContain('href="privacy.html"');
    expect(landing).toContain('href="terms.html"');
    expect(landing).toContain('href="/support"');
    expect(landing).not.toMatch(/localhost|shopify\.dev|trycloudflare/i);
  });

  it("keeps production and staging on isolated HTTPS Fly apps", () => {
    const production = read("fly.toml");
    const staging = read("fly.staging.toml");

    expect(production).toContain('app = "mymeridian-prod"');
    expect(staging).toContain('app = "mymeridian-staging"');
    expect(production).toContain(
      'SHOPIFY_APP_URL = "https://mymeridian.io"',
    );
    expect(staging).toContain(
      'SHOPIFY_APP_URL = "https://staging.mymeridian.io"',
    );
    for (const config of [production, staging]) {
      expect(config).toContain("force_https = true");
      expect(config).toContain('MERIDIAN_DEMO_MODE = "false"');
      expect(config).toContain('release_command = "/bin/sh -lc \'DATABASE_URL=$DIRECT_DATABASE_URL npx prisma migrate deploy\'"');
      expect(config).toContain("cpus = 2");
      expect(config).toContain("memory_mb = 2048");
    }
  });
});
