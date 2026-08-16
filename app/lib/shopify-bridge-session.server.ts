import { createHmac, timingSafeEqual } from "node:crypto";

import { readCookie, requestIsSecure } from "~/lib/web-session.server";

const COOKIE_BASE = "mymeridian_shopify_bridge";
const TTL_SECONDS = 5 * 60;

interface BridgeSessionPayload {
  shop: string;
  sessionId: string;
  expiresAt: number;
}

function cookieName(secure: boolean): string {
  return secure ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

function signingKey(): string | null {
  const key = process.env.MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY?.trim() ?? "";
  return Buffer.byteLength(key, "utf8") >= 32 ? key : null;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function sameSignature(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * App Bridge is the normal embedded authentication mechanism. This is a very
 * short-lived, signed fallback issued only after Shopify has verified a real
 * session token. It covers a client navigation that starts before App Bridge's
 * fetch interceptor is ready; it never grants an Admin API client, survives
 * only five minutes, and is invalidated as soon as the shop is uninstalled.
 */
export function serializeShopifyBridgeSession(
  session: { shop: string; id: string },
  request: Request,
): string | null {
  const key = signingKey();
  if (!key) return null;

  const expiresAt = Date.now() + TTL_SECONDS * 1_000;
  const payload = Buffer.from(
    JSON.stringify({ shop: session.shop, sessionId: session.id, expiresAt }),
  ).toString("base64url");
  const secure = requestIsSecure(request);
  const cookie = [
    `${cookieName(secure)}=${payload}.${sign(payload, key)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    `Max-Age=${TTL_SECONDS}`,
  ];
  if (secure) cookie.push("Secure", "Partitioned");
  return cookie.join("; ");
}

/** Return only a valid, unexpired fallback identity; never a raw cookie. */
export function readShopifyBridgeSession(
  request: Request,
  now = Date.now(),
): BridgeSessionPayload | null {
  const key = signingKey();
  if (!key) return null;
  const raw =
    readCookie(request, cookieName(requestIsSecure(request))) ??
    readCookie(request, cookieName(!requestIsSecure(request)));
  if (!raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!sameSignature(signature, sign(payload, key))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof parsed?.shop !== "string" ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(parsed.shop) ||
      typeof parsed?.sessionId !== "string" ||
      parsed.sessionId.length === 0 ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= now
    ) {
      return null;
    }
    return parsed as BridgeSessionPayload;
  } catch {
    return null;
  }
}

export const SHOPIFY_BRIDGE_SESSION_TTL_SECONDS = TTL_SECONDS;
