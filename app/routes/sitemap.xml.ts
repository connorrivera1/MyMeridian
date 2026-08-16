import type { LoaderFunctionArgs } from "react-router";

import { addSecurityHeaders } from "~/lib/http-security";
import { publicAppOrigin } from "~/lib/public-origin.server";

const PUBLIC_PATHS = ["/", "/privacy", "/terms.html", "/support"];

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A deliberately small sitemap: authenticated and staging routes never appear. */
export function loader({ request }: LoaderFunctionArgs) {
  const origin = new URL(publicAppOrigin(request));
  const production = origin.hostname.toLowerCase() === "mymeridian.io";
  const urls = production
    ? PUBLIC_PATHS.map((path) => `  <url><loc>${xmlEscape(new URL(path, origin).href)}</loc></url>`).join("\n")
    : "";
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls ? `\n${urls}\n` : ""}</urlset>\n`;
  const headers = new Headers({
    "cache-control": "public, max-age=300",
    "content-type": "application/xml; charset=utf-8",
  });
  addSecurityHeaders(headers);
  return new Response(body, { headers });
}
