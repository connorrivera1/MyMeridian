/**
 * Security headers that are safe for every public MyMeridian document.
 *
 * Shopify owns the embedded app's CSP/frame-ancestor policy, so it remains
 * route-specific. These transport and browser-safety headers do not conflict
 * with that policy and are also applied to static resource routes that bypass
 * React Router's document renderer.
 */
export function addSecurityHeaders(headers: Headers): void {
  headers.set("Strict-Transport-Security", "max-age=31536000");

  // A route may need a stricter policy, such as the operator surface's
  // no-referrer setting. Preserve that explicit route-level decision.
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("Referrer-Policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
}

/**
 * Adds the strict document policy for MyMeridian's public, non-embedded
 * pages. The Shopify app has its own frame-ancestor policy, so this must not
 * be applied globally to React Router documents.
 *
 * Each caller supplies hashes for the document's intentionally inlined
 * scripts. This keeps the early theme paint and landing motion working
 * without reopening the page to arbitrary inline JavaScript.
 */
export function addPublicDocumentSecurityHeaders(
  headers: Headers,
  inlineScriptHashes: readonly string[] = [],
): void {
  addSecurityHeaders(headers);

  const scriptSources = ["'self'", ...inlineScriptHashes].join(" ");
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "img-src 'self' data:",
      "font-src 'self' data: https://cdn.fontshare.com",
      "style-src 'self' 'unsafe-inline' https://api.fontshare.com",
      `script-src ${scriptSources}`,
      "connect-src 'self'",
      "media-src 'self'",
      "upgrade-insecure-requests",
    ].join("; "),
  );
}

/**
 * Resource and document routes normally receive the standard headers from the
 * server entrypoint. Redirect responses bypass that renderer, so attach the
 * same transport and browser-safety controls before returning one.
 */
export function redirectWithSecurityHeaders(
  location: string,
  init: number | ResponseInit = 302,
): Response {
  const responseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  addSecurityHeaders(headers);
  return redirect(location, { ...responseInit, headers });
}
import { redirect } from "react-router";
