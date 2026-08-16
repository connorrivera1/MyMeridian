import {
  Form,
  data,
  redirect,
  useActionData,
  useLoaderData,
} from "react-router";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";

import operatorStyles from "~/design/operator.css?url";
import {
  authenticateOperator,
  OPERATOR_SECURITY_HEADERS,
  operatorConfiguration,
} from "~/lib/operator-auth.server";
import {
  firstDeniedRequestLimit,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import { requestOriginIsSelf } from "~/lib/web-session.server";

export function loader(_args: LoaderFunctionArgs) {
  const configuration = operatorConfiguration();
  return { configured: configuration.configured };
}

export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    return data(
      { error: "This sign-in request could not be verified." },
      { status: 403, headers: OPERATOR_SECURITY_HEADERS },
    );
  }
  const limited = await firstDeniedRequestLimit({
    request,
    scope: "operator-login",
    windowMs: 15 * 60 * 1_000,
    ipLimit: 10,
  });
  if (limited) {
    return data(
      { error: "Too many sign-in attempts. Wait and try again." },
      {
        status: 429,
        headers: {
          ...OPERATOR_SECURITY_HEADERS,
          ...rateLimitHeaders(limited),
        },
      },
    );
  }
  const form = await request.formData();
  const email = String(form.get("email") ?? "").slice(0, 320);
  const password = String(form.get("password") ?? "").slice(0, 512);
  const totpCode = String(form.get("totp") ?? "").slice(0, 16);
  const result = await authenticateOperator({
    request,
    email,
    password,
    totpCode,
  });

  if (result.reason === "not_configured") {
    return data(
      { error: "Operator access is not configured." },
      { status: 503, headers: OPERATOR_SECURITY_HEADERS },
    );
  }
  if (!result.ok) {
    return data(
      {
        error:
          result.reason === "rate_limited"
            ? "Too many sign-in attempts. Wait 15 minutes and try again."
            : "The credentials or authentication code are invalid.",
      },
      {
        status: result.reason === "rate_limited" ? 429 : 401,
        headers: OPERATOR_SECURITY_HEADERS,
      },
    );
  }
  return redirect("/operator", {
    headers: {
      ...OPERATOR_SECURITY_HEADERS,
      "set-cookie": result.cookie!,
    },
  });
}

export const headers: HeadersFunction = () => OPERATOR_SECURITY_HEADERS;
export const links = () => [{ rel: "stylesheet", href: operatorStyles }];

export default function OperatorLogin() {
  const { configured } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <main className="operator-login-shell">
      <section
        className="operator-login-card"
        aria-labelledby="operator-login-title"
      >
        <p className="operator-kicker">Publisher Operations</p>
        <h1 id="operator-login-title">Meridian Operator Access</h1>
        <p className="operator-muted">
          Separate credentials and a current authenticator code are required.
          Merchant Shopify and MyMeridian sessions are never accepted here.
        </p>

        {!configured ? (
          <div className="operator-alert operator-alert-critical" role="alert">
            Operator access is unavailable because its production credentials
            have not been provisioned.
          </div>
        ) : (
          <Form method="post" className="operator-form">
            <label>
              Publisher Email
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                maxLength={320}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={512}
              />
            </label>
            <label>
              Authenticator Code
              <input
                name="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                maxLength={6}
              />
            </label>
            {actionData?.error && (
              <div
                className="operator-alert operator-alert-critical"
                role="alert"
              >
                {actionData.error}
              </div>
            )}
            <button type="submit" className="operator-primary-button">
              Sign In Securely
            </button>
          </Form>
        )}
      </section>
    </main>
  );
}
