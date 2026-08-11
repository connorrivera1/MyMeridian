/**
 * The session cookie for the web dashboard.
 *
 * Kept apart from `webauth.server.ts` so that the token lifecycle and the
 * transport are separately testable: everything here is string handling with
 * no database and no crypto.
 *
 * This cookie is deliberately absent from the embedded app. Shopify renders
 * that inside an admin iframe, where a SameSite=Lax cookie is not sent at all
 * — which is the correct outcome rather than a limitation. The embedded app
 * already has a stronger proof of identity in Shopify's session token, and a
 * cookie that *did* cross into a third-party frame would be usable by it.
 */

const COOKIE_BASE = "mymeridian_session";

/**
 * `__Host-` binds the cookie to exactly this origin: no Domain attribute, so
 * a subdomain cannot set or read it, and Path=/ enforced by the browser. It
 * requires Secure, which is unavailable over plain http, so local development
 * falls back to the unprefixed name.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

/**
 * Is this request on a secure origin?
 *
 * Behind Fly's proxy the connection to node is plain http, so the protocol on
 * the URL is not the answer — `x-forwarded-proto` is. Trusting that header is
 * only safe because nothing but the platform proxy can reach the process.
 */
export function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  // Proxies append rather than replace, so the client-facing scheme is the
  // first entry, not the last.
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first === "https";
  return new URL(request.url).protocol === "https:";
}

/** Read one cookie out of a request's Cookie header. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;

    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed value is not a session; treat it as absent rather than
      // throwing a 500 out of every route that reads it.
      return null;
    }
  }

  return null;
}

/** The session token on this request, under whichever name applies. */
export function readSessionToken(request: Request): string | null {
  const secure = requestIsSecure(request);
  // Check the name this origin should be using first, then the other, so a
  // developer moving between http and https is not silently logged out.
  return (
    readCookie(request, sessionCookieName(secure)) ??
    readCookie(request, sessionCookieName(!secure))
  );
}

export function serializeSessionCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${sessionCookieName(secure)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict: Strict would drop the cookie on the redirect
    // back from Google or Apple, so a completed sign-in would land logged out.
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Expire both possible names, so logout works across an http/https move.
 *
 * The `__Host-` variant always carries Secure regardless of the current
 * request: without it the browser rejects the whole Set-Cookie as invalid for
 * that prefix, and the cookie being cleared would simply survive.
 */
export function serializeSessionClearCookies(): string[] {
  return [true, false].map((hostPrefixed) =>
    [
      `${sessionCookieName(hostPrefixed)}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
      ...(hostPrefixed ? ["Secure"] : []),
    ].join("; "),
  );
}

/* ----------------------------------------------------------------- CSRF */

/**
 * Reject a state-changing request that did not come from our own pages.
 *
 * SameSite=Lax already stops a cross-site POST from carrying the cookie, so
 * this is the second layer rather than the only one. It matters because Lax
 * is a browser behaviour: an older or non-conforming client that sends the
 * cookie anyway still gets stopped here.
 *
 * Absent Origin *and* Referer is treated as a failure. A browser sends Origin
 * on every POST, so the only things that omit both are not browsers.
 */
export function requestOriginIsSelf(request: Request): boolean {
  const self = new URL(request.url).host;

  const origin = request.headers.get("origin");
  if (origin) {
    if (origin === "null") return false;
    try {
      return new URL(origin).host === self;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).host === self;
    } catch {
      return false;
    }
  }

  return false;
}
