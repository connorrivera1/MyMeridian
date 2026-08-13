import crypto from "node:crypto";

import {
  FoundingMerchantEntitlementStatus,
  Prisma,
  WaitlistEmailStatus,
} from "@prisma/client";

import prisma from "~/db.server";
import { renderWaitlistWelcome } from "~/lib/email-templates.server";
import { mailConfiguration, sendEmail } from "~/lib/mail.server";
import { emailLooksValid, normalizeEmail } from "~/lib/webauth.server";

const MAX_TRACKING_LENGTH = 120;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60 * 1_000;
const RETRY_BASE_MS = 60 * 1_000;
const RESERVATION_MS = 24 * 60 * 60 * 1_000;
const POLL_MS = 60 * 1_000;
const UNSUBSCRIBE_PURPOSE = "mymeridian-waitlist-unsubscribe-v1";

export type WaitlistTracking = {
  source?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
};

export type WaitlistSubmission = WaitlistTracking & {
  email: string;
  storeUrl?: string | null;
  marketingConsent?: boolean;
};

export type NormalizedWaitlistSubmission = {
  email: string;
  storeUrl: string | null;
  marketingConsent: boolean;
} & Required<WaitlistTracking>;

function boundedTracking(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/[\u0000-\u001f\u007f]/g, "") ?? "";
  return normalized ? normalized.slice(0, MAX_TRACKING_LENGTH) : null;
}

/**
 * Retain only a store origin, not an admin path, campaign query, credentials
 * or fragment. A custom storefront domain is valid too, so this is structural
 * validation rather than an unreliable claim to detect Shopify hosting.
 */
