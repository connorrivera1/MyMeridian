/**
 * Identity for the web dashboard.
 *
 * The embedded app never needed this: Shopify's session token says who the
 * merchant is, and `requireShopContext` turns that into a Shop. A browser
 * arriving at the marketing domain carries no such token, so this module is
 * the app's own answer to "who is this".
 *
 * The boundary it must hold: an account here proves control of an email
 * address and nothing more. It is deliberately not sufficient to see a store's
 * numbers — that requires a `ShopMembership`, which is written only by the
 * Shopify OAuth callback. Everything in this file stops at authentication;
 * authorisation is `shop-access.server.ts`.
 *
 * Hashing is node's own scrypt rather than bcrypt or argon2. Both of those are
 * native modules, and this app deploys as a slim Docker image where a
 * node-gyp build step is a real source of "works locally, fails in CI".
 * scrypt is memory-hard, in the standard library, and needs no build.
 */

import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

import type { User, WebSession } from "@prisma/client";

import { systemPrisma as prisma } from "~/db.server";

/*
 * promisify picks the no-options overload, so the cost parameters would be
 * dropped silently — every hash computed at scrypt's defaults while the
 * encoded string claimed otherwise. Typed explicitly so that cannot happen.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/* ------------------------------------------------------------- passwords */

/**
 * Cost parameters, stored inside every hash rather than assumed.
 *
 * They are written into the encoded string so that raising them later
 * re-verifies old passwords with the parameters they were created under,
 * instead of failing every existing login the day the cost changes.
 *
 * N=16384/r=8 needs 128·N·r = 16MB per hash, which fits under node's default
 * 32MB scrypt maxmem. Raising N past 32768 without also raising maxmem throws
 * at verification time — on a path where the only symptom is that nobody can
 * log in.
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

async function deriveKey(
  plain: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keylen: number,
): Promise<Buffer> {
  // The cost parameters decide the memory requirement, so maxmem has to be
  // derived from them rather than left at the default — otherwise raising N
  // later throws instead of simply costing more.
  const maxmem = 256 * n * r;
  return scrypt(plain.normalize("NFKC"), salt, keylen, {
    N: n,
    r,
    p,
    maxmem,
  });
}

/**
 * `scrypt$N$r$p$salt$key`, both binary fields base64.
 *
 * Self-describing so the parameters can move without a migration, and prefixed
 * so a future algorithm change is distinguishable rather than silently
 * mis-parsed as a corrupt scrypt hash.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(
    plain,
    salt,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    SCRYPT_KEYLEN,
  );

  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing for every malformed input, because the
 * only caller is a login path where an exception and a rejection must be
 * indistinguishable from outside.
 */
