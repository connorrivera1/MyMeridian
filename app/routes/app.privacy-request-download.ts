import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";

import { withShopContext } from "~/lib/auth.server";
import { collectDataRequestForDownload } from "~/lib/data-request.server";
import { recordSensitiveAction } from "~/lib/security-audit.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
} as const;

export const headers: HeadersFunction = () => NO_STORE_HEADERS;

/** Full exports only cross this authenticated, shop-scoped collection edge. */
export async function action({ request, params }: ActionFunctionArgs) {
  return withShopContext(request, async (ctx) => {
    await requireRecentReauthentication(request, ctx.user);
    const { shop } = ctx;
    const id = params.id?.trim();
    if (!id) {
      throw new Response("Export not found.", {
        status: 404,
        headers: NO_STORE_HEADERS,
      });
    }

    const collected = await collectDataRequestForDownload(shop.id, id);
    if (!collected) {
      // Cross-shop and expired ids deliberately have the same response so this
      // resource cannot be used to enumerate another merchant's obligations.
      throw new Response("Export not found.", {
        status: 404,
        headers: NO_STORE_HEADERS,
      });
    }

    const filename = `meridian-data-request-${collected.requestedAt
      .toISOString()
      .slice(0, 10)}.json`;
    await recordSensitiveAction({
      shopId: shop.id,
      actorType: ctx.user ? "web_account" : "shopify_session",
      actorId: ctx.user?.id ?? ctx.session?.id ?? shop.id,
      request,
      action: "CUSTOMER_EXPORT_DOWNLOADED",
      resource: `data_request:${id}`,
    });
    return new Response(JSON.stringify(collected.report, null, 2), {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  });
}

export function loader(_args: LoaderFunctionArgs) {
  return new Response("Method not allowed", {
    status: 405,
    headers: { ...NO_STORE_HEADERS, Allow: "POST" },
  });
}
