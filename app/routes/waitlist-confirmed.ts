import type { LoaderFunctionArgs } from "react-router";

import confirmedHtml from "../../site/waitlist-confirmed.html?raw";
import { canonicalDeploymentRedirect } from "~/lib/public-origin.server";

async function confirmationResponse(): Promise<Response> {
  const { addPublicDocumentSecurityHeadersForHtml } = await import(
    "~/lib/public-document-security.server"
  );
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  addPublicDocumentSecurityHeadersForHtml(headers, confirmedHtml);
  return new Response(confirmedHtml, {
    headers,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const canonicalRedirect = canonicalDeploymentRedirect(request);
  if (canonicalRedirect) return canonicalRedirect;
  return await confirmationResponse();
}
