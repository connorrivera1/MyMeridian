import { beforeEach, describe, expect, it, vi } from "vitest";

const userUpdate = vi.fn();
const userFindUniqueOrThrow = vi.fn();
const challengeCreate = vi.fn();
const challengeFindFirst = vi.fn();
const challengeUpdate = vi.fn();
const challengeUpdateMany = vi.fn();
const challengeDeleteMany = vi.fn();
const sessionUpdate = vi.fn();
const sendEmail = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    user: {
      update: (...args: unknown[]) => userUpdate(...args),
      findUniqueOrThrow: (...args: unknown[]) => userFindUniqueOrThrow(...args),
    },
    mfaChallenge: {
      create: (...args: unknown[]) => challengeCreate(...args),
      findFirst: (...args: unknown[]) => challengeFindFirst(...args),
      update: (...args: unknown[]) => challengeUpdate(...args),
      updateMany: (...args: unknown[]) => challengeUpdateMany(...args),
      deleteMany: (...args: unknown[]) => challengeDeleteMany(...args),
    },
    webSession: { update: (...args: unknown[]) => sessionUpdate(...args) },
  },
}));

vi.mock("~/lib/crypto.server", () => ({
  encryptSecret: (value: string) => `encrypted:${value}`,
  decryptSecret: (value: string) => value.replace(/^encrypted:/, ""),
}));

