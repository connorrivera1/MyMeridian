import { createHash } from "node:crypto";

import { addPublicDocumentSecurityHeaders } from "~/lib/http-security";

/**
 * CSP permits an intentional inline script only by the digest of its exact
 * content. Deriving those digests from the document itself prevents a future
 * landing-page edit from silently breaking the public page or broadening the
 * policy to unsafe inline JavaScript.
 */
export function inlineScriptHashes(html: string): string[] {
  return Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi),
    (match) => match[1] ?? "",
  )
    .filter((script) => script.trim().length > 0)
    .map(
      (script) =>
        `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`,
    );
}

export function addPublicDocumentSecurityHeadersForHtml(
  headers: Headers,
  html: string,
): void {
  addPublicDocumentSecurityHeaders(headers, inlineScriptHashes(html));
}
