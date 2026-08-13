import { redirect, type LoaderFunctionArgs } from "react-router";

import landingHtml from "../../site/index.html?raw";
import { looksLikeShopifyRequest, resolveWebUser } from "~/lib/auth.server";
import { canonicalDeploymentRedirect } from "~/lib/public-origin.server";
import { hasShopifyCredentials } from "~/shopify.server";

/**
 * The marketing page, served by the app itself.
 *
 * One origin for everything: the landing page at `/`, the dashboard at `/app`,
 * sign-in at `/login`. That is not a preference — the web session cookie is
 * `__Host-` prefixed, which by definition cannot be shared across origins, so
 * a separately hosted marketing page physically could not hand a login to the
 * app. Serving it here is what makes "Log in" on the landing page work at all.
 *
 * This is a resource route: no default export, so React Router returns the
 * loader's Response as the document instead of treating it as data for a
 * component. That is what lets a hand-written HTML page — with its own CSS,
 * fonts and scroll choreography — be served without being rewritten as JSX.
 *
 * The HTML is inlined at build time by Vite's `?raw`, so the running server
 * never reads it off disk and the Docker image needs no extra COPY.
 */

const LANDING = new Response(landingHtml, {
  headers: {
    "content-type": "text/html; charset=utf-8",
    // The document is identical for everyone; the assets it pulls are
    // fingerprinted separately by Vite.
    "cache-control": "public, max-age=0, must-revalidate",
  },
});

export async function loader({ request }: LoaderFunctionArgs) {
  const canonicalRedirect = canonicalDeploymentRedirect(request);
  if (canonicalRedirect) return canonicalRedirect;

  const url = new URL(request.url);

  /*
   * Shopify opens the embedded app at application_url — which is this path —
   * with ?shop=&host= in the query string. That must still land in the app,
   * and it is checked first for the same reason `requireShopContext` checks
   * it first: a merchant can be signed in to the web dashboard in the same
   * browser as their admin.
   */
  if (hasShopifyCredentials && looksLikeShopifyRequest(request)) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // Already signed in on the web: go to the dashboard rather than the pitch.
  if (await resolveWebUser(request)) throw redirect("/app");

  // A fresh Response each time, because a Response body can only be read once.
  return LANDING.clone();
}
