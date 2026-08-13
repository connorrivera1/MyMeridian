import {
  data,
  redirect,
  useActionData,
  useLoaderData,
  Form,
  Link,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  AccountFooterLink,
  AccountShell,
  Field,
  FormError,
  ProviderButtons,
} from "~/design/account";
import { resolvePendingWebSession, resolveWebUser } from "~/lib/auth.server";
import { APP_NAME } from "~/lib/brand";
import { safeReturnPath } from "~/lib/web-oauth.server";
import { providerNotice } from "~/lib/provider-notice";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import {
  requestIsSecure,
  requestOriginIsSelf,
  serializeSessionCookie,
} from "~/lib/web-session.server";
import {
  SESSION_TTL_MS,
  authenticateWithPassword,
  createSession,
  normalizeEmail,
} from "~/lib/webauth.server";

export const meta = () => [{ title: `Sign In To ${APP_NAME}` }];

export async function loader({ request }: LoaderFunctionArgs) {
  if (await resolveWebUser(request)) throw redirect("/app");

  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  if (await resolvePendingWebSession(request)) {
    throw redirect(`/mfa?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return {
    returnTo,
    notice: providerNotice(url.searchParams.get("error")),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    return data({ error: "Your session expired. Try again." }, { status: 403 });
  }

  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const returnTo = safeReturnPath(String(form.get("returnTo") ?? ""));
  const limited = await firstDeniedRequestLimit({
    request,
    scope: "web-login",
    windowMs: 15 * 60 * 1_000,
    ipLimit: 20,
    subject: normalizeEmail(email),
    subjectLimit: 10,
  });
  if (limited) {
    return data(
      { error: RATE_LIMIT_MESSAGE },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }

  const outcome = await authenticateWithPassword(email, password);

  if (outcome.status === "locked") {
    const minutes = Math.max(1, Math.ceil(outcome.retryAfterMs / 60_000));
    return data(
      {
        error: `Too many attempts. Try again in ${minutes} minute${
          minutes === 1 ? "" : "s"
        }.`,
      },
      { status: 429 },
    );
  }

  if (outcome.status === "invalid") {
    // One message for a wrong password, an unknown address, and an account
    // that only has Apple or Google sign-in. Telling them apart is exactly
    // what makes the form useful to someone with a list of addresses.
    return data(
      { error: "That email and password do not match." },
      { status: 401 },
    );
  }

  const token = await createSession(
    outcome.user.id,
    request.headers.get("user-agent"),
  );

  return redirect(`/mfa?returnTo=${encodeURIComponent(returnTo)}`, {
    headers: {
      "set-cookie": serializeSessionCookie(
        token,
        requestIsSecure(request),
        Math.floor(SESSION_TTL_MS / 1000),
      ),
    },
  });
}

export default function Login() {
  const { returnTo, notice } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AccountShell
      title={`Sign In to ${APP_NAME}`}
      tagline="Your dashboard, outside the Shopify admin."
      footer={
        <AccountFooterLink
          prompt="No Account Yet?"
          to="/signup"
          label="Create One"
        />
      }
    >
      <ProviderButtons returnTo={returnTo} verb="Sign In" from="/login" />
      <FormError message={notice} />

      <Form method="post" className="account-form">
        <input type="hidden" name="returnTo" value={returnTo} />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <p className="account-forgot">
          <Link to="/forgot">Forgot Your Password?</Link>
        </p>
        <FormError message={actionData?.error ?? null} />
        <button type="submit" className="account-submit">
          Sign In
        </button>
      </Form>
    </AccountShell>
  );
}
