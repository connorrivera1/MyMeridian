import { redirect, type ActionFunctionArgs } from "react-router";

import { withShopContext } from "~/lib/auth.server";
import {
  beginConnectorOAuth,
  connectorProviderForSlug,
  type ConnectorProviderSlug,
} from "~/lib/connector-oauth.server";
import { planAllows, requireActivePlan } from "~/lib/plan.server";
import { publicAppOrigin } from "~/lib/public-origin.server";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";
import { recordSensitiveAction } from "~/lib/security-audit.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const slug = String(params.provider ?? "") as ConnectorProviderSlug;
  if (!connectorProviderForSlug(slug)) {
    return new Response("Unknown connector.", { status: 404 });
  }
  return withShopContext(request, async (ctx) => {
    await requireRecentReauthentication(request, ctx.user);
    const plan = await requireActivePlan(ctx, request);
    if (!planAllows(plan, "adConnections")) throw redirect("/app/plan");
    const limited = await firstDeniedRequestLimit({
      request,
      scope: "connector_oauth_start",
      windowMs: 15 * 60 * 1_000,
      ipLimit: 10,
      subject: ctx.user?.id ?? ctx.shop.id,
      subjectLimit: 3,
    });
    if (limited) {
      return new Response(RATE_LIMIT_MESSAGE, {
        status: 429,
        headers: rateLimitHeaders(limited),
      });
    }
    try {
      const authorizationUrl = await beginConnectorOAuth({
        shopId: ctx.shop.id,
        slug,
        origin: publicAppOrigin(request),
      });
      await recordSensitiveAction({
        shopId: ctx.shop.id,
        actorType: ctx.user ? "web_account" : "shopify_session",
        actorId: ctx.user?.id ?? ctx.session?.id ?? ctx.shop.id,
        request,
        action: "CONNECTOR_OAUTH_STARTED",
        resource: `connector:${slug}`,
      });
      throw redirect(authorizationUrl);
    } catch (error) {
      if (error instanceof Response) throw error;
      // Errors at this boundary can originate in a provider SDK, database
      // driver or an OAuth configuration check.  They must never be copied
      // into a merchant-facing URL because those messages may retain provider
      // response context or connection details.
      console.error("[connector-oauth:%s] start failed", slug);
      throw redirect(
        "/app/settings?connection_error=Connector+setup+could+not+be+started.+Try+again.",
      );
    }
  });
}
