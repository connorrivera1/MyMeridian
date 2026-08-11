import { afterEach, describe, expect, it, vi } from "vitest";

import { publicAppOrigin } from "./public-origin.server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publicAppOrigin", () => {
  it("prefers Shopify CLI's public tunnel over a stale local app URL", () => {
    vi.stubEnv("APP_URL", "https://meridian-tunnel.example");
    vi.stubEnv("SHOPIFY_APP_URL", "http://localhost:3130");

    expect(publicAppOrigin(new Request("http://app.internal/billing"))).toBe(
      "https://meridian-tunnel.example",
    );
  });

  it("uses the stable deployment origin outside Shopify CLI", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.mymeridian.co/path");

    expect(publicAppOrigin(new Request("http://app.internal/oauth"))).toBe(
      "https://app.mymeridian.co",
    );
  });

  it("falls back to the request origin when no deployment URL is configured", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("SHOPIFY_APP_URL", "");

    expect(publicAppOrigin(new Request("https://meridian.example/path"))).toBe(
      "https://meridian.example",
    );
  });
});
