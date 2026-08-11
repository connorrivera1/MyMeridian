import { ConnectorProvider } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  nextHealthCheckAt,
  probeAdToken,
  refreshGoogleAccessToken,
  sendConnectorAlert,
} from "./ad-health.server";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("ad token health adapters", () => {
  it("uses Meta's debug-token result rather than token age guesses", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ data: { is_valid: true, expires_at: 1_800_000_000 } }))
      .mockResolvedValueOnce(response({ data: [{ id: "act_1" }] }));
    await expect(probeAdToken(
      ConnectorProvider.FACEBOOK_ADS,
      "merchant-token",
      { META_APP_ID: "app", META_APP_SECRET: "secret" },
      fetcher,
    )).resolves.toMatchObject({ healthy: true, authFailure: false });
    const called = new URL(String(fetcher.mock.calls[0]![0]));
    expect(called.pathname).toBe("/debug_token");
    expect(called.searchParams.get("input_token")).toBe("merchant-token");
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer merchant-token" }),
    });
  });

  it("treats a valid Meta token with no accessible ad account as disconnected", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ data: { is_valid: true } }))
      .mockResolvedValueOnce(response({ data: [] }));
    await expect(probeAdToken(
      ConnectorProvider.FACEBOOK_ADS,
      "orphaned-token",
      { META_APP_ID: "app", META_APP_SECRET: "secret" },
      fetcher,
    )).resolves.toMatchObject({ healthy: false, authFailure: true });
  });

  it("probes Google Ads with both OAuth and developer credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ resourceNames: ["customers/1"] }));
    await expect(probeAdToken(
      ConnectorProvider.GOOGLE_ADS,
      "oauth-token",
      { GOOGLE_ADS_DEVELOPER_TOKEN: "developer-token" },
      fetcher,
    )).resolves.toMatchObject({ healthy: true });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ headers: {
      Authorization: "Bearer oauth-token",
      "developer-token": "developer-token",
    } });
  });

  it("treats an empty Google Ads customer list as disconnected", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ resourceNames: [] }));
    await expect(probeAdToken(
      ConnectorProvider.GOOGLE_ADS,
      "oauth-token",
      { GOOGLE_ADS_DEVELOPER_TOKEN: "developer-token" },
      fetcher,
    )).resolves.toMatchObject({ healthy: false, authFailure: true });
  });

  it("treats TikTok's HTTP-200 nonzero code as an API failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ code: 40001, message: "Access token invalid" }));
    await expect(probeAdToken(
      ConnectorProvider.TIKTOK_ADS,
      "bad-token",
      {},
      fetcher,
    )).resolves.toMatchObject({ healthy: false, authFailure: true });
  });

  it("treats an empty TikTok advertiser list as disconnected", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      code: 0,
      message: "OK",
      data: { list: [] },
    }));
    await expect(probeAdToken(
      ConnectorProvider.TIKTOK_ADS,
      "orphaned-token",
      {},
      fetcher,
    )).resolves.toMatchObject({ healthy: false, authFailure: true });
  });

  it("refreshes Google access without putting secrets in the URL", async () => {
    vi.setSystemTime(new Date("2026-08-11T12:00:00Z"));
    const fetcher = vi.fn().mockResolvedValue(response({ access_token: "new-token", expires_in: 3600 }));
    const result = await refreshGoogleAccessToken("refresh-token", {
      GOOGLE_ADS_CLIENT_ID: "client",
      GOOGLE_ADS_CLIENT_SECRET: "secret",
    }, fetcher);
    expect(result.token).toBe("new-token");
    expect(String(fetcher.mock.calls[0]![0])).not.toContain("refresh-token");
    expect(String(fetcher.mock.calls[0]![1]!.body)).toContain("refresh_token=refresh-token");
    vi.useRealTimers();
  });

  it("backs off repeated failures and caps the delay", () => {
    const now = new Date("2026-08-11T12:00:00Z");
    expect(nextHealthCheckAt(now, 0).getTime() - now.getTime()).toBe(5 * 60_000);
    expect(nextHealthCheckAt(now, 3).getTime() - now.getTime()).toBe(20 * 60_000);
    expect(nextHealthCheckAt(now, 99).getTime() - now.getTime()).toBe(6 * 60 * 60_000);
  });

  it("signs alert payloads and refuses plaintext remote webhooks", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(sendConnectorAlert({ provider: "GOOGLE_ADS" }, {
      CONNECTOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/hooks",
      CONNECTOR_ALERT_WEBHOOK_SECRET: "signing-secret",
    }, fetcher)).resolves.toEqual({ sent: true, reason: null });
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>)["X-Meridian-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);

    await expect(sendConnectorAlert({}, {
      CONNECTOR_ALERT_WEBHOOK_URL: "http://alerts.example.test/hooks",
    }, fetcher)).rejects.toThrow(/must use HTTPS/);

    await expect(sendConnectorAlert({}, {
      CONNECTOR_ALERT_WEBHOOK_URL: "https://alerts.example.test/hooks",
    }, fetcher)).rejects.toThrow(/SECRET is required/);
  });
});
