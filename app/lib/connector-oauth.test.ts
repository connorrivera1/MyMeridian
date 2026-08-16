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

  it("uses the approved Facebook Login for Business configuration when set", () => {
    vi.stubEnv("META_APP_ID", "meta-app");
    vi.stubEnv("META_APP_SECRET", "meta-secret");
    vi.stubEnv("META_LOGIN_CONFIG_ID", "meta-config");

    const url = new URL(
      authorizationUrlFor({ slug: "meta", origin: "https://app.example.com", state: "state-1" }),
    );
    expect(url.searchParams.get("scope")).toBe("ads_read");
    expect(url.searchParams.get("config_id")).toBe("meta-config");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/connections/meta/callback");
  });

  it("exchanges Google code and discovers an accessible advertiser account", async () => {
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
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              results: [
                {
                  customerClient: {
                    id: "1234567890",
                    level: 0,
                    manager: false,
                    descriptiveName: "Northwind Ads",
                    currencyCode: "USD",
                    status: "ENABLED",
                  },
                },
              ],
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
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
      displayName: "Northwind Ads",
      accountCurrency: "USD",
      accounts: [
        {
          id: "1234567890",
          loginCustomerId: null,
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("retains the MCC id for a selected Google Ads client", async () => {
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_ID", "google-client");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_SECRET", "google-secret");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ resourceNames: ["customers/9000000000"] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              results: [
                { customerClient: { id: "9000000000", level: 0, manager: true, status: "ENABLED" } },
                { customerClient: { id: "1234567890", level: 1, manager: false, descriptiveName: "Merchant Ads", currencyCode: "USD", status: "ENABLED" } },
              ],
            },
          ]),
          { status: 200 },
        ),
      );
    await expect(
      exchangeConnectorCode({ slug: "google", code: "code", origin: "https://app.example.com", fetcher }),
    ).resolves.toMatchObject({
      externalAccountId: "1234567890",
      accounts: [
        { id: "1234567890", loginCustomerId: "9000000000" },
      ],
    });
  });

  it("walks a nested Google Ads manager hierarchy with the root MCC", async () => {
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_ID", "google-client");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_SECRET", "google-secret");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ resourceNames: ["customers/9000000000"] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ results: [
            { customerClient: { id: "9000000000", level: 0, manager: true } },
            { customerClient: { id: "8000000000", level: 1, manager: true, status: "ENABLED" } },
          ] }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ results: [
            { customerClient: { id: "8000000000", level: 0, manager: true } },
            { customerClient: { id: "1234567890", level: 1, manager: false, descriptiveName: "Nested merchant", status: "ENABLED" } },
          ] }]),
          { status: 200 },
        ),
      );
    await expect(
      exchangeConnectorCode({ slug: "google", code: "code", origin: "https://app.example.com", fetcher }),
    ).resolves.toMatchObject({
      externalAccountId: "1234567890",
      accounts: [{ id: "1234567890", loginCustomerId: "9000000000" }],
    });
    const [, nestedRequest] = fetcher.mock.calls[3]!;
    expect((nestedRequest?.headers as Record<string, string>)["login-customer-id"]).toBe("9000000000");
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
