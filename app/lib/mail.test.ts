import { describe, expect, it, vi } from "vitest";

import { mailConfiguration, sendEmail } from "./mail.server";

describe("transactional mail", () => {
  it("requires both the API key and sender", () => {
    expect(mailConfiguration({})).toEqual({ configured: false, from: null });
    expect(
      mailConfiguration({
        RESEND_API_KEY: "key",
        MERIDIAN_EMAIL_FROM: "MyMeridian <hello@example.com>",
      }),
    ).toEqual({ configured: true, from: "MyMeridian <hello@example.com>" });
  });

  it("sends an idempotent Resend request", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      sendEmail(
        {
          to: "merchant@example.com",
          subject: "Your report",
          text: "Plain report",
          html: "<p>Plain report</p>",
          idempotencyKey: "weekly:shop:2026-08-11",
        },
        {
          env: {
            RESEND_API_KEY: "secret",
            MERIDIAN_EMAIL_FROM: "MyMeridian <hello@example.com>",
          },
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).resolves.toEqual({ id: "email_123" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer secret",
      "idempotency-key": "weekly:shop:2026-08-11",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      from: "MyMeridian <hello@example.com>",
      to: ["merchant@example.com"],
      subject: "Your report",
    });
  });

  it("surfaces provider failures with a bounded response", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("x".repeat(1_000), { status: 422 }),
    );
    await expect(
      sendEmail(
        { to: "a@example.com", subject: "S", text: "T" },
        {
          env: {
            RESEND_API_KEY: "secret",
            MERIDIAN_EMAIL_FROM: "hello@example.com",
          },
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).rejects.toThrow(/422.*x{500}$/);
  });
});
