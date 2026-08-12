import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;
const suite = TEST_URL ? describe : describe.skip;

suite("operator authentication on PostgreSQL", () => {
  let prisma: typeof import("~/db.server").default;
  let authenticateOperator: typeof import("./operator-auth.server").authenticateOperator;
  let requireOperator: typeof import("./operator-auth.server").requireOperator;
  let hashPassword: typeof import("./webauth.server").hashPassword;
  let generateTotp: typeof import("./operator-totp").generateTotp;

  const now = new Date("2026-08-11T22:30:00Z");
  const email = `publisher-${Date.now()}@example.com`;
  const totpSecret = ["GEZD", "GNBV", "GY3T", "QOJQ"].join("").repeat(2);
  const sessionKey = `integration-${Date.now()}-${"k".repeat(32)}`;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    ({ default: prisma } = await import("~/db.server"));
    ({ authenticateOperator, requireOperator } = await import(
      "./operator-auth.server"
    ));
    ({ hashPassword } = await import("./webauth.server"));
    ({ generateTotp } = await import("./operator-totp"));
    env = {
      MERIDIAN_OPERATOR_EMAIL: email,
      MERIDIAN_OPERATOR_PASSWORD_HASH: await hashPassword(
        "integration operator password",
      ),
      MERIDIAN_OPERATOR_TOTP_SECRET: totpSecret,
      MERIDIAN_OPERATOR_SESSION_KEY: sessionKey,
    };
    Object.assign(process.env, env);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.operatorSession.deleteMany({});
    await prisma.operatorAuditEvent.deleteMany({});
    await prisma.operatorMfaState.deleteMany({});
    await prisma.$disconnect();
  });

  it("commits MFA replay state, a hashed session and its audit atomically", async () => {
    const code = generateTotp({ secret: totpSecret, timestamp: now.getTime() });
    const loginRequest = new Request("https://app.example.com/operator/login", {
      headers: {
        origin: "https://app.example.com",
        "fly-client-ip": "203.0.113.8",
        "user-agent": "Integration browser",
      },
    });
    const first = await authenticateOperator({
      request: loginRequest,
      email,
      password: "integration operator password",
      totpCode: code,
      now,
      env,
    });
    expect(first.ok).toBe(true);

    const storedSession = await prisma.operatorSession.findFirstOrThrow();
    expect(storedSession.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.cookie).not.toContain(storedSession.tokenHash);
    expect(storedSession.actorHash).not.toContain(email);

    const second = await authenticateOperator({
      request: loginRequest,
      email,
      password: "integration operator password",
      totpCode: code,
      now,
      env,
    });
    expect(second).toEqual({ ok: false, reason: "invalid" });
    await expect(prisma.operatorSession.count()).resolves.toBe(1);

    const cookiePair = first.cookie!.split(";")[0]!;
    const principal = await requireOperator(
      new Request("https://app.example.com/operator", {
        headers: {
          cookie: cookiePair,
          "fly-client-ip": "203.0.113.8",
          "user-agent": "Integration browser",
        },
      }),
      "metrics:read",
      { action: "OPERATOR_METRICS_VIEW", resource: "aggregate_metrics" },
      new Date(now.getTime() + 1_000),
    );
    expect(principal.role).toBe("publisher");

    const audit = await prisma.operatorAuditEvent.findMany({
      orderBy: { occurredAt: "asc" },
    });
    expect(audit.map((event) => [event.action, event.outcome, event.reason])).toEqual([
      ["OPERATOR_LOGIN", "success", "password_and_totp"],
      ["OPERATOR_LOGIN", "denied", "totp_replay"],
      ["OPERATOR_METRICS_VIEW", "success", null],
    ]);
    expect(JSON.stringify(audit)).not.toContain(email);
    expect(JSON.stringify(audit)).not.toContain("203.0.113.8");
  });

  it("rejects a merchant web-session cookie and records the denied access", async () => {
    await expect(
      requireOperator(
        new Request("https://app.example.com/operator", {
          headers: { cookie: "mymeridian_session=merchant-token" },
        }),
        "metrics:read",
        { action: "OPERATOR_METRICS_VIEW", resource: "aggregate_metrics" },
        now,
      ),
    ).rejects.toMatchObject({ status: 302 });
    await expect(
      prisma.operatorAuditEvent.count({
        where: {
          action: "OPERATOR_METRICS_VIEW",
          outcome: "denied",
          reason: "missing_or_expired_session",
        },
      }),
    ).resolves.toBe(1);
  });
});
