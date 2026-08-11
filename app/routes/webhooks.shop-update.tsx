import type { ActionFunctionArgs } from "react-router";

import { processShopUpdateWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/** Invalidate the stored development-store signal after a shop plan change. */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processShopUpdateWebhook);
}

export const loader = () => new Response(null, { status: 405 });
