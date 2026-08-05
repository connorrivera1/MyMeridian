import type { Shop } from "@prisma/client";

import prisma from "~/db.server";
import { authenticate, hasShopifyCredentials } from "~/shopify.server";

export const DEMO_SHOP_DOMAIN = "meridian-demo.myshopify.com";

const demoModeRequested = process.env.MERIDIAN_DEMO_MODE === "true";

// A demo bypass that could ever be reachable in production would be an
// authentication hole, not a convenience. Fail at boot rather than serve it.
if (demoModeRequested && process.env.NODE_ENV === "production") {
  throw new Error(
    "MERIDIAN_DEMO_MODE must not be enabled when NODE_ENV=production. " +
      "It bypasses Shopify session authentication.",
  );
}

export const demoAvailable =
  demoModeRequested && process.env.NODE_ENV !== "production";

type AdminClient = Awaited<
  ReturnType<NonNullable<typeof authenticate>["admin"]>
>["admin"];

export interface ShopContext {
  shop: Shop;
  /** Null in demo mode — there is no Shopify Admin API without a session. */
  admin: AdminClient | null;
  session: { shop: string; id: string } | null;
  isDemo: boolean;
}

/**
 * Does this request come from Shopify?
 *
 * Shopify always opens an embedded app with `shop` and `host` in the query
 * string, and App Bridge attaches a session token as a bearer header on every
 * subsequent data request. Any of those means "this is a real merchant" and the
 * request must go through real authentication, never the demo.
 */
function looksLikeShopifyRequest(request: Request): boolean {
  const url = new URL(request.url);

  for (const key of ["shop", "host", "embedded", "id_token", "session"]) {
    if (url.searchParams.has(key)) return true;
  }

  return request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
}

/**
 * The single authentication entry point for every dashboard route.
 *
 * Real Shopify authentication is the primary path: whenever the app has
 * credentials and the request carries any Shopify signal, `authenticate.admin`
 * verifies the session token and redirects into OAuth when it is missing or
 * stale. The seeded demo is only ever reached by a genuinely unauthenticated
 * visitor, on a non-production build, with demo mode explicitly enabled.
 */
export async function requireShopContext(request: Request): Promise<ShopContext> {
  const shopifyRequest = looksLikeShopifyRequest(request);

  if (hasShopifyCredentials && authenticate && (shopifyRequest || !demoAvailable)) {
    const { session, admin } = await authenticate.admin(request);

    const { ensureShopProvisioned } = await import("./provision.server");
    const shop = await ensureShopProvisioned(session.shop);

    return { shop, admin, session, isDemo: false };
  }

  if (!demoAvailable) {
    throw new Response(
      "Meridian is not configured. Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET " +
        "to install on a store, or run with MERIDIAN_DEMO_MODE=true outside " +
        "production to explore the seeded demo.",
      { status: 503, statusText: "Not configured" },
    );
  }

  const shop = await prisma.shop.findUnique({ where: { domain: DEMO_SHOP_DOMAIN } });
  if (!shop) {
    throw new Response(
      "Demo store has not been seeded yet. Run `npm run db:seed`.",
      { status: 503, statusText: "No demo data" },
    );
  }

  return { shop, admin: null, session: null, isDemo: true };
}