export async function verifyPassword(
  plain: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;

  const [scheme, rawN, rawR, rawP, rawSalt, rawKey] = stored.split("$");
  if (scheme !== "scrypt") return false;
  if (!rawN || !rawR || !rawP || !rawSalt || !rawKey) return false;

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  if (n < 1024 || r < 1 || p < 1) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(rawSalt, "base64");
    expected = Buffer.from(rawKey, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await deriveKey(plain, salt, n, r, p, expected.length);
  } catch {
    return false;
  }

  // Lengths are equal by construction above, but timingSafeEqual throws rather
  // than returning false on a mismatch, and this must never throw.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * A hash of a password nobody has, used to spend the same time on a login for
 * an address that does not exist as one that does.
 *
 * Without it, "no such account" returns in microseconds while a real account
 * costs a full scrypt derivation, and that difference is a reliable account
 * enumeration oracle regardless of how carefully the error message is worded.
 */
let decoyHash: Promise<string> | null = null;

export function decoyPasswordHash(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return decoyHash;
}

/* -------------------------------------------------------------- policies */

/** Minimum that is worth enforcing without becoming a memorability tax. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Length only, deliberately.
 *
 * Composition rules ("one number, one symbol") push people towards
 * `Password1!` and are not what makes a password expensive to guess. Length
 * is, and a longer minimum is the honest version of the same intent.
 */
export function passwordProblem(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (plain.length > 512) {
    // Not a security rule — an upper bound so a megabyte of input cannot turn
    // one request into an unbounded scrypt derivation.
    return "That password is too long.";
  }
  if (plain.trim().length === 0) return "Enter a password.";
  return null;
}

/**
 * Lowercased and trimmed.
 *
 * Not dot-stripped or plus-stripped: those are Gmail conventions, not email
 * ones, and applying them would merge two genuinely different addresses at
 * providers that treat them as distinct.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Structural check only.
 *
 * Deliverability is not knowable from syntax, so this rejects what cannot
 * possibly be an address and leaves the rest to the confirmation email.
 */
export function emailLooksValid(email: string): boolean {
  if (email.length < 3 || email.length > 254) return false;
  if (/\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const domain = email.slice(at + 1);
  if (domain.length < 3 || !domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.includes("..")) return false;
  return true;
}

/* ---------------------------------------------------------------- tokens */

/** 256 bits from the CSPRNG, url-safe so it can live in a cookie or a link. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What gets stored for a session or confirmation token.
 *
 * Unsalted SHA-256 is correct here and would be wrong for a password: the
 * input is 256 bits of CSPRNG output, so there is no dictionary to build and
 * nothing for a salt to defend against. What matters is that a database dump
 * contains no usable token, and a one-way function is what provides that.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* --------------------------------------------------------------- lockout */

export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

/** Milliseconds left on a lock, or 0 when the account is not locked. */
export function lockoutRemainingMs(state: LockoutState, now: Date): number {
  if (!state.lockedUntil) return 0;
  return Math.max(0, state.lockedUntil.getTime() - now.getTime());
}

/**
 * The counter after one attempt.
 *
 * A success always clears both fields; anything else lets a locked-out user
 * who then types the right password stay locked out, which reads as the
 * password being wrong.
 */
export function nextLockoutState(
  state: LockoutState,
  outcome: "success" | "failure",
  now: Date,
): LockoutState {
  if (outcome === "success") {
    return { failedLoginCount: 0, lockedUntil: null };
  }

  // An attempt made while already locked extends nothing. Otherwise a bot can
  // hold an account locked forever by failing once every few minutes, which
  // turns a defence into a denial of service against the real owner.
  if (lockoutRemainingMs(state, now) > 0) return state;

  const failedLoginCount = state.failedLoginCount + 1;
  if (failedLoginCount >= MAX_FAILED_LOGINS) {
    return {
      failedLoginCount: 0,
      lockedUntil: new Date(now.getTime() + LOCKOUT_MS),
    };
  }

  return { failedLoginCount, lockedUntil: null };
}

/* -------------------------------------------------------------- sessions */

/** Thirty days, refreshed on use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Confirmation links are short-lived; the address is either read or it isn't. */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

export interface SessionLifetime {
  expiresAt: Date;
  revokedAt: Date | null;
}

export function sessionIsLive(session: SessionLifetime, now: Date): boolean {
  if (session.revokedAt) return false;
  return session.expiresAt.getTime() > now.getTime();
}

/* ------------------------------------------------------------ operations */

export interface SignupResult {
  ok: boolean;
  user?: User;
  /** Safe to render. Never distinguishes "taken" from "available". */
  error?: string;
}

/**
 * Create an email/password account.
 *
 * A duplicate address is not reported as a duplicate. The signup form is
 * public, so an honest "that email is already registered" is a free
 * membership oracle for anyone with a list of addresses. The caller sends the
 * same confirmation-pending response either way, and the person who really
 * owns the address learns from the email which of the two happened.
 */
export async function createPasswordUser(
  rawEmail: string,
  password: string,
  name: string | null,
): Promise<SignupResult> {
  const email = normalizeEmail(rawEmail);

  if (!emailLooksValid(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Spend the hashing time anyway; returning early is measurable.
    await hashPassword(password);
    return { ok: true };
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name: name?.trim() || null },
  });

  return { ok: true, user };
}

export type LoginOutcome =
  | { status: "ok"; user: User }
  | { status: "invalid" }
  | { status: "locked"; retryAfterMs: number };

/**
 * Verify an email and password.
 *
 * "invalid" covers a missing account, a wrong password, and an account that
 * only has third-party sign-in — one message for all three, because telling
 * them apart is exactly what an attacker wants.
 */
export async function authenticateWithPassword(
  rawEmail: string,
  password: string,
  now: Date = new Date(),
): Promise<LoginOutcome> {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Same cost as a real check, so timing does not reveal the absence.
    await verifyPassword(password, await decoyPasswordHash());
    return { status: "invalid" };
  }

  const remaining = lockoutRemainingMs(user, now);
  if (remaining > 0) {
    return { status: "locked", retryAfterMs: remaining };
  }

  const ok = await verifyPassword(password, user.passwordHash);
  const next = nextLockoutState(user, ok ? "success" : "failure", now);

  if (
    next.failedLoginCount !== user.failedLoginCount ||
    next.lockedUntil?.getTime() !== user.lockedUntil?.getTime()
  ) {
    await prisma.user.update({ where: { id: user.id }, data: next });
  }

  if (!ok) return { status: "invalid" };
  return { status: "ok", user };
}

/**
 * Find or create the User behind a third-party sign-in.
 *
 * Linking by verified email is deliberate and is the one place where an email
 * address is treated as proof: Google and Apple have both confirmed the
 * address themselves, so a merchant who signed up with a password and later
 * clicks "Continue with Google" reaches their own account rather than a
 * duplicate. An *unverified* provider email is never linked, because then the
 * proof does not exist and linking would be an account takeover.
 */
