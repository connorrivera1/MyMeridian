import type { LoaderFunctionArgs } from "react-router";

import confirmedHtml from "../../site/waitlist-confirmed.html?raw";
import { canonicalDeploymentRedirect } from "~/lib/public-origin.server";

const CONFIRMATION = new Response(confirmedHtml, {
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  },
});

export function loader({ request }: LoaderFunctionArgs) {
  const canonicalRedirect = canonicalDeploymentRedirect(request);
  if (canonicalRedirect) return canonicalRedirect;
  return CONFIRMATION.clone();
}
