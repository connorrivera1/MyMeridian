/**
 * Forgotten-password recovery by one-time code.
 *
 * A code emailed to the address on the account, rather than a magic link. The
 * practical difference is that a code can be typed into the tab the person is
 * already standing in, so the reset finishes in the session that started it —
 * a link opened in a webmail client's in-app browser lands somewhere else
 * entirely and loses that context.
 *
 * Two properties matter more than anything else here, and both are easy to
 * lose by accident:
 *
 *  1. Asking for a reset must not reveal whether an account exists. The screen,
 *     the status and the timing are identical either way, and the address shown
 *     back to the person is the one *they typed*, never one looked up.
 *
 *  2. Completing a reset must end every other session. Otherwise the attacker
 *     whose access prompted the reset simply keeps the session they already
 *     had, and the victim believes they have just locked them out.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { User } from "@prisma/client";

import prisma from "~/db.server";
import { CODE_LENGTH } from "./password-reset";
import { readCookie } from "./web-session.server";
import { hashPassword, normalizeEmail, passwordProblem } from "./webauth.server";

/**
 * Re-exported so server callers have one import, while the length itself lives
 * in the client-safe module the code field renders from.
 */
export { CODE_LENGTH };

/** Long enough to find the mail, short enough that a leaked code goes stale. */
export const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Wrong guesses before the code dies.
 *
 * A million values falls in seconds to an endpoint that answers forever, so
 * the limit — not the length — is what actually makes six digits safe.
 */
export const MAX_CODE_ATTEMPTS = 5;

/**
 * A uniform six-digit code.
 *
 * Rejection sampling rather than `% 1000000`. Three bytes give 16,777,216
 * values, which is not a multiple of a million, so the plain modulo would make
 * the first 777,216 codes measurably likelier than the rest — a bias that
 * shrinks the search space for anyone willing to guess in the right order.
 */
export function generateCode(): string {
  const ceiling = 16_777_216;
  const limit = Math.floor(ceiling / 1_000_000) * 1_000_000;

  for (;;) {
    const value = randomBytes(3).readUIntBE(0, 3);
    if (value < limit) {
      return String(value % 1_000_000).padStart(CODE_LENGTH, "0");
    }
  }
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Constant-time compare, so a near-miss is not measurably nearer. */
export function codeMatches(supplied: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(supplied), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `*****@gmail.com`.
 *
 * A fixed five asterisks regardless of the real length: a mask that tracked
 * the local part would hand back its length, which is a meaningful hint when
 * someone is guessing at an address they already half know.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "*****";
  return `*****${email.slice(at)}`;
}

/** Digits only, so a pasted "123 456" or "123-456" still works. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, "");
}

export interface IssuedCode {
  /** Null when no account matched — the caller must not behave differently. */
  code: string | null;
  user: User | null;
}

/**
 * Issue a code for an address, if it belongs to an account.
 *
 * Returns nulls for an unknown address, and the caller renders exactly the
 * same screen either way. Any previous unconsumed code for the user is
 * consumed first, so requesting a second one silently invalidates the first
 * rather than leaving two valid codes alive.
 */
export async function issueResetCode(
  rawEmail: string,
  now: Date = new Date(),
): Promise<IssuedCode> {
  const email = normalizeEmail(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) return { code: null, user: null };

  await prisma.passwordResetCode.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: now },
  });

  const code = generateCode();
  await prisma.passwordResetCode.create({
    data: {
      userId: user.id,
      codeHash: hashCode(code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      createdAt: now,
    },
  });

  return { code, user };
}

export type ResetOutcome =
  | { status: "ok" }
  | { status: "invalid-code" }
  | { status: "no-code" }
  | { status: "weak-password"; error: string };

/**
 * Verify a code and set the new password.
 *
 * Both halves happen together on purpose. Verifying the code in one request
 * and accepting a password in the next would need something to carry "this
 * browser proved the code" across the gap, and that something is a second
 * credential to get wrong.
 */
export async function resetPasswordWithCode(
  rawEmail: string,
  suppliedCode: string,
  newPassword: string,
  now: Date = new Date(),
): Promise<ResetOutcome> {
  const email = normalizeEmail(rawEmail);
  const code = normalizeCode(suppliedCode);

  // Checked before touching the code so a weak password does not burn one of
  // the five attempts — the code was right, the password was the problem.
  const problem = passwordProblem(newPassword);
  if (problem) return { status: "weak-password", error: problem };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return { status: "invalid-code" };

  /*
   * Scoped to this user, never a global search by code. A lookup keyed on the
   * hash alone would let someone submit six digits and reset whichever account
   * happened to hold them.
   */
  const record = await prisma.passwordResetCode.findFirst({
    where: { userId: user.id, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) return { status: "no-code" };

  if (record.expiresAt.getTime() <= now.getTime()) {
    await prisma.passwordResetCode.update({
      where: { id: record.id },
      data: { consumedAt: now },
    });
    return { status: "no-code" };
  }

  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    await prisma.passwordResetCode.update({
      where: { id: record.id },
      data: { consumedAt: now },
    });
    return { status: "no-code" };
  }

  if (!codeMatches(code, record.codeHash)) {
    await prisma.passwordResetCode.update({
      where: { id: record.id },
      data: { attempts: record.attempts + 1 },
    });
    return { status: "invalid-code" };
  }

  // Claim the code before spending it, so two submissions cannot both win.
  const claimed = await prisma.passwordResetCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (claimed.count === 0) return { status: "invalid-code" };

  const passwordHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      /*
       * Someone who just proved control of the mailbox should not still be
       * serving a lockout from the failed guesses that sent them here.
       */
      failedLoginCount: 0,
      lockedUntil: null,
      /*
       * Receiving the code is itself proof the address works, which is the
       * only thing the confirmation email was ever going to establish.
       */
      emailVerifiedAt: user.emailVerifiedAt ?? now,
    },
  });

  /*
   * Every existing session goes, including the one that did the reset.
   *
   * This is the point of the whole flow. A reset that left other sessions
   * alive would leave the intruder exactly where they were, while telling the
   * owner they had just removed them.
   */
  await prisma.webSession.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: now },
  });

  return { status: "ok" };
}

/* ----------------------------------------------------------- flow cookie */

const PENDING_COOKIE = "mymeridian_reset_to";

/**
 * Carries the requested address from the email step to the code step.
 *
 * In a cookie rather than a hidden form field so the address cannot be swapped
 * between the two screens. That is not what protects the account — the code
 * still has to arrive in the right mailbox — but it keeps the address shown on
 * screen the one the code was actually sent to, instead of whatever was last
 * posted.
 */
export function serializeResetCookie(email: string, secure: boolean): string {
  const parts = [
    `${PENDING_COOKIE}=${encodeURIComponent(email)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    // Outlives the code itself by a little, so an expired code says so rather
    // than silently dropping the person back to the first screen.
    "Max-Age=1200",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearResetCookie(secure: boolean): string {
  const parts = [
    `${PENDING_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readPendingResetEmail(request: Request): string | null {
  return readCookie(request, PENDING_COOKIE);
}

/**
 * Hand the code to whatever can actually deliver it.
 *
 * There is no mail transport configured yet, so outside production the code is
 * written to the server log — that is what makes the flow walkable today. The
 * production branch deliberately does nothing rather than logging: a reset code
 * in a log file is a credential in a log file, and log files get shipped to
 * places the mailbox owner never agreed to.
 */
export async function deliverResetCode(
  email: string,
  code: string,
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    // TODO(email): send through the transport once the mail domain is live.
    return;
  }

  console.info(`[password-reset] code for ${email}: ${code}`);
}
