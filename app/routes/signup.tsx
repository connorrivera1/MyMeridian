import {
  data,
  redirect,
  useActionData,
  useLoaderData,
  Form,
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
  createPasswordUser,
  createSession,
  createVerificationToken,
  normalizeEmail,
} from "~/lib/webauth.server";

export const meta = () => [{ title: `Create your ${APP_NAME} account` }];

export async function loader({ request }: LoaderFunctionArgs) {
  // Already signed in: nothing to sign up for.
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
  const name = form.get("name") ? String(form.get("name")) : null;
  const returnTo = safeReturnPath(String(form.get("returnTo") ?? ""));
  const limited = await firstDeniedRequestLimit({
    request,
    scope: "web-signup",
    windowMs: 60 * 60 * 1_000,
    ipLimit: 10,
    subject: normalizeEmail(email),
    subjectLimit: 3,
  });
  if (limited) {
    return data(
      { error: RATE_LIMIT_MESSAGE },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }

  const result = await createPasswordUser(email, password, name);
  if (!result.ok) {
    return data(
      { error: result.error ?? "Check your details." },
      { status: 400 },
    );
  }

  /*
   * `result.user` is absent when the address was already registered.
   *
   * That case is deliberately indistinguishable from success here — see
   * `createPasswordUser` — so this branch redirects to the same confirmation
   * screen without creating a session. The person who actually owns the
   * address finds out from their inbox, and someone probing the form learns
   * nothing.
   */
  if (!result.user) {
    return redirect("/welcome?pending=1");
  }

  // Issued now, sent when the mail domain is configured. Creating it here
  // means the confirmation link exists from the moment the account does.
  await createVerificationToken(result.user.id);

  const token = await createSession(
    result.user.id,
    request.headers.get("user-agent"),
  );

  /*
   * Straight to /welcome rather than the dashboard. The splash is claimed
   * there, once, against the User row — routing through it is what makes
   * "only after they sign up for the first time" true even if someone
   * bookmarks the URL or signs in again on another device.
   */
  const welcome = new URL("/welcome", request.url);
  welcome.searchParams.set("next", returnTo);

  return redirect(
    `/mfa?returnTo=${encodeURIComponent(welcome.pathname + welcome.search)}`,
    {
      headers: {
        "set-cookie": serializeSessionCookie(
          token,
          requestIsSecure(request),
          Math.floor(SESSION_TTL_MS / 1000),
        ),
      },
    },
  );
}

export default function Signup() {
  const { returnTo, notice } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AccountShell
      title={`Create your ${APP_NAME} account`}
      tagline="See what your store keeps, from the browser or from inside Shopify."
      footer={
        <AccountFooterLink
          prompt="Already have an account?"
          to="/login"
          label="Sign in"
        />
      }
    >
      <ProviderButtons returnTo={returnTo} verb="Sign up" from="/signup" />
      <FormError message={notice} />

      <Form method="post" className="account-form">
        <input type="hidden" name="returnTo" value={returnTo} />
        <Field
          label="Name"
          name="name"
          type="text"
          autoComplete="name"
          required={false}
        />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
        />
        <FormError message={actionData?.error ?? null} />
        <button type="submit" className="account-submit">
          Create account
        </button>
      </Form>

      <p className="account-fineprint">
        Creating an account does not connect a store. You choose which Shopify
        store to connect next, and MyMeridian only ever reads it.
      </p>
    </AccountShell>
  );
}
