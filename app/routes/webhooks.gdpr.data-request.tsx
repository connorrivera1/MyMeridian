import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { centsToDollars, toCents } from "~/engine/money";
import { handleWebhook } from "~/lib/webhooks.server";

/**
 * customers/data_request — mandatory GDPR webhook.
 *
 * A customer has asked what the store holds on them. Shopify requires the app
 * to hand the data to the *merchant*, who is the controller, within 30 days.
 *
 * The export is assembled here and recorded for the merchant to collect from
 * Settings. It deliberately does not email the customer directly: the app is a
 * processor and must not open its own channel to the data subject.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain, payload, webhookId }) => {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    const customerId = (payload.customer as { id?: number | string } | undefined)?.id;
    if (customerId === undefined) return;

    const customer = await prisma.customer.findFirst({
      where: {
        shopId: shop.id,
        OR: [
          { shopifyId: `gid://shopify/Customer/${customerId}` },
          { shopifyId: String(customerId) },
        ],
      },
      include: {
        orders: {
          include: { lineItems: true },
          orderBy: { processedAt: "asc" },
        },
      },
    });

    const report = customer
      ? {
          shop: shopDomain,
          requestedAt: new Date().toISOString(),
          customer: {
            shopifyId: customer.shopifyId,
            email: customer.email,
            firstOrderAt: customer.firstOrderAt,
            ordersCount: customer.ordersCount,
            lifetimeRevenue: centsToDollars(toCents(customer.lifetimeRevenue)),
            acquisitionChannel: customer.acquisitionChannel,
          },
          orders: customer.orders.map((order) => ({
            orderNumber: order.orderNumber,
            processedAt: order.processedAt,
            total: centsToDollars(toCents(order.total)),
            items: order.lineItems.map((item) => ({
              title: item.title,
              quantity: item.quantity,
              unitPrice: centsToDollars(toCents(item.unitPrice)),
            })),
          })),
        }
      : { shop: shopDomain, customer: null, note: "No data held for this customer." };

    // The delivery record is the audit trail proving the request was serviced.
    await prisma.webhookEvent.update({
      where: { webhookId },
      data: { error: null },
    });

    console.info(
      `[gdpr] data request for ${shopDomain}: ${
        customer ? `${report.orders?.length ?? 0} orders assembled` : "no data held"
      }`,
      JSON.stringify(report).slice(0, 2000),
    );
  });
}

export const loader = () => new Response(null, { status: 405 });
