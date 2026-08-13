import { beforeEach, describe, expect, it, vi } from "vitest";

const signupCreate = vi.fn();
const entitlementCreate = vi.fn();
const deliveryCreate = vi.fn();
const transaction = vi.fn(async (work: (tx: unknown) => unknown) =>
  work({
    waitlistSignup: { create: signupCreate },
    foundingMerchantEntitlement: { create: entitlementCreate },
    waitlistEmailDelivery: { create: deliveryCreate },
  }),
);
const deliveryFindFirst = vi.fn();
const deliveryUpdateMany = vi.fn();
const signupUpdateMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    $transaction: (work: unknown) => transaction(work as never),
    waitlistEmailDelivery: {
      findFirst: (...args: unknown[]) => deliveryFindFirst(...args),
      updateMany: (...args: unknown[]) => deliveryUpdateMany(...args),
    },
    waitlistSignup: {
      updateMany: (...args: unknown[]) => signupUpdateMany(...args),
    },
  },
}));

const mailConfiguration = vi.fn();
const sendEmail = vi.fn();
vi.mock("~/lib/mail.server", () => ({
  mailConfiguration: (...args: unknown[]) => mailConfiguration(...args),
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const {
  createWaitlistSignup,
  deliverOneWaitlistEmail,
  normalizeStoreUrl,
  validateWaitlistSubmission,
  verifyWaitlistUnsubscribeToken,
  waitlistUnsubscribeToken,
} = await import("./waitlist.server");

beforeEach(() => {
  vi.clearAllMocks();
  signupCreate.mockResolvedValue({ id: "signup_1" });
  entitlementCreate.mockResolvedValue({ id: "entitlement_1" });
  deliveryCreate.mockResolvedValue({ id: "delivery_1" });
  mailConfiguration.mockReturnValue({ configured: false, from: null });
});

describe("waitlist validation and persistence", () => {
  it("normalizes a contact, drops store paths and bounds attribution", () => {
    const result = validateWaitlistSubmission({
      email: "  OWNER@Example.COM ",
      storeUrl: "example.myshopify.com/admin?token=nope",
      source: "video\u0000source",
      utmCampaign: "x".repeat(140),
      marketingConsent: true,
    });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        email: "owner@example.com",
        storeUrl: "https://example.myshopify.com",
        source: "videosource",
        utmCampaign: "x".repeat(120),
        marketingConsent: true,
      }),
    });
  });

  it("rejects a non-HTTPS or credential-bearing store URL", () => {
    expect(normalizeStoreUrl("http://shop.example.com")).toBeNull();
    expect(normalizeStoreUrl("https://name:secret@shop.example.com")).toBeNull();
    expect(validateWaitlistSubmission({ email: "x@example.com", storeUrl: "http://shop.example.com" })).toMatchObject({ ok: false });
  });

  it("creates the signup, auditable entitlement and idempotent delivery together", async () => {
    await expect(createWaitlistSignup({
      email: "owner@example.com",
      storeUrl: null,
      source: "launch",
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      marketingConsent: false,
    })).resolves.toEqual({ created: true });

    expect(signupCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: "owner@example.com" }),
    }));
    expect(entitlementCreate).toHaveBeenCalledWith({ data: { signupId: "signup_1" } });
    expect(deliveryCreate).toHaveBeenCalledWith({
      data: { signupId: "signup_1", dedupeKey: "waitlist-welcome:signup_1" },
    });
  });

  it("treats a duplicate email as an indistinguishable success state", async () => {
    transaction.mockRejectedValueOnce({ code: "P2002" });
    await expect(createWaitlistSignup({
      email: "owner@example.com", storeUrl: null, source: null, utmSource: null,
      utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null,
      marketingConsent: false,
    })).resolves.toEqual({ created: false });
  });
});

describe("waitlist welcome delivery", () => {
  it("does not burn retries when Resend is unavailable", async () => {
    await expect(deliverOneWaitlistEmail()).resolves.toBe(false);
    expect(deliveryFindFirst).not.toHaveBeenCalled();
  });

  it("leases, sends with an idempotency key, and records provider receipt", async () => {
    mailConfiguration.mockReturnValue({ configured: true, from: "MyMeridian <hello@mymeridian.io>" });
    deliveryFindFirst.mockResolvedValue({
      id: "delivery_1", attempts: 0, dedupeKey: "waitlist-welcome:signup_1",
      signup: { email: "owner@example.com" }, createdAt: new Date(),
    });
    deliveryUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    sendEmail.mockResolvedValue({ id: "resend_1" });

    await expect(deliverOneWaitlistEmail(new Date("2026-08-12T00:00:00Z"))).resolves.toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "owner@example.com",
      idempotencyKey: "waitlist-welcome:signup_1",
      html: expect.stringContaining("mymeridian-email-logo.png"),
    }));
    expect(deliveryUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SENT", providerId: "resend_1" }),
    }));
  });

  it("releases a failed delivery for an exponential-backoff retry", async () => {
    mailConfiguration.mockReturnValue({ configured: true, from: "MyMeridian <hello@mymeridian.io>" });
    deliveryFindFirst.mockResolvedValue({
      id: "delivery_1", attempts: 1, dedupeKey: "waitlist-welcome:signup_1",
      signup: { email: "owner@example.com" }, createdAt: new Date(),
    });
    deliveryUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    sendEmail.mockRejectedValue(new Error("temporary provider outage"));
    const now = new Date("2026-08-12T00:00:00Z");

    await expect(deliverOneWaitlistEmail(now)).resolves.toBe(true);
    expect(deliveryUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "PENDING",
        error: "temporary provider outage",
        availableAt: new Date(now.getTime() + 2 * 60_000),
      }),
    }));
  });
});

describe("newsletter unsubscribe tokens", () => {
  it("verifies only the recipient-specific signed token", () => {
    const env = { MERIDIAN_WAITLIST_UNSUBSCRIBE_KEY: "test-only-unsubscribe-key" } as NodeJS.ProcessEnv;
    const token = waitlistUnsubscribeToken("signup_1", env);
    expect(verifyWaitlistUnsubscribeToken(token, env)).toBe("signup_1");
    expect(verifyWaitlistUnsubscribeToken(`${token}x`, env)).toBeNull();
  });
});
