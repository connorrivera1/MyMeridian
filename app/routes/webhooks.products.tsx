import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { syncProductFromShopify, variantGidsIn } from "~/lib/sync.server";
import { backfillVariantCosts } from "~/lib/variant-cost.server";
import { handleWebhook } from "~/lib/webhooks.server";

export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain, payload }) => {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    await syncProductFromShopify(shop.id, payload);

    // The payload has price and inventory but never cost — that lives on the
    // InventoryItem. Without this follow-up a SKU created after install shows a
    // 100% margin and tops the most-profitable list until someone re-imports.
    const filled = await backfillVariantCosts(
      shop.id,
      shopDomain,
      variantGidsIn(payload),
    );

    if (filled) {
      console.info(
        `[products] ${shopDomain}: read unit cost for ${filled} new variant(s)`,
      );
    }

    invalidateAnalyticsCache();
  });
}

export const loader = () => new Response(null, { status: 405 });
