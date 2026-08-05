import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { handleWebhook } from "~/lib/webhooks.server";

/**
 * shop/redact — mandatory GDPR webhook.
 *
 * Sent 48 hours after uninstall. Everything belonging to the shop goes: the
 * schema cascades from Shop, so a single delete removes orders, customers,
 * products, spend and connector tokens together.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain }) => {
    await prisma.session.deleteMany({ where: { shop: shopDomain } });

    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    await prisma.shop.delete({ where: { id: shop.id } });

    console.info(`[gdpr] purged all data for ${shopDomain}`);
  });
}

export const loader = () => new Response(null, { status: 405 });
