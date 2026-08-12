import { redirect, type ActionFunctionArgs } from "react-router";

import { withShopContext } from "~/lib/auth.server";
import {
  beginConnectorOAuth,
  connectorProviderForSlug,
  type ConnectorProviderSlug,
} from "~/lib/connector-oauth.server";
import { planAllows, requireActivePlan } from "~/lib/plan.server";
import { publicAppOrigin } from "~/lib/public-origin.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const slug = String(params.provider ?? "") as ConnectorProviderSlug;
  if (!connectorProviderForSlug(slug)) {
    return new Response("Unknown connector.", { status: 404 });
  }
  return withShopContext(request, async (ctx) => {
    await requireRecentReauthentication(request, ctx.user);
    const plan = await requireActivePlan(ctx, request);
    if (!planAllows(plan, "adConnections")) throw redirect("/app/plan");
    try {
      const authorizationUrl = await beginConnectorOAuth({
        shopId: ctx.shop.id,
        slug,
        origin: publicAppOrigin(request),
      });
      throw redirect(authorizationUrl);
    } catch (error) {
      if (error instanceof Response) throw error;
      const message =
        error instanceof Error ? error.message : "Connector setup failed.";
      throw redirect(
        `/app/settings?connection_error=${encodeURIComponent(message)}`,
      );
    }
  });
}
