import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { handleWebhook } from "~/lib/webhooks.server";
import { syncOrderFromShopify } from "~/lib/sync.server";

/**
 * orders/create, orders/updated and refunds/create all land here.
 *
 * orders/create and orders/updated carry a whole order and are upserts of the
 * same row, so one handler covers both.
 *
 * refunds/create is a different shape entirely and must not be treated as an
 * order. Its payload is a bare Refund — `id`, `order_id`, `refund_line_items`,
 * `transactions` — with no nested `order`. Passing it to syncOrderFromShopify
 * built a whole phantom order keyed on the *refund's* id: zero revenue, zero
 * tax, no customer, channel DIRECT, no line items. Those rows are indexed on
 * processedAt like any other, so the engine charged each one a default
 * shipping, pick-pack and fixed payment fee against no revenue, and handed it
 * an equal share of monthly overhead taken from the real orders — roughly ten
 * dollars of invented loss per refund, plus an inflated order count and a
 * depressed AOV, permanently.
 *
 * The refund's actual financial effect reaches the order through
 * orders/updated, which fires on the same refund and carries the complete
 * `refunds[]` array. That is the authoritative figure, so this handler
 * deliberately does not apply the refund a second time — it would double-count
 * whenever the two webhooks arrived out of order. What it does do is drop the
 * cached analytics so the refund shows up immediately.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain, payload, topic }) => {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    if (topic === "REFUNDS_CREATE") {
      invalidateAnalyticsCache();
      return;
    }

    await syncOrderFromShopify(shop.id, payload);
    invalidateAnalyticsCache();
  });
}

export const loader = () => new Response(null, { status: 405 });
