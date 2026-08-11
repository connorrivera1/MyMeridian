import { redirect, type LoaderFunctionArgs } from "react-router";

import {
  connectorProviderForSlug,
  finishConnectorOAuth,
  type ConnectorProviderSlug,
} from "~/lib/connector-oauth.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = String(params.provider ?? "") as ConnectorProviderSlug;
  if (!connectorProviderForSlug(slug)) return new Response("Unknown connector.", { status: 404 });
  const url = new URL(request.url);
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) {
    throw redirect(`/app/settings?connection_error=${encodeURIComponent(providerError.slice(0, 300))}`);
  }
  const code = url.searchParams.get("code") ?? url.searchParams.get("auth_code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) {
    throw redirect("/app/settings?connection_error=The+provider+returned+an+incomplete+authorization.");
  }
  try {
    await finishConnectorOAuth({ slug, code, state, origin: url.origin });
    throw redirect(`/app/settings?connected=${encodeURIComponent(slug)}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    const message = error instanceof Error ? error.message : "Connector setup failed.";
    console.error(`[connector-oauth:${slug}] callback failed`, error);
    throw redirect(`/app/settings?connection_error=${encodeURIComponent(message.slice(0, 300))}`);
  }
}
