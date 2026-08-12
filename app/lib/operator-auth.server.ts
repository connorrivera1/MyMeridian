import { createHmac, randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { redirect } from "react-router";

import prisma from "~/db.server";
import {
  decoyPasswordHash,
  hashToken,
  normalizeEmail,
  verifyPassword,
} from "~/lib/webauth.server";
import {
  verifyTotp,
} from "~/lib/operator-totp";
export { operatorConfiguration } from "~/lib/operator-config";
import { operatorConfiguration } from "~/lib/operator-config";
import {
  readCookie,
  requestIsSecure,
} from "~/lib/web-session.server";

const COOKIE_BASE = "mymeridian_operator_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const IDLE_TTL_MS = 30 * 60 * 1_000;
const TOUCH_AFTER_MS = 5 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 5;

export const OPERATOR_ROLE = "publisher" as const;
export const OPERATOR_PERMISSIONS = ["metrics:read", "stores:read"] as const;
export type OperatorPermission = (typeof OPERATOR_PERMISSIONS)[number];

interface OperatorSecrets {
  email: string;
  passwordHash: string;
  totpSecret: string;
  sessionKey: string;
}

export interface OperatorPrincipal {
  actorHash: string;
  role: typeof OPERATOR_ROLE;
  sessionId: string;
}

export interface OperatorLoginResult {
  ok: boolean;
  cookie?: string;
  reason?: "invalid" | "rate_limited" | "not_configured";
}

function loadSecrets(env: NodeJS.ProcessEnv = process.env): OperatorSecrets | null {
  if (!operatorConfiguration(env).configured) return null;
  return {
    email: normalizeEmail(env.MERIDIAN_OPERATOR_EMAIL!),
    passwordHash: env.MERIDIAN_OPERATOR_PASSWORD_HASH!.trim(),
    totpSecret: env.MERIDIAN_OPERATOR_TOTP_SECRET!.trim(),
    sessionKey: env.MERIDIAN_OPERATOR_SESSION_KEY!,
  };
}

function keyedHash(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function requestIdentity(request: Request, key: string): {
  ipHash: string;
  userAgentHash: string;
} {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = request.headers.get("fly-client-ip")?.trim() || forwarded || "unknown";
  const userAgent = request.headers.get("user-agent")?.slice(0, 512) || "unknown";
  return {
    ipHash: keyedHash(`ip:${ip}`, key),
    userAgentHash: keyedHash(`ua:${userAgent}`, key),
  };
}

export function operatorCookieName(secure: boolean): string {
  return secure ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

export function readOperatorSessionToken(request: Request): string | null {
  const secure = requestIsSecure(request);
  // Unlike merchant web OAuth, operator auth never needs an http-to-https
  // callback handoff. A production request therefore accepts only the
  // host-prefixed Secure cookie and cannot be fixed to a local-development
  // cookie name before a scheme upgrade.
  return readCookie(request, operatorCookieName(secure));
}

export function serializeOperatorCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds = SESSION_TTL_MS / 1_000,
): string {
  return [
    `${operatorCookieName(secure)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function serializeOperatorClearCookies(): string[] {
  return [true, false].map((secure) =>
    [
      `${operatorCookieName(secure)}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
      ...(secure ? ["Secure"] : []),
    ].join("; "),
  );
}

export const OPERATOR_SECURITY_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

function actorHashForEmail(email: string, key: string): string {
  return keyedHash(`actor:${normalizeEmail(email)}`, key);
}

export async function recordOperatorAudit(input: {
  request: Request;
  actorHash: string;
  action: string;
  resource: string;
  outcome: "success" | "denied" | "failure";
  reason?: string;
  shopId?: string;
  sessionKey: string;
}): Promise<void> {
  const identity = requestIdentity(input.request, input.sessionKey);
  await prisma.operatorAuditEvent.create({
    data: {
      actorHash: input.actorHash,
      action: input.action.slice(0, 100),
      resource: input.resource.slice(0, 200),
      requestPath: new URL(input.request.url).pathname.slice(0, 500),
      outcome: input.outcome,
      reason: input.reason?.slice(0, 100) ?? null,
      shopId: input.shopId ?? null,
      ...identity,
    },
  });
}

/** Record an authorized resource read after the target has been resolved. */
export async function recordAuthorizedOperatorRead(input: {
  request: Request;
  principal: OperatorPrincipal;
  action: string;
  resource: string;
  shopId?: string;
}): Promise<void> {
  const secrets = loadSecrets();
  if (!secrets) {
    throw new Response("Operator access is not configured.", {
      status: 503,
      headers: OPERATOR_SECURITY_HEADERS,
    });
  }
  await recordOperatorAudit({
    request: input.request,
    actorHash: input.principal.actorHash,
    action: input.action,
    resource: input.resource,
    outcome: "success",
    shopId: input.shopId,
    sessionKey: secrets.sessionKey,
  });
}

async function failedLoginCount(
  actorHash: string,
  ipHash: string,
  now: Date,
): Promise<number> {
  return prisma.operatorAuditEvent.count({
    where: {
      action: "OPERATOR_LOGIN",
      outcome: "denied",
      occurredAt: { gte: new Date(now.getTime() - LOGIN_WINDOW_MS) },
      OR: [{ actorHash }, { ipHash }],
    },
  });
}

export async function authenticateOperator(input: {
  request: Request;
  email: string;
  password: string;
  totpCode: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<OperatorLoginResult> {
  const now = input.now ?? new Date();
  const secrets = loadSecrets(input.env);
  if (!secrets) return { ok: false, reason: "not_configured" };

  const normalizedEmail = normalizeEmail(input.email);
  const submittedActorHash = actorHashForEmail(normalizedEmail, secrets.sessionKey);
  const configuredActorHash = actorHashForEmail(secrets.email, secrets.sessionKey);
  const identity = requestIdentity(input.request, secrets.sessionKey);
  const rateLimited =
    (await failedLoginCount(submittedActorHash, identity.ipHash, now)) >=
    MAX_LOGIN_FAILURES;

  const passwordHash =
    normalizedEmail === secrets.email
      ? secrets.passwordHash
      : await decoyPasswordHash();
  const passwordOk = await verifyPassword(input.password, passwordHash);
  let counter: number | null = null;
  try {
    counter = verifyTotp(input.totpCode.trim(), {
      secret: secrets.totpSecret,
      timestamp: now.getTime(),
      window: 1,
    });
  } catch {
    counter = null;
  }

  if (
    rateLimited ||
    normalizedEmail !== secrets.email ||
    !passwordOk ||
    counter === null
  ) {
    await recordOperatorAudit({
      request: input.request,
      actorHash: submittedActorHash,
      action: "OPERATOR_LOGIN",
      resource: "operator_auth",
      outcome: "denied",
      reason: rateLimited ? "rate_limited" : "invalid_credentials",
      sessionKey: secrets.sessionKey,
    });
    return { ok: false, reason: rateLimited ? "rate_limited" : "invalid" };
  }

  const token = randomBytes(32).toString("base64url");
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ actorHash: string }>>(Prisma.sql`
        INSERT INTO "OperatorMfaState" ("actorHash", "lastAcceptedCounter", "updatedAt")
        VALUES (${configuredActorHash}, ${BigInt(counter!)}, ${now})
        ON CONFLICT ("actorHash") DO UPDATE
        SET "lastAcceptedCounter" = EXCLUDED."lastAcceptedCounter",
            "updatedAt" = EXCLUDED."updatedAt"
        WHERE "OperatorMfaState"."lastAcceptedCounter" < EXCLUDED."lastAcceptedCounter"
        RETURNING "actorHash"
      `);
      if (claimed.length !== 1) throw new TotpReplayError();

      await tx.operatorSession.create({
        data: {
          tokenHash: hashToken(token),
          actorHash: configuredActorHash,
          role: OPERATOR_ROLE,
          mfaAt: now,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
          ...identity,
        },
      });
      await tx.operatorAuditEvent.create({
        data: {
          actorHash: configuredActorHash,
          action: "OPERATOR_LOGIN",
          resource: "operator_auth",
          requestPath: new URL(input.request.url).pathname.slice(0, 500),
          outcome: "success",
          reason: "password_and_totp",
          ...identity,
          occurredAt: now,
        },
      });
    });
  } catch (error) {
    if (!(error instanceof TotpReplayError)) throw error;
    await recordOperatorAudit({
      request: input.request,
      actorHash: configuredActorHash,
      action: "OPERATOR_LOGIN",
      resource: "operator_auth",
      outcome: "denied",
      reason: "totp_replay",
      sessionKey: secrets.sessionKey,
    });
    return { ok: false, reason: "invalid" };
  }

  return {
    ok: true,
    cookie: serializeOperatorCookie(
      token,
      requestIsSecure(input.request),
    ),
  };
}

