import type { ActionFunctionArgs } from "react-router";

import { processAppSubscriptionsWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/** Billing API subscription changes update current plan and append history. */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processAppSubscriptionsWebhook);
}

export const loader = () => new Response(null, { status: 405 });
