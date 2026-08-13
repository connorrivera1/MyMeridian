import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  AccountShell,
  Field,
  FormError,
  ProviderButtons,
} from "~/design/account";
import { resolvePendingWebSession } from "~/lib/auth.server";
import { APP_NAME } from "~/lib/brand";
import {
  latestMfaChallenge,
  maskPhone,
  startMfaChallenge,
  verifyMfaChallenge,
  type MfaChannel,
} from "~/lib/mfa.server";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import { reauthenticationIsFresh } from "~/lib/reauth.server";
import { safeReturnPath } from "~/lib/web-oauth.server";
import { requestOriginIsSelf } from "~/lib/web-session.server";
import { verifyPassword } from "~/lib/webauth.server";

export const meta = () => [{ title: `Confirm Your Identity — ${APP_NAME}` }];

export async function loader({ request }: LoaderFunctionArgs) {
  const pending = await resolvePendingWebSession(request);
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  if (!pending)
    throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  if (!pending.session.mfaVerifiedAt) {
    throw redirect(`/mfa?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (reauthenticationIsFresh(pending.session.reauthenticatedAt)) {
    throw redirect(returnTo);
  }

  const latest = await latestMfaChallenge(pending.session.id);
  const challenge = latest?.purpose === "reauth" ? latest : null;
  return {
    challenge,
    hasPassword: Boolean(pending.user.passwordHash),
    phone: maskPhone(pending.user.phoneLast4),
    returnTo,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    return data({ error: "Your session expired. Try again." }, { status: 403 });
  }
  const pending = await resolvePendingWebSession(request);
  if (!pending?.session.mfaVerifiedAt) throw redirect("/login");

  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  const limited = await firstDeniedRequestLimit({
    request,
    scope: "web-reauth",
    windowMs: 15 * 60 * 1_000,
    ipLimit: 20,
    subject: pending.user.id,
    subjectLimit: 10,
  });
  if (limited) {
    return data(
      { error: RATE_LIMIT_MESSAGE },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "password") {
    const valid = await verifyPassword(
      String(form.get("password") ?? ""),
      pending.user.passwordHash,
    );
    if (!valid) {
      return data({ error: "That password is not valid." }, { status: 401 });
    }
    const channel: MfaChannel = form.get("channel") === "sms" ? "sms" : "email";
    try {
      await startMfaChallenge({
        session: { ...pending.session, user: pending.user },
        purpose: "reauth",
        channel,
      });
      throw redirect(`/reauth?returnTo=${encodeURIComponent(returnTo)}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return data(
        { error: "A new authentication code could not be sent." },
        { status: 503 },
      );
    }
  }

  if (intent === "verify") {
    const result = await verifyMfaChallenge({
      session: { ...pending.session, user: pending.user },
      challengeId: String(form.get("challengeId") ?? ""),
      code: String(form.get("code") ?? ""),
    });
    if (result.status !== "ok") {
      return data(
        {
          error:
            result.status === "expired"
              ? "That code expired or was already used. Start again."
              : "That authentication code is not valid.",
        },
        { status: 400 },
      );
    }
    throw redirect(returnTo);
  }

  return data(
    { error: "Unrecognised authentication request." },
    { status: 400 },
  );
}

export default function Reauthenticate() {
  const { challenge, hasPassword, phone, returnTo } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AccountShell
      title="Confirm It Is You"
      tagline="Sensitive changes require a fresh primary sign-in and a second factor."
    >
      {challenge ? (
        <Form method="post" className="account-form">
          <input type="hidden" name="intent" value="verify" />
          <input type="hidden" name="challengeId" value={challenge.id} />
          <Field
            label="Authentication Code"
            name="code"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
          />
          <FormError message={actionData?.error ?? null} />
          <button type="submit" className="account-submit">
            Confirm
          </button>
        </Form>
      ) : (
        <>
          {hasPassword ? (
            <Form method="post" className="account-form">
              <input type="hidden" name="intent" value="password" />
              <Field
                label="Password"
                name="password"
                type="password"
                autoComplete="current-password"
              />
              <label className="account-field">
                <span className="account-label">Send the Second Factor By</span>
                <select
                  className="account-input"
                  name="channel"
                  defaultValue="email"
                >
                  <option value="email">Email</option>
                  <option value="sms">
                    Text message {phone ? `to ${phone}` : ""}
                  </option>
                </select>
              </label>
              <FormError message={actionData?.error ?? null} />
              <button type="submit" className="account-submit">
                Continue
              </button>
            </Form>
          ) : null}

          <ProviderButtons
            returnTo={returnTo}
            verb="Re-authenticate"
            from="/reauth"
          />
          {!hasPassword ? (
            <FormError message={actionData?.error ?? null} />
          ) : null}
        </>
      )}
    </AccountShell>
  );
}
