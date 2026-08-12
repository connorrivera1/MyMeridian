import { redirect } from "react-router";

import { resolvePendingWebSession } from "~/lib/auth.server";
import { safeReturnPath } from "~/lib/web-oauth.server";
import type { User } from "@prisma/client";

export const REAUTH_MAX_AGE_MS = 15 * 60 * 1_000;

export function reauthenticationIsFresh(
  reauthenticatedAt: Date | null,
  now = new Date(),
  maxAgeMs = REAUTH_MAX_AGE_MS,
): boolean {
  if (!reauthenticatedAt) return false;
  const age = now.getTime() - reauthenticatedAt.getTime();
  return age >= 0 && age <= maxAgeMs;
}

/**
 * Require recent standalone-account step-up without interfering with Shopify.
 * A request with no MyMeridian cookie belongs to the embedded/session-token
 * path and is left to requireShopContext's Shopify authentication.
 */
export async function requireRecentReauthentication(
  request: Request,
  webUser: User | null,
  now = new Date(),
): Promise<void> {
  if (!webUser) return;
  const pending = await resolvePendingWebSession(request);
  if (!pending || pending.user.id !== webUser.id) throw redirect("/login");

  const url = new URL(request.url);
  const returnTo = safeReturnPath(`${url.pathname}${url.search}`);
  if (!pending.session.mfaVerifiedAt) {
    throw redirect(`/mfa?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (!reauthenticationIsFresh(pending.session.reauthenticatedAt, now)) {
    throw redirect(`/reauth?returnTo=${encodeURIComponent(returnTo)}`);
  }
}
