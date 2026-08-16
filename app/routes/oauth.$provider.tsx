import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  packHandshake,
  safeReturnPath,
  startApple,
  startGoogle,
  startMicrosoft,
} from "~/lib/web-oauth.server";
import { requestIsSecure, requestOriginIsSelf } from "~/lib/web-session.server";
import { publicAppOrigin } from "~/lib/public-origin.server";
import { HANDSHAKE_COOKIE } from "~/lib/web-oauth-cookie";
import {
  firstDeniedRequestLimit,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";

/**
 * The handshake cookie.
 *
 * Apple posts its callback back to us cross-site (`response_mode=form_post`),
 * and a SameSite=Lax cookie is not sent on a cross-site POST — so for Apple
 * the cookie has to be SameSite=None, which in turn requires Secure. Google
 * redirects with a GET, where Lax is both sufficient and tighter.
 *
 * Getting this wrong does not fail loudly: the sign-in completes at the
 * provider and then lands here with no state to compare, which is
 * indistinguishable from a forged callback and is rejected.
 */
function serializeHandshake(
  value: string,
  secure: boolean,
  crossSite: boolean,
): string {
  const parts = [
    `${HANDSHAKE_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=600`,
  ];

  if (crossSite) {
    // SameSite=None is only honoured with Secure, so on a plain-http dev
    // server this falls back to Lax and Apple sign-in is not offered anyway
    // (it needs a public https redirect URI to be configured at all).
    parts.push(secure ? "SameSite=None" : "SameSite=Lax");
  } else {
    parts.push("SameSite=Lax");
  }

  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function callbackUrl(request: Request, provider: string): string {
  return `${publicAppOrigin(request)}/oauth/${provider}/callback`;
}

/** Started by a POST so a prefetch or an image tag cannot begin a sign-in. */
export async function action({ request, params }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    throw new Response("Bad origin", { status: 403 });
  }

  const provider = params.provider;
  if (provider !== "google" && provider !== "microsoft" && provider !== "apple") {
    throw new Response("Unknown provider", { status: 404 });
  }
  const limited = await firstDeniedRequestLimit({
    request,
    scope: `oauth-start-${provider}`,
    windowMs: 15 * 60 * 1_000,
    ipLimit: 20,
  });
  if (limited) {
    throw new Response("Too many requests.", {
      status: 429,
      headers: rateLimitHeaders(limited),
    });
  }

  const form = await request.formData();
  const returnTo = safeReturnPath(String(form.get("returnTo") ?? ""));
  const from = safeReturnPath(String(form.get("from") ?? "")) || "/login";
  const redirectUri = callbackUrl(request, provider);

  const start =
    provider === "google"
      ? startGoogle(redirectUri)
      : provider === "microsoft"
        ? startMicrosoft(redirectUri)
        : startApple(redirectUri);

  /*
   * The credentials for this provider are not set. Both buttons are always
   * rendered, so this is a reachable state rather than a hand-made request —
   * send the person back to the form they came from with something to read,
   * instead of dropping them on a bare 404.
   */
  if (!start) {
    const back = new URL(from, request.url);
    back.searchParams.set("error", `${provider}-unavailable`);
    return redirect(back.pathname + back.search);
  }

  const packed = packHandshake({
    state: start.state,
    nonce: start.nonce,
    codeVerifier: start.codeVerifier,
    returnTo,
  });

  return redirect(start.url, {
    headers: {
      "set-cookie": serializeHandshake(
        packed,
        requestIsSecure(request),
        provider === "apple",
      ),
    },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  void request;
  throw redirect("/login");
}