export function normalizeStoreUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return null;
    if (url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function validateWaitlistSubmission(
  input: WaitlistSubmission,
): { ok: true; value: NormalizedWaitlistSubmission } | { ok: false; error: string } {
  const email = normalizeEmail(input.email);
  if (!emailLooksValid(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const suppliedStoreUrl = input.storeUrl?.trim() ?? "";
  const storeUrl = normalizeStoreUrl(suppliedStoreUrl);
  if (suppliedStoreUrl && !storeUrl) {
    return {
      ok: false,
      error: "Enter a valid HTTPS Shopify store URL, or leave it blank.",
    };
  }

  return {
    ok: true,
    value: {
      email,
      storeUrl,
      marketingConsent: input.marketingConsent === true,
      source: boundedTracking(input.source),
      utmSource: boundedTracking(input.utmSource),
      utmMedium: boundedTracking(input.utmMedium),
      utmCampaign: boundedTracking(input.utmCampaign),
      utmTerm: boundedTracking(input.utmTerm),
      utmContent: boundedTracking(input.utmContent),
    },
  };
}

function unsubscribeKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.MERIDIAN_WAITLIST_UNSUBSCRIBE_KEY?.trim();
  if (!raw || raw === "replace_me") {
    throw new Error("MERIDIAN_WAITLIST_UNSUBSCRIBE_KEY is not configured.");
  }
  return Buffer.from(raw, "utf8");
}

function unsubscribeSignature(id: string, env?: NodeJS.ProcessEnv): string {
  return crypto
    .createHmac("sha256", unsubscribeKey(env))
    .update(`${UNSUBSCRIBE_PURPOSE}:${id}`)
    .digest("base64url");
}

/** Recipient-specific, signed link for a future consent-based newsletter. */
export function waitlistUnsubscribeToken(
  signupId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${Buffer.from(signupId, "utf8").toString("base64url")}.${unsubscribeSignature(signupId, env)}`;
}

export function verifyWaitlistUnsubscribeToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const [encodedId, signature, ...extra] = token.split(".");
  if (!encodedId || !signature || extra.length) return null;
  let id: string;
  try {
    id = Buffer.from(encodedId, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!id || id.length > 128) return null;
  let expected: string;
  try {
    expected = unsubscribeSignature(id, env);
  } catch {
    return null;
  }
  const supplied = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    supplied.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(supplied, expectedBytes)
  ) {
    return null;
  }
  return id;
}

export async function unsubscribeWaitlistMarketing(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const signupId = verifyWaitlistUnsubscribeToken(token, env);
  if (!signupId) return false;
  await prisma.waitlistSignup.updateMany({
    where: { id: signupId },
    data: {
      marketingConsent: false,
      marketingUnsubscribedAt: new Date(),
    },
  });
  // Do not use this return value as an address/membership oracle. A valid
  // token always renders the same confirmation whether it was already used.
  return true;
}

function uniqueConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError ||
      (typeof error === "object" && error !== null && "code" in error)) &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Creates the contact, email receipt and server-side benefit together. A
 * duplicate returns the same public success state without modifying consent,
 * source data or sending a second email — an address must never be mutable by
 * someone who merely typed it into a public form.
 */
export async function createWaitlistSignup(
  input: NormalizedWaitlistSubmission,
): Promise<{ created: boolean }> {
  try {
    await prisma.$transaction(async (tx) => {
      const signup = await tx.waitlistSignup.create({
        data: {
          email: input.email,
          storeUrl: input.storeUrl,
          source: input.source,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          utmTerm: input.utmTerm,
          utmContent: input.utmContent,
          marketingConsent: input.marketingConsent,
          marketingConsentAt: input.marketingConsent ? new Date() : null,
        },
      });
      await tx.foundingMerchantEntitlement.create({
        data: { signupId: signup.id },
      });
      await tx.waitlistEmailDelivery.create({
        data: {
          signupId: signup.id,
          dedupeKey: `waitlist-welcome:${signup.id}`,
        },
      });
    });
    return { created: true };
  } catch (error) {
    if (uniqueConflict(error)) return { created: false };
    throw error;
  }
}

async function leaseWaitlistEmail(now = new Date()) {
  for (let contention = 0; contention < 8; contention += 1) {
    const candidate = await prisma.waitlistEmailDelivery.findFirst({
      where: {
        status: { in: [WaitlistEmailStatus.PENDING, WaitlistEmailStatus.SENDING] },
        availableAt: { lte: now },
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      include: { signup: { select: { email: true } } },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    });
    if (!candidate) return null;

    const leaseToken = crypto.randomUUID();
    const claimed = await prisma.waitlistEmailDelivery.updateMany({
      where: {
        id: candidate.id,
        status: { in: [WaitlistEmailStatus.PENDING, WaitlistEmailStatus.SENDING] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        status: WaitlistEmailStatus.SENDING,
        attempts: { increment: 1 },
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      },
    });
    if (claimed.count === 1) return { ...candidate, leaseToken };
  }
  return null;
}

/** One leased welcome delivery. Exported for controlled retry verification. */
export async function deliverOneWaitlistEmail(
  now = new Date(),
): Promise<boolean> {
  // Keep a pending receipt when Resend is not configured. Calling the provider
  // with empty credentials would create false failures and burn retry attempts.
  if (!mailConfiguration().configured) return false;

  const delivery = await leaseWaitlistEmail(now);
  if (!delivery) return false;

  try {
    const rendered = renderWaitlistWelcome();
    const provider = await sendEmail({
      to: delivery.signup.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      idempotencyKey: delivery.dedupeKey,
    });
    await prisma.waitlistEmailDelivery.updateMany({
      where: { id: delivery.id, leaseToken: delivery.leaseToken },
      data: {
        status: WaitlistEmailStatus.SENT,
        providerId: provider.id,
        sentAt: now,
        error: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 1_000) : "Unknown delivery error";
    const terminal = delivery.attempts + 1 >= MAX_ATTEMPTS;
    await prisma.waitlistEmailDelivery.updateMany({
      where: { id: delivery.id, leaseToken: delivery.leaseToken },
      data: {
        status: terminal ? WaitlistEmailStatus.FAILED : WaitlistEmailStatus.PENDING,
        availableAt: new Date(
          now.getTime() + RETRY_BASE_MS * 2 ** delivery.attempts,
        ),
        error: message,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  }
  return true;
}

export async function sweepWaitlistEmails(): Promise<void> {
  for (let sent = 0; sent < 20 && (await deliverOneWaitlistEmail()); sent += 1) {
    // A bounded drain prevents email retries from monopolizing the web process.
  }
}

interface WaitlistEmailState {
  timer?: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __meridianWaitlistEmails: WaitlistEmailState | undefined;
}

const emailState = (globalThis.__meridianWaitlistEmails ??= {});

function beginWaitlistEmailSweep(): void {
  if (emailState.inFlight) return;
  const work = sweepWaitlistEmails()
    .catch((error) => console.error("[waitlist-email] sweep failed", error))
    .finally(() => {
      if (emailState.inFlight === work) emailState.inFlight = undefined;
    });
  emailState.inFlight = work;
}

export function startWaitlistEmailScheduler(intervalMs = POLL_MS): void {
  if (emailState.timer) return;
  beginWaitlistEmailSweep();
  emailState.timer = setInterval(beginWaitlistEmailSweep, intervalMs);
  emailState.timer.unref?.();
}

export function stopWaitlistEmailScheduler(): void {
  if (emailState.timer) clearInterval(emailState.timer);
  emailState.timer = undefined;
}

/**
 * Looks up an eligible benefit through a verified owner account. This is the
 * bridge from a public waitlist email to a store: neither a public code nor a
 * user-controlled shop domain can redeem it.
 */
export async function findFoundingMerchantEntitlementForShop(
  shopId: string,
  now = new Date(),
) {
  const owners = await prisma.shopMembership.findMany({
    where: {
      shopId,
      role: "OWNER",
      user: { emailVerifiedAt: { not: null } },
    },
    select: { user: { select: { email: true } } },
  });
  const emails = owners.map((owner) => owner.user.email);
  if (!emails.length) return null;

  return prisma.foundingMerchantEntitlement.findFirst({
    where: {
      signup: { email: { in: emails } },
      OR: [
        { status: FoundingMerchantEntitlementStatus.ELIGIBLE },
        {
          status: FoundingMerchantEntitlementStatus.RESERVED,
          redeemShopId: shopId,
        },
        {
          status: FoundingMerchantEntitlementStatus.RESERVED,
          reservationExpiresAt: { lte: now },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Reserve an email-bound offer while Shopify asks the merchant to approve it. */
export async function reserveFoundingMerchantEntitlement(
  shopId: string,
  now = new Date(),
): Promise<{ id: string; discountPercentage: number; durationIntervals: number } | null> {
  const entitlement = await findFoundingMerchantEntitlementForShop(shopId, now);
  if (!entitlement) return null;

  const reservable = await prisma.foundingMerchantEntitlement.updateMany({
    where: {
      id: entitlement.id,
      OR: [
        { status: FoundingMerchantEntitlementStatus.ELIGIBLE },
        {
          status: FoundingMerchantEntitlementStatus.RESERVED,
          redeemShopId: shopId,
        },
        {
          status: FoundingMerchantEntitlementStatus.RESERVED,
          reservationExpiresAt: { lte: now },
        },
      ],
    },
    data: {
      status: FoundingMerchantEntitlementStatus.RESERVED,
      redeemShopId: shopId,
      reservedAt: now,
      reservationExpiresAt: new Date(now.getTime() + RESERVATION_MS),
    },
  });
  if (reservable.count !== 1) return null;
  return {
    id: entitlement.id,
    discountPercentage: entitlement.discountPercentage,
    durationIntervals: entitlement.durationIntervals,
  };
}

/** Called only after Shopify's subscription webhook confirms a founding plan. */
export async function redeemFoundingMerchantEntitlement(input: {
  shopId: string;
  billingKey: string;
  subscriptionId?: string | null;
  now?: Date;
}): Promise<boolean> {
  const updated = await prisma.foundingMerchantEntitlement.updateMany({
    where: {
      redeemShopId: input.shopId,
      status: FoundingMerchantEntitlementStatus.RESERVED,
    },
    data: {
      status: FoundingMerchantEntitlementStatus.REDEEMED,
      redeemedAt: input.now ?? new Date(),
      redeemedBillingKey: input.billingKey,
      redeemedSubscriptionId: input.subscriptionId ?? null,
      reservationExpiresAt: null,
    },
  });
  return updated.count === 1;
}

export async function purgeOldWaitlistEmailDeliveries(
  now = new Date(),
  retentionDays = 90,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const deleted = await prisma.waitlistEmailDelivery.deleteMany({
    where: {
      status: { in: [WaitlistEmailStatus.SENT, WaitlistEmailStatus.FAILED] },
      createdAt: { lt: cutoff },
    },
  });
  return deleted.count;
}
