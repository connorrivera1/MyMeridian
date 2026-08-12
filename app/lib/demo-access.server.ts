import prisma from "~/db.server";

export const DEMO_SHOP_DOMAIN = "meridian-demo.myshopify.com";

/**
 * Development-only seeded-store lookup.
 *
 * Production builds alias this import to `demo-access.production.server.ts`.
 * The production-bundle verifier rejects the build if this domain or the
 * seeded-data error survives bundling, so the authentication bypass is not
 * merely disabled at runtime: its implementation is absent from the shipped
 * server.
 */
export async function loadDemoShop() {
  const shop = await prisma.shop.findUnique({
    where: { domain: DEMO_SHOP_DOMAIN },
  });
  if (!shop) {
    throw new Response(
      "Demo store has not been seeded yet. Run `npm run db:seed`.",
      { status: 503, statusText: "No demo data" },
    );
  }
  return shop;
}
