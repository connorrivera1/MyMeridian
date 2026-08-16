import { redirect, type LoaderFunctionArgs } from "react-router";

import {
  connectorProviderForSlug,
  finishConnectorOAuth,
  type ConnectorProviderSlug,
} from "~/lib/connector-oauth.server";
import { publicAppOrigin } from "~/lib/public-origin.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = String(params.provider ?? "") as ConnectorProviderSlug;
  if (!connectorProviderForSlug(slug)) return new Response("Unknown connector.", { status: 404 });
  const url = new URL(request.url);
  const providerError =
    url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) {
    // Provider-controlled text is not safe to preserve in URLs, browser
    // history, or application logs. OAuth providers can include account or
    // request context in an error description; the merchant only needs a
    // recoverable next step.
    throw redirect(
      "/app/settings?connection_error=Provider+authorization+was+cancelled+or+failed.+Try+again.",
    );
  }
  const code = url.searchParams.get("code") ?? url.searchParams.get("auth_code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) {
    throw redirect("/app/settings?connection_error=The+provider+returned+an+incomplete+authorization.");
  }
  try {
    await finishConnectorOAuth({
      slug,
      code,
      state,
      origin: publicAppOrigin(request),
    });
    throw redirect(`/app/settings?connected=${encodeURIComponent(slug)}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    // OAuth client errors can retain provider responses, headers, or tokens.
    // Keep operational logs correlation-safe and never serialize the error.
    console.error("[connector-oauth:%s] callback failed", slug);
    throw redirect(
      "/app/settings?connection_error=Connector+setup+failed.+Try+again.",
    );
  }
}
