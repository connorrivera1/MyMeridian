import type { ActionFunctionArgs } from "react-router";

import { processInventoryItemsWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processInventoryItemsWebhook);
}

export const loader = () => new Response(null, { status: 405 });
