/**
 * Mandatory step-up authentication for standalone MyMeridian accounts.
 *
 * Shopify-admin requests are intentionally outside this module: Shopify
 * authenticates those requests with short-lived signed session tokens. This
 * module protects only first-party web sessions and never asks an embedded
 * merchant for another application login.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { User, WebSession } from "@prisma/client";

import prisma from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { renderAuthenticationCode } from "~/lib/email-templates.server";
import { sendEmail, mailConfiguration } from "~/lib/mail.server";
import { generateCode, normalizeCode } from "~/lib/password-reset.server";

export const MFA_CODE_TTL_MS = 10 * 60 * 1_000;
export const MFA_MAX_ATTEMPTS = 5;

export type MfaChannel = "email" | "sms";
export type MfaPurpose = "enroll_email" | "enroll_phone" | "login" | "reauth";

export type PendingWebSession = WebSession & { user: User };

export interface SmsProviderConfiguration {
  configured: boolean;
  invalid: string[];
}

/** A provider response stripped to the two values safe to surface or log. */
export class SmsVerificationProviderError extends Error {
  readonly status: number;
  readonly code: number | null;

  constructor(status: number, code: number | null) {
    super(`SMS verification provider rejected the request (${status}).`);
    this.name = "SmsVerificationProviderError";
    this.status = status;
    this.code = code;
  }
}

export function smsProviderConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): SmsProviderConfiguration {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const apiKeySid = env.TWILIO_API_KEY_SID?.trim() ?? "";
  const apiKeySecret = env.TWILIO_API_KEY_SECRET?.trim() ?? "";
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID?.trim() ?? "";
  const values = [accountSid, apiKeySid, apiKeySecret, serviceSid];
  if (values.every((value) => !value))
    return { configured: false, invalid: [] };

  const invalid: string[] = [];
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid))
    invalid.push("TWILIO_ACCOUNT_SID");
  if (!/^SK[0-9a-fA-F]{32}$/.test(apiKeySid))
    invalid.push("TWILIO_API_KEY_SID");
  if (apiKeySecret.length < 32) invalid.push("TWILIO_API_KEY_SECRET");
  if (!/^VA[0-9a-fA-F]{32}$/.test(serviceSid)) {
    invalid.push("TWILIO_VERIFY_SERVICE_SID");
  }
  return { configured: invalid.length === 0, invalid };
}

/** Conservative E.164 validation; carrier reachability is proven by the OTP. */
export function normalizePhoneNumber(raw: string): string | null {
  const compact = raw.replace(/[\s().-]/g, "");
  if (!/^\+[1-9][0-9]{7,14}$/.test(compact)) return null;
  return compact;
}

export function maskPhone(last4: string | null): string | null {
  return last4 ? `••• ••• ${last4}` : null;
}

function authKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.MERIDIAN_RATE_LIMIT_KEY?.trim();
  const decoded = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (decoded.length === 32) return decoded;
  if (env.NODE_ENV === "production") {
    throw new Error("MFA requires the production MERIDIAN_RATE_LIMIT_KEY.");
  }
  return Buffer.alloc(32, 0x4d);
}

function keyedHash(value: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", authKey(env)).update(value).digest("hex");
}

function codeMatches(
  code: string,
  stored: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const actual = Buffer.from(keyedHash(`mfa-code:${code}`, env), "hex");
  const expected = Buffer.from(stored, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function twilioEndpoint(serviceSid: string, resource: string): string {
  return `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/${resource}`;
}

async function twilioPost(
  resource: string,
  body: URLSearchParams,
  options: { env: NodeJS.ProcessEnv; fetchImpl: typeof fetch },
): Promise<Record<string, unknown>> {
  const config = smsProviderConfiguration(options.env);
  if (!config.configured) {
    throw new Error("SMS verification provider is not configured.");
  }
  const response = await options.fetchImpl(
    twilioEndpoint(options.env.TWILIO_VERIFY_SERVICE_SID!.trim(), resource),
    {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(
          `${options.env.TWILIO_API_KEY_SID!.trim()}:${options.env.TWILIO_API_KEY_SECRET!.trim()}`,
        ).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "MyMeridian/1.0 mfa",
      },
      body,
    },
  );
  const responseText = await response.text();
  let payload: unknown = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    // Twilio errors should be JSON, but never promote a provider body to logs.
  }
  if (!response.ok) {
    const code =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { code?: unknown }).code === "number"
        ? (payload as { code: number }).code
        : null;
    throw new SmsVerificationProviderError(
      response.status,
      code,
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("SMS verification provider returned an invalid response.");
  }
  return payload as Record<string, unknown>;
}

