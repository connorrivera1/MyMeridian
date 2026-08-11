import type { ActionFunctionArgs } from "react-router";

import { processOrdersWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/**
 * orders/create, orders/updated and refunds/create share this endpoint. The
 * processor keeps the bare Refund shape out of the order upsert path.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processOrdersWebhook);
}

export const loader = () => new Response(null, { status: 405 });
