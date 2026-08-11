import type { ActionFunctionArgs } from "react-router";

import { processCustomersRedactWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/** Remove shopper identity while retaining anonymous order economics. */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processCustomersRedactWebhook);
}

export const loader = () => new Response(null, { status: 405 });
