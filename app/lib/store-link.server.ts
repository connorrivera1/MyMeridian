/**
 * Binding a web account to a Shopify store.
 *
 * The membership that lets a web session read a store's numbers is written in
 * exactly one situation: a signed-in web user is on a request that Shopify
 * itself just authenticated for that same store. Both halves are required.
 *
 * The cookie written here carries only *which store the user was trying to
 * connect*. It is not a credential and does not need to be signed, because it
 * grants nothing on its own — the grant is gated on `authenticate.admin`
 * having succeeded for that exact domain in the same request. Forging the
 * cookie to name someone else's store just means the forger must then
 * authenticate as that store, which is the thing they cannot do.
 */

import { grantMembership } from "./shop-access.server";
import { readCookie } from "./web-session.server";

const PENDING_COOKIE = "mymeridian_pending_store";

/** Shopify domains only. Anything else is not a store we can install on. */
export function normalizeShopDomain(raw: string): string | null {
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  if (!trimmed) return null;

  const candidate = trimmed.includes(".")
    ? trimmed
    : `${trimmed}.myshopify.com`;

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(candidate)) return null;
  return candidate;
}

export function serializePendingStoreCookie(
  domain: string,
  secure: boolean,
): string {
  const parts = [
    `${PENDING_COOKIE}=${encodeURIComponent(domain)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    // Ten minutes: long enough to walk through Shopify's install screens,
    // short enough that a forgotten one does not linger.
    "Max-Age=600",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearPendingStoreCookie(secure: boolean): string {
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

export function readPendingStore(request: Request): string | null {
  return readCookie(request, PENDING_COOKIE);
}

/**
 * Complete a pending link, if this request is the one that completes it.
 *
 * Called from the embedded app's layout loader, where `authenticatedDomain`
 * came from `authenticate.admin` rather than from any user input. Returns true
 * when a membership was written, so the caller knows to clear the cookie.
 */
export async function completePendingLink(
  request: Request,
  userId: string | null,
  authenticatedDomain: string,
  shopId: string,
): Promise<boolean> {
  if (!userId) return false;

  const pending = readPendingStore(request);
  if (!pending) return false;

  // The cookie must name the store Shopify just authenticated. A mismatch is
  // a stale cookie from an abandoned attempt, not something to act on.
  if (pending !== authenticatedDomain) return false;

  await grantMembership(userId, shopId);
  return true;
}
