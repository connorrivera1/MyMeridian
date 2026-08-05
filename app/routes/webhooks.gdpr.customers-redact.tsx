import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { handleWebhook } from "~/lib/webhooks.server";

/**
 * customers/redact — mandatory GDPR webhook.
 *
 * Shopify sends this when a merchant (or the customer) requests erasure. The
 * personal data must actually go, but the orders must not: deleting them would
 * silently rewrite the merchant's historical profit. So identifiers are cleared
 * and the order rows are anonymised in place, preserving the economics while
 * removing any link back to a person.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain, payload }) => {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    const customerId = (payload.customer as { id?: number | string } | undefined)?.id;
    if (customerId === undefined) return;

    const shopifyGid = `gid://shopify/Customer/${customerId}`;

    const customer = await prisma.customer.findFirst({
      where: {
        shopId: shop.id,
        OR: [{ shopifyId: shopifyGid }, { shopifyId: String(customerId) }],
      },
    });
    if (!customer) return;

    await prisma.$transaction([
      // Detach orders but keep their financial history intact.
      prisma.order.updateMany({
        where: { customerId: customer.id },
        data: { customerId: null },
      }),
      prisma.customer.delete({ where: { id: customer.id } }),
    ]);

    console.info(
      `[gdpr] redacted customer ${customer.id} for ${shopDomain}; orders anonymised`,
    );
  });
}

// A GET here is never legitimate — webhooks are POSTs.
export const loader = () => new Response(null, { status: 405 });
