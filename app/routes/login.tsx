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
import { resolveWebUser } from "~/lib/auth.server";
import { APP_NAME } from "~/lib/brand";
import { safeReturnPath } from "~/lib/web-oauth.server";
import { providerNotice } from "~/lib/provider-notice";
import {
  requestIsSecure,
  requestOriginIsSelf,
  serializeSessionCookie,
} from "~/lib/web-session.server";
import {
  SESSION_TTL_MS,
  authenticateWithPassword,
  createSession,
} from "~/lib/webauth.server";

export const meta = () => [{ title: `Sign in to ${APP_NAME}` }];

export async function loader({ request }: LoaderFunctionArgs) {
  if (await resolveWebUser(request)) throw redirect("/app");

  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));

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
    return data({ error: "That email and password do not match." }, { status: 401 });
  }

  const token = await createSession(
    outcome.user.id,
    request.headers.get("user-agent"),
  );

  return redirect(returnTo, {
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
      title={`Sign in to ${APP_NAME}`}
      tagline="Your dashboard, outside the Shopify admin."
      footer={
        <AccountFooterLink
          prompt="No account yet?"
          to="/signup"
          label="Create one"
        />
      }
    >
      <ProviderButtons returnTo={returnTo} verb="Sign in" from="/login" />
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
          <Link to="/forgot">Forgot your password?</Link>
        </p>
        <FormError message={actionData?.error ?? null} />
        <button type="submit" className="account-submit">
          Sign in
        </button>
      </Form>
    </AccountShell>
  );
}
