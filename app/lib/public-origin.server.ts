function configuredOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * Return the merchant-facing origin, not the app server's internal proxy URL.
 * Shopify CLI supplies APP_URL for its HTTPS tunnel, while production uses the
 * stable SHOPIFY_APP_URL deployment setting. Absolute OAuth and billing
 * callbacks must use that public origin or Shopify/provider redirects fall
 * back to the proxy's plain-http connection.
 */
export function publicAppOrigin(request: Request): string {
  return (
    configuredOrigin(process.env.APP_URL) ??
    configuredOrigin(process.env.SHOPIFY_APP_URL) ??
    new URL(request.url).origin
  );
}
