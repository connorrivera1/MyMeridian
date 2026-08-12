import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;
const suite = TEST_URL ? describe : describe.skip;

suite("durable rate limits on PostgreSQL", () => {
  let prisma: typeof import("~/db.server").default;
  let consumeRateLimit: typeof import("./rate-limit.server").consumeRateLimit;
  const scope = `integration-${Date.now()}`;
  const env = {
    NODE_ENV: "test",
    MERIDIAN_RATE_LIMIT_TEST_ENABLED: "true",
    MERIDIAN_RATE_LIMIT_KEY: Buffer.alloc(32, 9).toString("base64"),
  } as NodeJS.ProcessEnv;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    ({ default: prisma } = await import("~/db.server"));
    ({ consumeRateLimit } = await import("./rate-limit.server"));
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.rateLimitBucket.deleteMany({
      where: { scope: { startsWith: scope } },
    });
  });

  it("admits exactly the configured concurrency and stores no raw identity", async () => {
    const now = new Date("2026-08-11T22:30:30Z");
    const request = new Request("https://app.example.com/login", {
      headers: { "fly-client-ip": "203.0.113.44" },
    });

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeRateLimit({
          request,
          scope,
          subject: "private-person@example.com",
          limit: 5,
          windowMs: 60_000,
          now,
          env,
        }),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    const buckets = await prisma.rateLimitBucket.findMany({ where: { scope } });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.count).toBe(6);
    expect(JSON.stringify(buckets)).not.toContain("private-person@example.com");
    expect(JSON.stringify(buckets)).not.toContain("203.0.113.44");
  });
});
