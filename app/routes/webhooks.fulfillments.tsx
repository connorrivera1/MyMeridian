import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { syncFulfillmentFromShopify } from "~/lib/sync.server";
import { handleWebhook } from "~/lib/webhooks.server";

export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain, payload }) => {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    await syncFulfillmentFromShopify(shop.id, payload);
    invalidateAnalyticsCache();
  });
}

export const loader = () => new Response(null, { status: 405 });
