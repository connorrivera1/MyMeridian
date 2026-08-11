import type { ActionFunctionArgs } from "react-router";

import { processAppUninstalledWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/** The dead access session goes now; store data stays until shop/redact. */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processAppUninstalledWebhook);
}

export const loader = () => new Response(null, { status: 405 });
