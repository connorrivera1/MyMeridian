import { describe, expect, it, vi } from "vitest";
import { ConnectorProvider } from "@prisma/client";

import {
  classifyGoogleAdsError,
  googleAdsAdapter,
  parseGoogleAdsRow,
  refreshGoogleAccessToken,
} from "./google.server";
import {
  classifyMetaError,
  metaAdapter,
  parseMetaInsightRow,
} from "./meta.server";
import {
  classifyTikTokEnvelope,
  parseTikTokReportRow,
  tiktokAdapter,
} from "./tiktok.server";
import {
  AdProviderAuthError,
  AdProviderRateLimitError,
  AdProviderTransientError,
} from "./types.server";

const AUTH = { accessToken: "token-1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Meta adapter", () => {
  it("parses an insights row, preferring the omni purchase action", () => {
    const parsed = parseMetaInsightRow({
      campaign_id: "1201",
      campaign_name: "Prospecting AU",
      spend: "142.37",
      impressions: "10500",
      clicks: "312",
      actions: [
        { action_type: "purchase", value: "9" },
        { action_type: "omni_purchase", value: "11" },
      ],
      action_values: [{ action_type: "omni_purchase", value: "1043.90" }],
    });
    expect(parsed).toEqual({
      campaignId: "1201",
      campaignName: "Prospecting AU",
      spend: "142.37",
      impressions: 10500,
      clicks: 312,
      conversions: 11,
      revenue: "1043.90",
    });
  });

  it("classifies Meta's throttling codes as rate limits", () => {
    const error = classifyMetaError(400, {
      error: { message: "User request limit reached", code: 17 },
    });
    expect(error).toBeInstanceOf(AdProviderRateLimitError);
  });

  it("classifies an invalid token as an auth failure", () => {
    const error = classifyMetaError(400, {
      error: { message: "Error validating access token", code: 190 },
    });
    expect(error).toBeInstanceOf(AdProviderAuthError);
  });

  it("classifies a 500 as transient", () => {
    expect(classifyMetaError(500, {})).toBeInstanceOf(
      AdProviderTransientError,
    );
  });

  it("follows Meta's next-page cursor to the end", async () => {
    const page2 =
      "https://graph.facebook.com/v21.0/act_1/insights?after=cursor2";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ campaign_id: "a", spend: "1.00" }],
          paging: { next: page2 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ campaign_id: "b", spend: "2.00" }] }),
      );

    const rows = await metaAdapter.fetchDailySpend(
      AUTH,
      "1",
      "2026-08-10",
      fetcher,
    );

    expect(rows.map((row) => row.campaignId)).toEqual(["a", "b"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toBe(page2);
  });
});