class TotpReplayError extends Error {}

function roleAllows(role: string, permission: OperatorPermission): boolean {
  return role === OPERATOR_ROLE && OPERATOR_PERMISSIONS.includes(permission);
}

export async function requireOperator(
  request: Request,
  permission: OperatorPermission,
  audit: { action: string; resource: string; shopId?: string },
  now = new Date(),
): Promise<OperatorPrincipal> {
  const secrets = loadSecrets();
  if (!secrets) {
    throw new Response("Operator access is not configured.", {
      status: 503,
      headers: OPERATOR_SECURITY_HEADERS,
    });
  }

  const token = readOperatorSessionToken(request);
  const session = token
    ? await prisma.operatorSession.findUnique({
        where: { tokenHash: hashToken(token) },
      })
    : null;
  const live =
    session &&
    !session.revokedAt &&
    session.expiresAt > now &&
    now.getTime() - session.lastSeenAt.getTime() <= IDLE_TTL_MS;
  const allowed = live && roleAllows(session.role, permission);
  const configuredActorHash = actorHashForEmail(
    secrets.email,
    secrets.sessionKey,
  );
  const identityMatches = live && session.actorHash === configuredActorHash;

  if (!allowed || !identityMatches) {
    await recordOperatorAudit({
      request,
      actorHash:
        session?.actorHash ?? keyedHash("actor:anonymous", secrets.sessionKey),
      action: audit.action,
      resource: audit.resource,
      outcome: "denied",
      reason: !live
        ? "missing_or_expired_session"
        : !identityMatches
          ? "operator_identity_rotated"
          : "insufficient_role",
      shopId: audit.shopId,
      sessionKey: secrets.sessionKey,
    });
    throw redirect("/operator/login", {
      headers: OPERATOR_SECURITY_HEADERS,
    });
  }

  await recordOperatorAudit({
    request,
    actorHash: session.actorHash,
    action: audit.action,
    resource: audit.resource,
    outcome: "success",
    shopId: audit.shopId,
    sessionKey: secrets.sessionKey,
  });

  if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_AFTER_MS) {
    await prisma.operatorSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { lastSeenAt: now },
    });
  }

  return {
    actorHash: session.actorHash,
    role: OPERATOR_ROLE,
    sessionId: session.id,
  };
}

