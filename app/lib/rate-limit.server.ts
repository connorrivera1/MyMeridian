/**
 * Durable, privacy-minimising request throttling.
 *
 * Buckets live in PostgreSQL so deploys and multiple app machines share one
 * decision. The subject is HMACed before storage: a database reader cannot
 * recover the IP address, email, account id, session id or shop domain that
 * caused the bucket. Counts saturate at limit + 1 to prevent integer growth
 * under a sustained flood.
 */

import { createHmac } from "node:crypto";

import { Prisma } from "@prisma/client";

import { systemPrisma } from "~/db.server";

const KEY_BYTES = 32;
const TEST_BYPASS_ENV = "MERIDIAN_RATE_LIMIT_TEST_ENABLED";

export const RATE_LIMIT_MESSAGE =
  "Too many requests. Wait a little while and try again.";

export interface RateLimitConfiguration {
  configured: boolean;
  invalid: boolean;
}

export function rateLimitConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfiguration {
  const raw = env.MERIDIAN_RATE_LIMIT_KEY?.trim();
  if (!raw) return { configured: false, invalid: false };

  const decoded = Buffer.from(raw, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  const supplied = raw.replace(/=+$/, "");
  const valid = decoded.length === KEY_BYTES && canonical === supplied;
  return { configured: valid, invalid: !valid };
}

function keyMaterial(env: NodeJS.ProcessEnv): Buffer {
  const config = rateLimitConfiguration(env);
  if (config.configured) {
    return Buffer.from(env.MERIDIAN_RATE_LIMIT_KEY!.trim(), "base64");
  }
  if (env.NODE_ENV === "production") {
    throw new Error(
      "MERIDIAN_RATE_LIMIT_KEY must be a base64-encoded 32-byte key in production.",
    );
  }

  // Stable only within local/test code. Production cannot reach this branch.
  return Buffer.alloc(KEY_BYTES, 0x4d);
}

function clientAddress(request: Request): string {
  const fly = request.headers.get("fly-client-ip")?.trim();
  if (fly) return fly;

  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  if (forwarded) return forwarded;

  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function fingerprint(value: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", keyMaterial(env)).update(value).digest("hex");
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitInput {
  request: Request;
  scope: string;
  limit: number;
  windowMs: number;
  /** A normalised email, user id, shop id or other caller-supplied subject. */
  subject?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface RequestRateLimitsInput {
  request: Request;
  scope: string;
  windowMs: number;
  ipLimit: number;
  subject?: string;
  subjectLimit?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export async function consumeRateLimit(
  input: RateLimitInput,
): Promise<RateLimitDecision> {
  const env = input.env ?? process.env;
  if (env.NODE_ENV === "test" && env[TEST_BYPASS_ENV] !== "true") {
    return {
      allowed: true,
      limit: input.limit,
      remaining: input.limit,
      retryAfterSeconds: 0,
    };
  }

  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new Error("Rate-limit count must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1_000) {
    throw new Error("Rate-limit window must be at least one second.");
  }

  const now = input.now ?? new Date();
  const windowStartMs =
    Math.floor(now.getTime() / input.windowMs) * input.windowMs;
  const windowStart = new Date(windowStartMs);
  const expiresAt = new Date(windowStartMs + input.windowMs);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000),
  );
  const scope = input.scope.slice(0, 100);
  const identity = input.subject
    ? `subject:${input.subject}`
    : `ip:${clientAddress(input.request)}`;
  const subjectHash = fingerprint(identity, env);

  // Rate-limit fingerprints are deliberately a system-only relation: they
  // protect public endpoints and can cover one subject across more than one
  // merchant. Running this insert through a tenant transaction makes correct
  // RLS deny it, which turns a protected mutation into a 500. The dedicated
  // system runtime role has the narrow grant required for this table.
  const rows = await systemPrisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "RateLimitBucket"
      ("scope", "subjectHash", "windowStart", "count", "expiresAt", "updatedAt")
    VALUES
      (${scope}, ${subjectHash}, ${windowStart}, 1, ${expiresAt}, ${now})
    ON CONFLICT ("scope", "subjectHash", "windowStart") DO UPDATE
    SET "count" = LEAST("RateLimitBucket"."count" + 1, ${input.limit + 1}),
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "count"
  `);

  const count = rows[0]?.count ?? input.limit + 1;
  return {
    allowed: count <= input.limit,
    limit: input.limit,
    remaining: Math.max(0, input.limit - count),
    retryAfterSeconds: count <= input.limit ? 0 : retryAfterSeconds,
  };
}

/** Apply both anti-spray (IP) and anti-targeting (subject) controls. */
export async function firstDeniedRequestLimit(
  input: RequestRateLimitsInput,
): Promise<RateLimitDecision | null> {
  const ip = await consumeRateLimit({
    request: input.request,
    scope: `${input.scope}:ip`,
    limit: input.ipLimit,
    windowMs: input.windowMs,
    now: input.now,
    env: input.env,
  });
  if (!ip.allowed) return ip;

  if (!input.subject) return null;
  const subject = await consumeRateLimit({
    request: input.request,
    scope: `${input.scope}:subject`,
    limit: input.subjectLimit ?? input.ipLimit,
    windowMs: input.windowMs,
    subject: input.subject,
    now: input.now,
    env: input.env,
  });
  return subject.allowed ? null : subject;
}

export function rateLimitHeaders(decision: RateLimitDecision): HeadersInit {
  return {
    "retry-after": String(decision.retryAfterSeconds),
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
    "cache-control": "no-store",
  };
}

export async function purgeExpiredRateLimitBuckets(
  now = new Date(),
): Promise<number> {
  const deleted = await systemPrisma.rateLimitBucket.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return deleted.count;
}
