import { describe, expect, it, vi } from "vitest";

import {
  requestShopifyBillingConfirmation,
} from "./shopify-billing.client";

function request(fetchImpl: typeof fetch) {
  return requestShopifyBillingConfirmation({
    url: "https://staging.mymeridian.io/app/plan",
    body: new FormData(),
    idToken: vi.fn().mockResolvedValue("session-token"),
    fetchImpl,
  });
}

describe("Shopify billing browser handoff", () => {
  it("sends a fresh App Bridge bearer token and accepts only Shopify confirmation URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 401,
        headers: {
          "x-shopify-api-request-failure-reauthorize-url":
            "https://admin.shopify.com/store/test/charges/123",
        },
      }),
    );

    await expect(request(fetchMock)).resolves.toEqual({
      kind: "redirect",
      url: "https://admin.shopify.com/store/test/charges/123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://staging.mymeridian.io/app/plan",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer session-token" },
        credentials: "same-origin",
        redirect: "manual",
      }),
    );
  });

  it("rejects a non-Shopify redirect target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 401,
        headers: {
          "x-shopify-api-request-failure-reauthorize-url":
            "https://attacker.example/charge",
        },
      }),
    );

    await expect(request(fetchMock)).resolves.toEqual({
      kind: "error",
      message:
        "Could not open Shopify's billing confirmation. No charge was created; try again shortly.",
    });
  });

  it("keeps merchant-facing errors generic when the Shopify session cannot be minted or the request fails", async () => {
    await expect(
      requestShopifyBillingConfirmation({
        url: "https://staging.mymeridian.io/app/plan",
        body: new FormData(),
        idToken: vi.fn().mockRejectedValue(new Error("expired")),
      }),
    ).resolves.toEqual({
      kind: "error",
      message:
        "Could not confirm your Shopify session. Refresh the app and try again.",
    });

    await expect(
      request(
        vi.fn().mockRejectedValue(new Error("network details must not surface")),
      ),
    ).resolves.toEqual({
      kind: "error",
      message:
        "Could not reach MyMeridian. No charge was created; try again shortly.",
    });
  });

  it("uses a safe server error only when a valid JSON error is returned", async () => {
    await expect(
      request(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: "Choose a valid plan." }), {
            status: 422,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ).resolves.toEqual({ kind: "error", message: "Choose a valid plan." });

    await expect(
      request(
        vi.fn().mockResolvedValue(
          new Response("not-json", {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ).resolves.toEqual({
      kind: "error",
      message:
        "Could not open Shopify's billing confirmation. No charge was created; try again shortly.",
    });
  });
});
