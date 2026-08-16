import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditCount = vi.fn();
const auditCreate = vi.fn();
const auditDeleteMany = vi.fn();
const sessionFindUnique = vi.fn();
const sessionCreate = vi.fn();
const sessionUpdateMany = vi.fn();
const sessionDeleteMany = vi.fn();
const transactionQuery = vi.fn();

const transactionClient = {
  $queryRaw: (...args: unknown[]) => transactionQuery(...args),
  operatorSession: { create: (...args: unknown[]) => sessionCreate(...args) },
  operatorAuditEvent: { create: (...args: unknown[]) => auditCreate(...args) },
};

vi.mock("~/db.server", () => ({
  default: {
    operatorAuditEvent: {
      count: (...args: unknown[]) => auditCount(...args),
      create: (...args: unknown[]) => auditCreate(...args),
      deleteMany: (...args: unknown[]) => auditDeleteMany(...args),
    },
    operatorSession: {
      findUnique: (...args: unknown[]) => sessionFindUnique(...args),
      create: (...args: unknown[]) => sessionCreate(...args),
      updateMany: (...args: unknown[]) => sessionUpdateMany(...args),
      deleteMany: (...args: unknown[]) => sessionDeleteMany(...args),
    },
    $transaction: (argument: unknown) =>
      typeof argument === "function"
        ? (argument as (tx: typeof transactionClient) => unknown)(transactionClient)
        : Promise.all(argument as Promise<unknown>[]),
  },
}));

const {
  OPERATOR_SECURITY_HEADERS,
  authenticateOperator,
  operatorConfiguration,
  operatorCookieName,
  requireOperator,
  serializeOperatorClearCookies,
  serializeOperatorCookie,
} = await import("./operator-auth.server");
const { hashPassword } = await import("./webauth.server");
const { generateTotp } = await import("./operator-totp");

const NOW = new Date("2026-08-11T22:30:00Z");
let passwordHash = "";

function environment() {
  return {
    NODE_ENV: "production",
    MERIDIAN_OPERATOR_EMAIL: "publisher@example.com",
    MERIDIAN_OPERATOR_PASSWORD_HASH: passwordHash,
    MERIDIAN_OPERATOR_TOTP_SECRET: ["GEZD", "GNBV", "GY3T", "QOJQ"]
      .join("")
      .repeat(2),
    MERIDIAN_OPERATOR_SESSION_KEY: "k".repeat(32),
  } as NodeJS.ProcessEnv;
}

