import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { buildCustomerExport, recordDataRequest } from "~/lib/data-request.server";
import { handleWebhook } from "~/lib/webhooks.server";

/**
 * customers/data_request — mandatory GDPR webhook.
 *
 * A customer has asked what the store holds on them. Shopify requires the app
 * to hand the data to the *merchant*, who is the controller, within 30 days.
 *
 * The export is assembled here and stored for the merchant to collect from
 * Settings → Customer data requests. It deliberately does not email the customer
 * directly: the app is a processor and must not open its own channel to the data
 * subject.
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

    const requestedAt = new Date();
    const report = buildCustomerExport(shopDomain, customer, requestedAt);

    // A request with nothing behind it is still a request the merchant has to
    // answer, so an empty export is stored rather than dropped: "we hold nothing
    // on this person" is the answer, and they need it in hand to give it.
    await recordDataRequest({
      shopId: shop.id,
      webhookId,
      shopifyCustomerId: customer?.shopifyId ?? String(customerId),
      customerEmail: customer?.email ?? null,
      report,
      requestedAt,
    });

    // The delivery record is the audit trail proving the request was serviced.
    await prisma.webhookEvent.update({
      where: { webhookId },
      data: { error: null },
    });

    // Counts only. The report itself is personal data and application logs are
    // not a place to keep a copy of it.
    console.info(
      `[gdpr] data request for ${shopDomain}: ${
        customer
          ? `${report.orders.length} orders assembled, awaiting collection`
          : "no data held"
      }`,
    );
  });
}

export const loader = () => new Response(null, { status: 405 });