export async function revokeOperatorSession(
  request: Request,
  now = new Date(),
): Promise<void> {
  const secrets = loadSecrets();
  const token = readOperatorSessionToken(request);
  if (!secrets || !token) return;

  const session = await prisma.operatorSession.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!session) return;

  await prisma.$transaction([
    prisma.operatorSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.operatorAuditEvent.create({
      data: {
        actorHash: session.actorHash,
        action: "OPERATOR_LOGOUT",
        resource: "operator_auth",
        requestPath: new URL(request.url).pathname.slice(0, 500),
        outcome: "success",
        reason: "explicit_logout",
        ...requestIdentity(request, secrets.sessionKey),
        occurredAt: now,
      },
    }),
  ]);
}

export async function purgeExpiredOperatorSecurityData(
  now = new Date(),
  auditRetentionDays = 365,
): Promise<{ sessions: number; auditEvents: number }> {
  const auditCutoff = new Date(
    now.getTime() - auditRetentionDays * 24 * 60 * 60 * 1_000,
  );
  const sessionCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
  const [sessions, auditEvents] = await prisma.$transaction([
    prisma.operatorSession.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: sessionCutoff } },
          { revokedAt: { lt: sessionCutoff } },
        ],
      },
    }),
    prisma.operatorAuditEvent.deleteMany({
      where: { occurredAt: { lt: auditCutoff } },
    }),
  ]);
  return { sessions: sessions.count, auditEvents: auditEvents.count };
}
