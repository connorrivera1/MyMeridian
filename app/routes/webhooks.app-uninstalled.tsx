import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { handleWebhook } from "~/lib/webhooks.server";

/**
 * app/uninstalled.
 *
 * The access token is dead the moment this arrives, so sessions go immediately.
 * Store data is kept until shop/redact (48h later) — merchants reinstall often,
 * and throwing away six months of cost configuration because someone clicked
 * uninstall by mistake would be its own kind of data loss.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain }) => {
    await prisma.session.deleteMany({ where: { shop: shopDomain } });

    await prisma.shop.updateMany({
      where: { domain: shopDomain },
      data: { uninstalledAt: new Date() },
    });

    console.info(`[app] uninstalled from ${shopDomain}; sessions cleared`);
  });
}

export const loader = () => new Response(null, { status: 405 });
