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

/**
 * Redirect the optional www hostname to the configured deployment origin.
 *
 * Fly terminates TLS for both hostnames, while Shopify, OAuth providers and
 * session cookies use one exact canonical origin. Keeping the redirect here
 * prevents a second public hostname from becoming a second cookie/OAuth
 * surface. Development and Shopify CLI tunnels are intentionally untouched.
 */
export function canonicalDeploymentRedirect(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Response | null {
  if (env.NODE_ENV !== "production" || env.APP_URL?.trim()) return null;

  const configured = configuredOrigin(env.SHOPIFY_APP_URL);
  if (!configured) return null;

  const canonical = new URL(configured);
  const incoming = new URL(request.url);
  if (incoming.hostname.toLowerCase() !== `www.${canonical.hostname.toLowerCase()}`) {
    return null;
  }

  incoming.protocol = canonical.protocol;
  incoming.hostname = canonical.hostname;
  incoming.port = canonical.port;
  return Response.redirect(incoming, 308);
}
