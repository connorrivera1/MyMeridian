import type { LoaderFunctionArgs } from "react-router";

import { authenticate, hasShopifyCredentials } from "~/shopify.server";

/**
 * OAuth entry and callback. The adapter owns the whole exchange — this route
 * exists so it has a URL to own.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!hasShopifyCredentials || !authenticate) {
    throw new Response(
      "Shopify credentials are not configured. Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET.",
      { status: 503 },
    );
  }

  await authenticate.admin(request);
  return null;
}