export async function upsertOAuthUser(input: {
  provider: "GOOGLE" | "APPLE";
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}): Promise<{ user: User; created: boolean }> {
  const existingAccount = await prisma.oAuthAccount.findUnique({
    where: {
      provider_providerUserId: {
        provider: input.provider,
        providerUserId: input.providerUserId,
      },
    },
    include: { user: true },
  });

  if (existingAccount) return { user: existingAccount.user, created: false };

  const email = input.email ? normalizeEmail(input.email) : null;

  if (email && input.emailVerified) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      await prisma.oAuthAccount.create({
        data: {
          userId: byEmail.id,
          provider: input.provider,
          providerUserId: input.providerUserId,
          providerEmail: email,
        },
      });
      return { user: byEmail, created: false };
    }
  }

  /*
   * Apple relay addresses and hidden emails mean `email` can legitimately be
   * null, and the column is unique and non-null. A synthetic address keyed by
   * the provider subject keeps the row valid and stays stable across logins,
   * which a random one would not.
   */
  const storedEmail =
    email ??
    `${input.provider.toLowerCase()}-${input.providerUserId}@users.noreply.mymeridian.app`;

  const user = await prisma.user.create({
    data: {
      email: storedEmail,
      name: input.name?.trim() || null,
      // The provider has already proved the address it released. A synthetic
      // placeholder has not been proved by anyone and must not be marked as
      // verified just because it was created here.
      emailVerifiedAt: email && input.emailVerified ? new Date() : null,
      oauthAccounts: {
        create: {
          provider: input.provider,
          providerUserId: input.providerUserId,
          providerEmail: email,
        },
      },
    },
  });

  return { user, created: true };
}

/** Issue a session and return the raw token; only the hash is stored. */
export async function createSession(
  userId: string,
  userAgent: string | null,
  now: Date = new Date(),
): Promise<string> {
  const token = generateToken();

  await prisma.webSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: sessionExpiry(now),
      userAgent: userAgent?.slice(0, 512) ?? null,
      createdAt: now,
      lastSeenAt: now,
    },
  });

  return token;
}

/**
 * Resolve a cookie value to a User, or null.
 *
 * Also slides the expiry forward, so an active user is not logged out on a
 * fixed schedule. The write is throttled to once a day: doing it on every
 * request would turn each page load into a write against the row every one of
 * that user's requests contends on.
 */
export async function resolveSession(
  token: string | null,
  now: Date = new Date(),
): Promise<User | null> {
  const resolved = await resolvePendingSession(token, now);
  if (!resolved?.session.mfaVerifiedAt) return null;
  return resolved.user;
}

export interface ResolvedPendingSession {
  session: WebSession;
  user: User;
}

/**
 * Resolve a live primary-authentication session even before MFA succeeds.
 * Only the /mfa and /reauth routes may use this; merchant-data authorization
 * continues to call resolveSession, which rejects an unverified session.
 */
export async function resolvePendingSession(
  token: string | null,
  now: Date = new Date(),
): Promise<ResolvedPendingSession | null> {
  if (!token) return null;

  const session = await prisma.webSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || !sessionIsLive(session, now)) return null;

  const aDayOld = now.getTime() - session.lastSeenAt.getTime() > 86_400_000;
  if (aDayOld) {
    await prisma.webSession.update({
      where: { id: session.id },
      data: { lastSeenAt: now, expiresAt: sessionExpiry(now) },
    });
  }

  return { session, user: session.user };
}

/** Revoke rather than delete, so a stolen token stays known-bad. */
export async function revokeSession(
  token: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (!token) return;

  await prisma.webSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: now },
  });
}

/* ------------------------------------------------------ email confirmation */

/** Issue a confirmation token, returning the raw value for the email body. */
export async function createVerificationToken(
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const token = generateToken();

  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    },
  });

  return token;
}

/**
 * Consume a confirmation token.
 *
 * The update is conditional on the token still being unconsumed, so two
 * simultaneous clicks cannot both succeed.
 */
export async function consumeVerificationToken(
  token: string,
  now: Date = new Date(),
): Promise<User | null> {
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const claimed = await prisma.emailVerificationToken.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (claimed.count === 0) return null;

  await prisma.user.update({
    where: { id: row.userId },
    data: { emailVerifiedAt: now },
  });

  return row.user;
}

/* --------------------------------------------------------------- welcome */

/**
 * Claim the one-time welcome splash.
 *
 * True exactly once per account, ever. The claim is a conditional update
 * rather than a read-then-write so that two tabs finishing signup together
 * cannot both see it, and it is stored on the User rather than in the session
 * so a second device does not replay it.
 */
export async function claimWelcome(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = await prisma.user.updateMany({
    where: { id: userId, welcomedAt: null },
    data: { welcomedAt: now },
  });

  return claimed.count === 1;
}
