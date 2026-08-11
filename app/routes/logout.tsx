import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import {
  readSessionToken,
  requestOriginIsSelf,
  serializeSessionClearCookies,
} from "~/lib/web-session.server";
import { revokeSession } from "~/lib/webauth.server";

/**
 * Logout is a POST.
 *
 * A GET would let any page log a merchant out with an `<img src="/logout">`,
 * and — worse for a dashboard — browsers and link prefetchers follow GETs on
 * their own.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    throw new Response("Bad origin", { status: 403 });
  }

  await revokeSession(readSessionToken(request));

  const headers = new Headers();
  // Both cookie names, so a session created over http is also cleared.
  for (const cookie of serializeSessionClearCookies()) {
    headers.append("set-cookie", cookie);
  }
  headers.set("location", "/login");

  return new Response(null, { status: 302, headers });
}

/** Someone who navigates here directly gets the login page, not an error. */
export async function loader({ request }: LoaderFunctionArgs) {
  void request;
  throw redirect("/login");
}
