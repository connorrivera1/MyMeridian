import type { ActionFunctionArgs } from "react-router";

import { processShopRedactWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/** Delete all shop-owned data; WebhookEvent rows leave through the same cascade. */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processShopRedactWebhook);
}

export const loader = () => new Response(null, { status: 405 });
