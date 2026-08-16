import type { Shop } from "@prisma/client";

/**
 * Production alias for the development-only demo store resolver.
 *
 * This module deliberately contains no database lookup and no demo store
 * identifier. Even if a future routing mistake calls it, it fails closed.
 */
export async function loadDemoShop(): Promise<Shop> {
  throw new Response("Demo authentication is unavailable in production.", {
    status: 503,
    statusText: "Not configured",
  });
}
