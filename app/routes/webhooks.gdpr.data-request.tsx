import type { ActionFunctionArgs } from "react-router";

import { processCustomerDataRequestWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/** Assemble the shopper export for the merchant, who remains the controller. */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processCustomerDataRequestWebhook);
}

export const loader = () => new Response(null, { status: 405 });