async function startSmsVerification(
  phone: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<string> {
  const payload = await twilioPost(
    "Verifications",
    new URLSearchParams({ To: phone, Channel: "sms" }),
    { env, fetchImpl },
  );
  if (typeof payload.sid !== "string" || !payload.sid.startsWith("VE")) {
    throw new Error("SMS verification provider returned no verification id.");
  }
  return payload.sid;
}

async function checkSmsVerification(
  phone: string,
  code: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const payload = await twilioPost(
    "VerificationCheck",
    new URLSearchParams({ To: phone, Code: code }),
    { env, fetchImpl },
  );
  return payload.status === "approved";
}

export interface StartChallengeInput {
  session: PendingWebSession;
  purpose: MfaPurpose;
  channel: MfaChannel;
  /** Required only while enrolling or replacing the SMS destination. */
  phone?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export async function startMfaChallenge(
  input: StartChallengeInput,
): Promise<{
  challengeId: string;
  channel: MfaChannel;
  localCode: string | null;
}> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  let destination: string;

  if (input.channel === "email") {
    destination = input.session.user.email;
  } else if (input.purpose === "enroll_phone") {
    const normalized = normalizePhoneNumber(input.phone ?? "");
    if (!normalized)
      throw new Error("Enter a phone number with its country code.");
    destination = normalized;
    await prisma.user.update({
      where: { id: input.session.userId },
      data: {
        phoneNumberEnc: encryptSecret(normalized),
        phoneLast4: normalized.slice(-4),
        phoneVerifiedAt: null,
        mfaEnrolledAt: null,
      },
    });
  } else {
    if (
      !input.session.user.phoneNumberEnc ||
      !input.session.user.phoneVerifiedAt
    ) {
      throw new Error("Verify a phone number before using SMS authentication.");
    }
    destination = decryptSecret(input.session.user.phoneNumberEnc);
  }

  await prisma.mfaChallenge.updateMany({
    where: {
      sessionId: input.session.id,
      purpose: input.purpose,
      channel: input.channel,
      consumedAt: null,
    },
    data: { consumedAt: now },
  });

  const productionSms =
    input.channel === "sms" && env.NODE_ENV === "production";
  const code = productionSms ? null : generateCode();
  const challenge = await prisma.mfaChallenge.create({
    data: {
      userId: input.session.userId,
      sessionId: input.session.id,
      purpose: input.purpose,
      channel: input.channel,
      codeHash: code ? keyedHash(`mfa-code:${code}`, env) : null,
      destinationHash: keyedHash(`mfa-destination:${destination}`, env),
      expiresAt: new Date(now.getTime() + MFA_CODE_TTL_MS),
      createdAt: now,
    },
  });

  try {
    if (input.channel === "email") {
      if (!mailConfiguration(env).configured && env.NODE_ENV !== "production") {
        console.info(`[mfa] local challenge ${challenge.id}: ${code}`);
      } else {
        const rendered = renderAuthenticationCode({ code: code!, env });
        await sendEmail(
          {
            to: destination,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            idempotencyKey: `mfa/${challenge.id}`,
          },
          { env, fetchImpl },
        );
      }
    } else if (productionSms) {
      const providerRef = await startSmsVerification(
        destination,
        env,
        fetchImpl,
      );
      await prisma.mfaChallenge.update({
        where: { id: challenge.id },
        data: { providerRef },
      });
    } else {
      console.info(`[mfa] local challenge ${challenge.id}: ${code}`);
    }
  } catch (error) {
    await prisma.mfaChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    throw error;
  }

  return {
    challengeId: challenge.id,
    channel: input.channel,
    localCode: env.NODE_ENV === "test" ? code : null,
  };
}

export type VerifyMfaResult =
  | { status: "ok" }
  | { status: "invalid" }
  | { status: "expired" };

export async function verifyMfaChallenge(input: {
  session: PendingWebSession;
  challengeId: string;
  code: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<VerifyMfaResult> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const code = normalizeCode(input.code);
  if (code.length !== 6) return { status: "invalid" };

  const challenge = await prisma.mfaChallenge.findFirst({
    where: {
      id: input.challengeId,
      sessionId: input.session.id,
      userId: input.session.userId,
    },
  });
  if (!challenge || challenge.consumedAt) return { status: "expired" };
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    await prisma.mfaChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: now },
    });
    return { status: "expired" };
  }

  const attempt = await prisma.mfaChallenge.updateMany({
    where: {
      id: challenge.id,
      consumedAt: null,
      attempts: { lt: MFA_MAX_ATTEMPTS },
    },
    data: { attempts: { increment: 1 } },
  });
  if (attempt.count !== 1) return { status: "expired" };

  let valid = false;
  if (challenge.codeHash) {
    valid = codeMatches(code, challenge.codeHash, env);
  } else if (challenge.channel === "sms") {
    if (!input.session.user.phoneNumberEnc) return { status: "invalid" };
    valid = await checkSmsVerification(
      decryptSecret(input.session.user.phoneNumberEnc),
      code,
      env,
      input.fetchImpl ?? fetch,
    );
  }
  if (!valid) return { status: "invalid" };

  const claimed = await prisma.mfaChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) return { status: "expired" };

  if (challenge.purpose === "enroll_email") {
    await prisma.user.update({
      where: { id: input.session.userId },
      data: { emailVerifiedAt: now },
    });
  } else if (challenge.purpose === "enroll_phone") {
    await prisma.user.update({
      where: { id: input.session.userId },
      data: { phoneVerifiedAt: now },
    });
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.session.userId },
    select: { emailVerifiedAt: true, phoneVerifiedAt: true },
  });
  if (user.emailVerifiedAt && user.phoneVerifiedAt) {
    await prisma.user.update({
      where: { id: input.session.userId },
      data: { mfaEnrolledAt: now },
    });
  }

  if (challenge.purpose === "login" || challenge.purpose === "reauth") {
    if (!user.emailVerifiedAt || !user.phoneVerifiedAt) {
      return { status: "invalid" };
    }
    await prisma.webSession.update({
      where: { id: input.session.id },
      data: {
        mfaVerifiedAt: now,
        reauthenticatedAt: now,
      },
    });
  }

  return { status: "ok" };
}

export async function latestMfaChallenge(
  sessionId: string,
  now = new Date(),
): Promise<{ id: string; purpose: string; channel: string } | null> {
  return prisma.mfaChallenge.findFirst({
    where: { sessionId, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true, purpose: true, channel: true },
  });
}

export async function purgeExpiredMfaChallenges(
  now = new Date(),
): Promise<number> {
  const deleted = await prisma.mfaChallenge.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return deleted.count;
}

/** Unpredictable marker for tests/runbooks that need a non-code correlation id. */
export function newMfaCorrelationId(): string {
  return randomBytes(16).toString("hex");
}