function request(cookie?: string) {
  return new Request("https://ops.example.com/operator", {
    headers: {
      ...(cookie ? { cookie } : {}),
      "user-agent": "OperatorBrowser/1",
      "fly-client-ip": "203.0.113.7",
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  passwordHash ||= await hashPassword("correct horse battery staple");
  auditCount.mockResolvedValue(0);
  auditCreate.mockResolvedValue({ id: "audit_1" });
  sessionCreate.mockResolvedValue({ id: "operator_session" });
  sessionUpdateMany.mockResolvedValue({ count: 1 });
  transactionQuery.mockResolvedValue([{ actorHash: "claimed" }]);
  for (const [key, value] of Object.entries(environment())) {
    vi.stubEnv(key, value!);
  }
});

describe("operator configuration and transport", () => {
  it("fails closed for missing or weak security material", () => {
    expect(operatorConfiguration({ NODE_ENV: "production" })).toMatchObject({
      configured: false,
      missing: expect.arrayContaining([
        "MERIDIAN_OPERATOR_EMAIL",
        "MERIDIAN_OPERATOR_TOTP_SECRET",
      ]),
    });
    const weak = operatorConfiguration({
      MERIDIAN_OPERATOR_EMAIL: "bad",
      MERIDIAN_OPERATOR_PASSWORD_HASH: "plaintext",
      MERIDIAN_OPERATOR_TOTP_SECRET: "bad",
      MERIDIAN_OPERATOR_SESSION_KEY: "short",
    });
    expect(weak.configured).toBe(false);
    expect(weak.invalid).toHaveLength(4);
  });

  it("uses an isolated Strict host cookie and clears both transport variants", () => {
    expect(operatorCookieName(true)).toBe(
      "__Host-mymeridian_operator_session",
    );
    const cookie = serializeOperatorCookie("raw-token", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("mymeridian_session=");
    expect(serializeOperatorClearCookies()).toHaveLength(2);
  });

  it("sends no-store, no-frame and no-index response controls", () => {
    expect(OPERATOR_SECURITY_HEADERS["cache-control"]).toContain("no-store");
    expect(OPERATOR_SECURITY_HEADERS["strict-transport-security"]).toContain(
      "max-age=31536000",
    );
    expect(OPERATOR_SECURITY_HEADERS["x-frame-options"]).toBe("DENY");
    expect(OPERATOR_SECURITY_HEADERS["x-robots-tag"]).toContain("noindex");
    expect(OPERATOR_SECURITY_HEADERS["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
});

describe("operator authentication", () => {
  it("requires password and TOTP, creates a dedicated session, and audits success", async () => {
    const totpCode = generateTotp({
      secret: environment().MERIDIAN_OPERATOR_TOTP_SECRET!,
      timestamp: NOW.getTime(),
    });
    const result = await authenticateOperator({
      request: request(),
      email: "publisher@example.com",
      password: "correct horse battery staple",
      totpCode,
      now: NOW,
      env: environment(),
    });

    expect(result.ok).toBe(true);
    expect(result.cookie).toContain("__Host-mymeridian_operator_session");
    expect(transactionQuery).toHaveBeenCalledOnce();
    expect(sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        role: "publisher",
        mfaAt: NOW,
      }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "OPERATOR_LOGIN",
        outcome: "success",
      }),
    });
    expect(JSON.stringify(sessionCreate.mock.calls)).not.toContain(
      "publisher@example.com",
    );
  });

  it("rejects replay of the same TOTP counter and audits the denial", async () => {
    transactionQuery.mockResolvedValue([]);
    const totpCode = generateTotp({
      secret: environment().MERIDIAN_OPERATOR_TOTP_SECRET!,
      timestamp: NOW.getTime(),
    });
    const result = await authenticateOperator({
      request: request(),
      email: "publisher@example.com",
      password: "correct horse battery staple",
      totpCode,
      now: NOW,
      env: environment(),
    });

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: "totp_replay", outcome: "denied" }),
    });
  });

  it("rate limits repeated failures without disclosing which factor was wrong", async () => {
    auditCount.mockResolvedValue(5);
    const result = await authenticateOperator({
      request: request(),
      email: "publisher@example.com",
      password: "wrong",
      totpCode: "000000",
      now: NOW,
      env: environment(),
    });
    expect(result).toEqual({ ok: false, reason: "rate_limited" });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: "rate_limited", outcome: "denied" }),
    });
  });
});

describe("operator authorization isolation", () => {
  it("accepts only a live publisher operator session and audits every read", async () => {
    sessionFindUnique.mockResolvedValue({
      id: "operator_session",
      actorHash: createHmac("sha256", "k".repeat(32))
        .update("actor:publisher@example.com")
        .digest("hex"),
      role: "publisher",
      mfaAt: NOW,
      createdAt: NOW,
      lastSeenAt: new Date(NOW.getTime() - 6 * 60_000),
      expiresAt: new Date(NOW.getTime() + 60 * 60_000),
      revokedAt: null,
      ipHash: "i",
      userAgentHash: "u",
    });
    const req = request(
      "__Host-mymeridian_operator_session=operator-token; mymeridian_session=merchant-token",
    );
    const principal = await requireOperator(
      req,
      "stores:read",
      { action: "OPERATOR_STORE_VIEW", resource: "store", shopId: "shop_1" },
      NOW,
    );
    expect(principal.role).toBe("publisher");
    expect(sessionFindUnique).toHaveBeenCalledWith({
      where: expect.objectContaining({ tokenHash: expect.any(String) }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "OPERATOR_STORE_VIEW",
        shopId: "shop_1",
        outcome: "success",
      }),
    });
    expect(sessionUpdateMany).toHaveBeenCalledOnce();
  });

  it("does not accept the merchant session cookie", async () => {
    sessionFindUnique.mockResolvedValue(null);
    await expect(
      requireOperator(
        request("mymeridian_session=merchant-token"),
        "metrics:read",
        { action: "OPERATOR_METRICS_VIEW", resource: "metrics" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 302 });
    expect(sessionFindUnique).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ outcome: "denied" }),
    });
  });
});
