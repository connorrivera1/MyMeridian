import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { handleWebhook } from "~/lib/webhooks.server";

/**
 * app/scopes_update.
 *
 * `grantedScopes` was written in exactly one place — the `afterAuth` hook — so
 * it recorded what a store granted at install and then never changed. A
 * merchant who later granted or revoked an optional scope left the recorded
 * set stale forever, and `capabilitiesForShop` reads it to decide which fields
 * the import may ask Shopify for. Stale in the permissive direction fails the
 * whole GraphQL query (Shopify rejects a query naming a field the app is not
 * authorised for, rather than nulling that field); stale in the restrictive
 * direction hides a screen the merchant has just paid for with an approval.
 *
 * Under Shopify managed installation this topic is how scope changes arrive
 * without a reinstall, so it is the only path that keeps the record honest.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain, payload }) => {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    const current = (payload.current ?? []) as string[] | string;
    const granted = Array.isArray(current) ? current.join(",") : String(current);

    if (granted === (shop.grantedScopes ?? "")) return;

    await prisma.shop.update({
      where: { id: shop.id },
      data: { grantedScopes: granted || null },
    });

    console.info(
      `[scopes] ${shopDomain}: granted scopes are now "${granted}" ` +
        `(was "${shop.grantedScopes ?? ""}")`,
    );
  });
}

export const loader = () => new Response(null, { status: 405 });
