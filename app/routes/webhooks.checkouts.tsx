import type { ActionFunctionArgs } from "react-router";

import { processCheckoutsWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/** Checkout delivery is acknowledged after durable projection, then processed off-request. */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processCheckoutsWebhook);
}

export const loader = () => new Response(null, { status: 405 });
