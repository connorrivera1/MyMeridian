import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizationUrlFor,
  connectorOAuthConfigured,
  connectorProviderForSlug,
  exchangeConnectorCode,
} from "./connector-oauth.server";

afterEach(() => vi.unstubAllEnvs());

describe("connector OAuth", () => {
  it("rejects unknown provider slugs", () => {
    expect(connectorProviderForSlug("meta")).toBe("FACEBOOK_ADS");
    expect(connectorProviderForSlug("other")).toBeNull();
  });

  it("builds Google offline consent with the exact callback", () => {
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_ID", "google-client");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_SECRET", "google-secret");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token");
    expect(connectorOAuthConfigured("google")).toBe(true);
    const url = new URL(
      authorizationUrlFor({ slug: "google", origin: "https://app.example.com", state: "state-1" }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/connections/google/callback");
  });

  it("exchanges Google code and discovers an accessible customer", async () => {
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_ID", "google-client");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_SECRET", "google-secret");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    await expect(
      exchangeConnectorCode({
        slug: "google",
        code: "code",
        origin: "https://app.example.com",
        fetcher,
      }),
    ).resolves.toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      externalAccountId: "1234567890",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("promotes Meta's short token and discovers its first ad account", async () => {
    vi.stubEnv("META_APP_ID", "meta-app");
    vi.stubEnv("META_APP_SECRET", "meta-secret");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "short" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "long", expires_in: 5_184_000 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "act_42", name: "Store Ads", currency: "usd" }] }),
          { status: 200 },
        ),
      );
    await expect(
      exchangeConnectorCode({
        slug: "meta",
        code: "code",
        origin: "https://app.example.com",
        fetcher,
      }),
    ).resolves.toMatchObject({
      accessToken: "long",
      externalAccountId: "act_42",
      displayName: "Store Ads",
      accountCurrency: "USD",
    });
  });
});
