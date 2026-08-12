import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const deleteMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    rateLimitBucket: {
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));

const {
  consumeRateLimit,
  purgeExpiredRateLimitBuckets,
  rateLimitConfiguration,
  rateLimitHeaders,
} = await import("./rate-limit.server");

const env = {
  NODE_ENV: "test",
  MERIDIAN_RATE_LIMIT_TEST_ENABLED: "true",
  MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 7).toString("base64"),
} as NodeJS.ProcessEnv;

beforeEach(() => vi.clearAllMocks());

describe("durable rate limiting", () => {
  it("requires exactly 32 bytes of canonical base64 key material", () => {
    expect(rateLimitConfiguration({})).toEqual({
      configured: false,
      invalid: false,
    });
    expect(
      rateLimitConfiguration({ MERIDIAN_RATE_LIMIT_KEY: "not-base64" }),
    ).toEqual({ configured: false, invalid: true });
    expect(rateLimitConfiguration(env)).toEqual({
      configured: true,
      invalid: false,
    });
  });

  it("allows through the limit and then returns a bounded retry response", async () => {
    queryRaw
      .mockResolvedValueOnce([{ count: 5 }])
      .mockResolvedValueOnce([{ count: 6 }]);
    const request = new Request("https://app.example.com/login", {
      headers: { "fly-client-ip": "203.0.113.20" },
    });

    const allowed = await consumeRateLimit({
      request,
      scope: "login:ip",
      limit: 5,
      windowMs: 60_000,
      now: new Date("2026-08-11T22:30:30Z"),
      env,
    });
    const denied = await consumeRateLimit({
      request,
      scope: "login:ip",
      limit: 5,
      windowMs: 60_000,
      now: new Date("2026-08-11T22:30:30Z"),
      env,
    });

    expect(allowed).toMatchObject({ allowed: true, remaining: 0 });
    expect(denied).toEqual({
      allowed: false,
      limit: 5,
      remaining: 0,
      retryAfterSeconds: 30,
    });
    expect(rateLimitHeaders(denied)).toMatchObject({
      "retry-after": "30",
      "cache-control": "no-store",
    });
  });

  it("purges spent fingerprints after their windows expire", async () => {
    deleteMany.mockResolvedValue({ count: 4 });
    await expect(purgeExpiredRateLimitBuckets()).resolves.toBe(4);
  });
});
