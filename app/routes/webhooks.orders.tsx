import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { handleWebhook } from "~/lib/webhooks.server";
import { syncOrderFromShopify } from "~/lib/sync.server";

/**
 * orders/create, orders/updated and refunds/create all land here.
 *
 * Each is an upsert of the same order, so one handler covers all three and a
 * refund arriving before an update cannot resurrect stale figures.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain, payload, topic }) => {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    // refunds/create sends the refund, with the order nested inside it.
    const orderPayload =
      topic === "REFUNDS_CREATE"
        ? ((payload.order ?? payload) as Record<string, unknown>)
        : payload;

    await syncOrderFromShopify(shop.id, orderPayload);
    invalidateAnalyticsCache();
  });
}

export const loader = () => new Response(null, { status: 405 });
