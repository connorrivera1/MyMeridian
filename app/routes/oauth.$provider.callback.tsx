import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  completeApple,
  completeGoogle,
  completeMicrosoft,
  safeReturnPath,
  unpackHandshake,
} from "~/lib/web-oauth.server";
import {
  readCookie,
  requestIsSecure,
  serializeSessionCookie,
} from "~/lib/web-session.server";
import {
  SESSION_TTL_MS,
  createSession,
  upsertOAuthUser,
} from "~/lib/webauth.server";
import { publicAppOrigin } from "~/lib/public-origin.server";
import { HANDSHAKE_COOKIE } from "~/lib/web-oauth-cookie";
import {
  firstDeniedRequestLimit,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";

function clearHandshake(secure: boolean): string {
  return [
    `${HANDSHAKE_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Anything that goes wrong lands back on sign-in with a neutral message. */
function rejected(secure: boolean) {
  const headers = new Headers();
  headers.append("set-cookie", clearHandshake(secure));
  headers.set("location", "/login?error=oauth");
  return new Response(null, { status: 302, headers });
}

interface CallbackInput {
  code: string | null;
  state: string | null;
  /** Apple only, and only on the very first authorisation. */
  name: string | null;
}

async function handle(
  request: Request,
  provider: string | undefined,
  input: CallbackInput,
): Promise<Response> {
  const secure = requestIsSecure(request);

  if (provider !== "google" && provider !== "microsoft" && provider !== "apple") {
    throw new Response("Unknown provider", { status: 404 });
  }
  const limited = await firstDeniedRequestLimit({
    request,
    scope: `oauth-callback-${provider}`,
    windowMs: 15 * 60 * 1_000,
    ipLimit: 30,
  });
  if (limited) {
    return new Response("Too many requests.", {
      status: 429,
      headers: rateLimitHeaders(limited),
    });
  }

  const handshake = unpackHandshake(readCookie(request, HANDSHAKE_COOKIE));

  /*
   * No handshake, or a state that does not match it, means this callback was
   * not started by this browser. That is the CSRF case the state parameter
   * exists for, and it is also what a replayed callback URL looks like.
   */
  if (!handshake || !input.code || !input.state) return rejected(secure);
  if (input.state !== handshake.state) return rejected(secure);

  const redirectUri = `${publicAppOrigin(request)}/oauth/${provider}/callback`;

  const identity =
    provider === "google"
      ? await completeGoogle(
          input.code,
          redirectUri,
          handshake.codeVerifier,
          handshake.nonce,
        )
      : provider === "microsoft"
        ? await completeMicrosoft(
            input.code,
            redirectUri,
            handshake.codeVerifier,
            handshake.nonce,
          )
        : await completeApple(
            input.code,
            redirectUri,
            handshake.nonce,
            input.name,
          );

  if (!identity) return rejected(secure);

  const { user } = await upsertOAuthUser({
    provider:
      provider === "google"
        ? "GOOGLE"
        : provider === "microsoft"
          ? "MICROSOFT"
          : "APPLE",
    providerUserId: identity.providerUserId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    name: identity.name,
  });

  const token = await createSession(user.id, request.headers.get("user-agent"));

  /*
   * Everyone goes through /welcome. It claims the one-time splash and forwards
   * immediately when there is nothing to claim, so a returning user sees no
   * interruption and a first-time one gets the greeting — without this route
   * needing to know which it is.
   */
  const next = safeReturnPath(handshake.returnTo);
  const welcome = `/welcome?next=${encodeURIComponent(next)}`;
  const mfa = `/mfa?returnTo=${encodeURIComponent(welcome)}`;

  const headers = new Headers();
  headers.append("set-cookie", clearHandshake(secure));
  headers.append(
    "set-cookie",
    serializeSessionCookie(token, secure, Math.floor(SESSION_TTL_MS / 1000)),
  );
  headers.set("location", mfa);

  return new Response(null, { status: 302, headers });
}

/** Google and Microsoft return with a top-level GET. */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  // The provider reported a failure, or the person pressed cancel.
  if (url.searchParams.get("error")) {
    return redirect("/login?error=cancelled");
  }

  return handle(request, params.provider, {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    name: null,
  });
}

/** Apple returns with a cross-site form post. */
export async function action({ request, params }: ActionFunctionArgs) {
  const form = await request.formData();

  if (form.get("error")) return redirect("/login?error=cancelled");

  /*
   * Apple sends the name once, in this post, on the first authorisation only —
   * it is never in the id_token and never sent again. An account created on a
   * later sign-in therefore has no name unless it was captured here.
   */
  let name: string | null = null;
  const rawUser = form.get("user");
  if (typeof rawUser === "string") {
    try {
      const parsed = JSON.parse(rawUser);
      const first = parsed?.name?.firstName;
      const last = parsed?.name?.lastName;
      name = [first, last].filter(Boolean).join(" ") || null;
    } catch {
      name = null;
    }
  }

  return handle(request, params.provider, {
    code: form.get("code") ? String(form.get("code")) : null,
    state: form.get("state") ? String(form.get("state")) : null,
    name,
  });
}