vi.mock("~/lib/mail.server", () => ({
  mailConfiguration: (env: NodeJS.ProcessEnv) => ({
    configured: Boolean(env.RESEND_API_KEY && env.MERIDIAN_EMAIL_FROM),
    from: env.MERIDIAN_EMAIL_FROM ?? null,
  }),
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

vi.mock("~/lib/password-reset.server", () => ({
  generateCode: () => "123456",
  normalizeCode: (raw: string) => raw.replace(/\D/g, ""),
}));

const {
  normalizePhoneNumber,
  purgeExpiredMfaChallenges,
  SmsVerificationProviderError,
  smsProviderConfiguration,
  startMfaChallenge,
  verifyMfaChallenge,
} = await import("./mfa.server");

const NOW = new Date("2026-08-11T22:30:00Z");
const env = {
  NODE_ENV: "test",
  MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 4).toString("base64"),
  RESEND_API_KEY: "resend-key",
  MERIDIAN_EMAIL_FROM: "MyMeridian <security@example.com>",
} as NodeJS.ProcessEnv;

const session = {
  id: "session-1",
  userId: "user-1",
  mfaVerifiedAt: null,
  user: {
    id: "user-1",
    email: "owner@example.com",
    emailVerifiedAt: NOW,
    phoneNumberEnc: "encrypted:+12125550100",
    phoneLast4: "0100",
    phoneVerifiedAt: NOW,
  },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  challengeUpdateMany.mockResolvedValue({ count: 1 });
  challengeUpdate.mockResolvedValue({});
  userUpdate.mockResolvedValue({});
  userFindUniqueOrThrow.mockResolvedValue({
    emailVerifiedAt: NOW,
    phoneVerifiedAt: NOW,
  });
  sessionUpdate.mockResolvedValue({});
  sendEmail.mockResolvedValue({ id: "email-1" });
  challengeDeleteMany.mockResolvedValue({ count: 2 });
});

describe("MFA provider boundaries", () => {
  it("normalises only plausible E.164 phone numbers", () => {
    expect(normalizePhoneNumber("+1 (212) 555-0100")).toBe("+12125550100");
    expect(normalizePhoneNumber("212-555-0100")).toBeNull();
    expect(normalizePhoneNumber("+00000000")).toBeNull();
  });

  it("requires a complete restricted Twilio Verify configuration", () => {
    expect(smsProviderConfiguration({})).toEqual({
      configured: false,
      invalid: [],
    });
    const configured = smsProviderConfiguration({
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
      TWILIO_API_KEY_SECRET: "c".repeat(32),
      TWILIO_VERIFY_SERVICE_SID: `VA${"d".repeat(32)}`,
    });
    expect(configured).toEqual({ configured: true, invalid: [] });
  });

  it("stores only a keyed code and destination fingerprint for email", async () => {
    challengeCreate.mockImplementation(async ({ data }) => ({
      id: "challenge-1",
      ...data,
    }));
    const started = await startMfaChallenge({
      session,
      purpose: "login",
      channel: "email",
      now: NOW,
      env,
    });

    expect(started.localCode).toBe("123456");
    const stored = challengeCreate.mock.calls[0]?.[0].data;
    expect(stored.codeHash).not.toContain("123456");
    expect(stored.destinationHash).not.toContain("owner@example.com");
    expect(JSON.stringify(stored)).not.toContain("owner@example.com");
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "mfa/challenge-1" }),
      expect.any(Object),
    );
  });

  it("delegates production SMS codes to Twilio Verify without storing a code", async () => {
    challengeCreate.mockImplementation(async ({ data }) => ({
      id: "challenge-sms",
      ...data,
    }));
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ sid: `VE${"e".repeat(32)}`, status: "pending" }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    await startMfaChallenge({
      session,
      purpose: "login",
      channel: "sms",
      now: NOW,
      env: {
        ...env,
        NODE_ENV: "production",
        TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
        TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
        TWILIO_API_KEY_SECRET: "c".repeat(32),
        TWILIO_VERIFY_SERVICE_SID: `VA${"d".repeat(32)}`,
      },
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(challengeCreate.mock.calls[0]?.[0].data.codeHash).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/Verifications"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(challengeUpdate).toHaveBeenCalledWith({
      where: { id: "challenge-sms" },
      data: { providerRef: `VE${"e".repeat(32)}` },
    });
  });

  it("returns a safe typed error for a rejected Twilio request", async () => {
    challengeCreate.mockImplementation(async ({ data }) => ({
      id: "challenge-rejected-sms",
      ...data,
    }));
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 21608 }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    let thrown: unknown;
    try {
      await startMfaChallenge({
        session,
        purpose: "login",
        channel: "sms",
        now: NOW,
        env: {
          ...env,
          NODE_ENV: "production",
          TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
          TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
          TWILIO_API_KEY_SECRET: "c".repeat(32),
          TWILIO_VERIFY_SERVICE_SID: `VA${"d".repeat(32)}`,
        },
        fetchImpl: fetchImpl as typeof fetch,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SmsVerificationProviderError);
    expect(thrown).toMatchObject({ status: 403, code: 21608 });
    expect(challengeUpdate).toHaveBeenLastCalledWith({
      where: { id: "challenge-rejected-sms" },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("accepts one correct challenge and elevates only its own session", async () => {
    let stored: Record<string, unknown> = {};
    challengeCreate.mockImplementation(async ({ data }) => {
      stored = data;
      return { id: "challenge-1", ...data };
    });
    await startMfaChallenge({
      session,
      purpose: "login",
      channel: "email",
      now: NOW,
      env,
    });
    challengeFindFirst.mockResolvedValue({
      id: "challenge-1",
      sessionId: "session-1",
      userId: "user-1",
      purpose: "login",
      channel: "email",
      codeHash: stored.codeHash,
      attempts: 0,
      expiresAt: new Date(NOW.getTime() + 60_000),
      consumedAt: null,
    });

    await expect(
      verifyMfaChallenge({
        session,
        challengeId: "challenge-1",
        code: "123456",
        now: NOW,
        env,
      }),
    ).resolves.toEqual({ status: "ok" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { mfaVerifiedAt: NOW, reauthenticatedAt: NOW },
    });
  });

  it("never elevates a session for a wrong code", async () => {
    challengeFindFirst.mockResolvedValue({
      id: "challenge-1",
      sessionId: "session-1",
      userId: "user-1",
      purpose: "login",
      channel: "email",
      codeHash: "0".repeat(64),
      attempts: 0,
      expiresAt: new Date(NOW.getTime() + 60_000),
      consumedAt: null,
    });
    await expect(
      verifyMfaChallenge({
        session,
        challengeId: "challenge-1",
        code: "123456",
        now: NOW,
        env,
      }),
    ).resolves.toEqual({ status: "invalid" });
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("never elevates login before both email and phone are verified", async () => {
    userFindUniqueOrThrow.mockResolvedValue({
      emailVerifiedAt: NOW,
      phoneVerifiedAt: null,
    });
    challengeFindFirst.mockResolvedValue({
      id: "challenge-1",
      sessionId: "session-1",
      userId: "user-1",
      purpose: "login",
      channel: "email",
      codeHash: "0".repeat(64),
      attempts: 0,
      expiresAt: new Date(NOW.getTime() + 60_000),
      consumedAt: null,
    });

    // Make the stored keyed hash match without weakening the production code.
    let stored: Record<string, unknown> = {};
    challengeCreate.mockImplementation(async ({ data }) => {
      stored = data;
      return { id: "challenge-1", ...data };
    });
    await startMfaChallenge({
      session,
      purpose: "login",
      channel: "email",
      now: NOW,
      env,
    });
    challengeFindFirst.mockResolvedValue({
      id: "challenge-1",
      sessionId: "session-1",
      userId: "user-1",
      purpose: "login",
      channel: "email",
      codeHash: stored.codeHash,
      attempts: 0,
      expiresAt: new Date(NOW.getTime() + 60_000),
      consumedAt: null,
    });

    await expect(
      verifyMfaChallenge({
        session,
        challengeId: "challenge-1",
        code: "123456",
        now: NOW,
        env,
      }),
    ).resolves.toEqual({ status: "invalid" });
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("purges expired challenges", async () => {
    await expect(purgeExpiredMfaChallenges(NOW)).resolves.toBe(2);
  });
});
