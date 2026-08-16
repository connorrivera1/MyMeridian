import type { LoaderFunctionArgs } from "react-router";

import { addSecurityHeaders } from "~/lib/http-security";
import { publicAppOrigin } from "~/lib/public-origin.server";

function robotsHeaders(): Headers {
  const headers = new Headers({
    "cache-control": "public, max-age=300",
    "content-type": "text/plain; charset=utf-8",
  });
  addSecurityHeaders(headers);
  return headers;
}

/** Keep the staging environment out of search results without hiding launch. */
export function loader({ request }: LoaderFunctionArgs) {
  const origin = new URL(publicAppOrigin(request));
  const production = origin.hostname.toLowerCase() === "mymeridian.io";
  const body = production
    ? `User-agent: *\nAllow: /\nSitemap: ${origin.origin}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n";

  return new Response(body, { headers: robotsHeaders() });
}
