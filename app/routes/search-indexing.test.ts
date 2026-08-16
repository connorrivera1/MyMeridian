import { afterEach, expect, it, vi } from "vitest";

import { loader as robots } from "./robots.txt";
import { loader as sitemap } from "./sitemap.xml";

afterEach(() => vi.unstubAllEnvs());

it("blocks staging crawlers and never publishes a staging sitemap", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", "https://staging.mymeridian.io");
  const request = new Request("https://staging.mymeridian.io/robots.txt");

  expect(await (await robots({ request } as never)).text()).toBe(
    "User-agent: *\nDisallow: /\n",
  );
  expect(await (await sitemap({ request } as never)).text()).not.toContain(
    "<loc>",
  );
});

it("publishes only documented public URLs at the production origin", async () => {
  vi.stubEnv("SHOPIFY_APP_URL", "https://mymeridian.io");
  const request = new Request("https://mymeridian.io/robots.txt");
  const robotsResponse = await robots({ request } as never);
  const sitemapResponse = await sitemap({ request } as never);
  const sitemapBody = await sitemapResponse.text();

  expect(await robotsResponse.text()).toContain(
    "Sitemap: https://mymeridian.io/sitemap.xml",
  );
  expect(sitemapBody).toContain("https://mymeridian.io/privacy");
  expect(sitemapBody).not.toContain("/app");
});