describe("Google Ads adapter", () => {
  it("parses cost micros into decimal account currency", () => {
    const parsed = parseGoogleAdsRow({
      campaign: { id: 987, name: "Brand — Exact" },
      metrics: {
        costMicros: "142370000",
        impressions: "8100",
        clicks: "402",
        conversions: "12.4",
        conversionsValue: "1150.55",
      },
    });
    expect(parsed).toEqual({
      campaignId: "987",
      campaignName: "Brand — Exact",
      spend: "142.37",
      impressions: 8100,
      clicks: 402,
      conversions: 12,
      revenue: "1150.55",
    });
  });

  it("classifies RESOURCE_EXHAUSTED as a rate limit and UNAUTHENTICATED as auth", () => {
    expect(
      classifyGoogleAdsError(429, { error: { status: "RESOURCE_EXHAUSTED" } }),
    ).toBeInstanceOf(AdProviderRateLimitError);
    expect(
      classifyGoogleAdsError(401, { error: { status: "UNAUTHENTICATED" } }),
    ).toBeInstanceOf(AdProviderAuthError);
    expect(classifyGoogleAdsError(503, {})).toBeInstanceOf(
      AdProviderTransientError,
    );
  });

  it("flattens searchStream chunks into one row set", async () => {
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", "dev-token");
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse([
          { results: [{ campaign: { id: 1 }, metrics: { costMicros: "1000000" } }] },
          { results: [{ campaign: { id: 2 }, metrics: { costMicros: "2000000" } }] },
        ]),
      );

      const rows = await googleAdsAdapter.fetchDailySpend(
        AUTH,
        "123-456-7890",
        "2026-08-10",
        fetcher,
      );

      expect(rows.map((row) => row.campaignId)).toEqual(["1", "2"]);
      const [url, init] = fetcher.mock.calls[0]!;
      // Dashes stripped from the customer id, GAQL pinned to the day.
      expect(String(url)).toContain("/customers/1234567890/googleAds:searchStream");
      expect(String(init?.body)).toContain("segments.date = '2026-08-10'");
      expect((init?.headers as Record<string, string>)["login-customer-id"]).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the saved MCC only for a client selected through that MCC", async () => {
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", "dev-token");
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
      await googleAdsAdapter.fetchDailySpend(
        { accessToken: "token-1", loginCustomerId: "9000000000" },
        "123-456-7890",
        "2026-08-10",
        fetcher,
      );
      const [, init] = fetcher.mock.calls[0]!;
      expect((init?.headers as Record<string, string>)["login-customer-id"]).toBe("9000000000");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses to run without a developer token, as an auth fact", async () => {
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN", "");
    try {
      await expect(
        googleAdsAdapter.fetchDailySpend(AUTH, "1", "2026-08-10", vi.fn()),
      ).rejects.toBeInstanceOf(AdProviderAuthError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exchanges a refresh token and reports revocation as auth", async () => {
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_ID", "client");
    vi.stubEnv("MERIDIAN_GOOGLE_ADS_CLIENT_SECRET", "secret");
    try {
      const ok = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ access_token: "fresh", expires_in: 3599 }),
        );
      await expect(refreshGoogleAccessToken("refresh-1", ok)).resolves.toEqual({
        accessToken: "fresh",
        expiresInSeconds: 3599,
      });

      const revoked = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
      await expect(
        refreshGoogleAccessToken("refresh-1", revoked),
      ).rejects.toBeInstanceOf(AdProviderAuthError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("TikTok adapter", () => {
  it("parses a report row across TikTok's metric name variants", () => {
    const parsed = parseTikTokReportRow({
      dimensions: { campaign_id: "7031" },
      metrics: {
        campaign_name: "Spark — UGC",
        spend: "88.20",
        impressions: "44000",
        clicks: "950",
        complete_payment: "14",
        total_onsite_shopping_value: "612.40",
      },
    });
    expect(parsed).toEqual({
      campaignId: "7031",
      campaignName: "Spark — UGC",
      spend: "88.20",
      impressions: 44000,
      clicks: 950,
      conversions: 14,
      revenue: "612.40",
    });
  });

  it("reads failure from the body code even on HTTP 200", () => {
    expect(
      classifyTikTokEnvelope(200, { code: 40105, message: "token expired" }),
    ).toBeInstanceOf(AdProviderAuthError);
    expect(
      classifyTikTokEnvelope(200, { code: 50002, message: "busy" }),
    ).toBeInstanceOf(AdProviderRateLimitError);
    expect(
      classifyTikTokEnvelope(200, { code: 40000, message: "param" }),
    ).toBeInstanceOf(AdProviderTransientError);
    expect(classifyTikTokEnvelope(200, { code: 0 })).toBeNull();
  });

  it("walks page_info to the last page", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            list: [{ dimensions: { campaign_id: "a" }, metrics: { spend: "1" } }],
            page_info: { page: 1, total_page: 2 },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            list: [{ dimensions: { campaign_id: "b" }, metrics: { spend: "2" } }],
            page_info: { page: 2, total_page: 2 },
          },
        }),
      );

    const rows = await tiktokAdapter.fetchDailySpend(
      AUTH,
      "adv-1",
      "2026-08-10",
      fetcher,
    );
    expect(rows.map((row) => row.campaignId)).toEqual(["a", "b"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reads the advertiser's billing currency from the profile", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        code: 0,
        data: { list: [{ currency: "aud", name: "Store AU" }] },
      }),
    );
    await expect(
      tiktokAdapter.fetchAccountProfile(AUTH, "adv-1", fetcher),
    ).resolves.toEqual({ currency: "AUD", displayName: "Store AU" });
  });
});

describe("error taxonomy provenance", () => {
  it("stamps the provider into every error message", () => {
    expect(
      new AdProviderAuthError(ConnectorProvider.TIKTOK_ADS, "x").message,
    ).toContain("TIKTOK_ADS");
    expect(
      new AdProviderRateLimitError(ConnectorProvider.GOOGLE_ADS, 5_000).message,
    ).toContain("GOOGLE_ADS");
  });
});
