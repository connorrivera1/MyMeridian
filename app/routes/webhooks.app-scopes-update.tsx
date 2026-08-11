import type { ActionFunctionArgs } from "react-router";

import { processAppScopesUpdateWebhook } from "~/lib/webhook-processors.server";
import { handleWebhook } from "~/lib/webhooks.server";

/** Managed-installation scope changes keep capability gating honest. */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, processAppScopesUpdateWebhook);
}

export const loader = () => new Response(null, { status: 405 });
