import { redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  OPERATOR_SECURITY_HEADERS,
  revokeOperatorSession,
  serializeOperatorClearCookies,
} from "~/lib/operator-auth.server";
import { requestOriginIsSelf } from "~/lib/web-session.server";

export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    return new Response("Forbidden", {
      status: 403,
      headers: OPERATOR_SECURITY_HEADERS,
    });
  }
  await revokeOperatorSession(request);
  const headers = new Headers(OPERATOR_SECURITY_HEADERS);
  for (const cookie of serializeOperatorClearCookies()) {
    headers.append("set-cookie", cookie);
  }
  throw redirect("/operator/login", { headers });
}

export function loader(_args: LoaderFunctionArgs) {
  return new Response(null, {
    status: 405,
    headers: OPERATOR_SECURITY_HEADERS,
  });
}
