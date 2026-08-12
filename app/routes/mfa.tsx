import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AccountShell, Field, FormError } from "~/design/account";
import { resolvePendingWebSession } from "~/lib/auth.server";
import { APP_NAME } from "~/lib/brand";
import {
  latestMfaChallenge,
  maskPhone,
  normalizePhoneNumber,
  startMfaChallenge,
  verifyMfaChallenge,
  type MfaChannel,
  type MfaPurpose,
} from "~/lib/mfa.server";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import { safeReturnPath } from "~/lib/web-oauth.server";
import { requestOriginIsSelf } from "~/lib/web-session.server";

export const meta = () => [{ title: `Secure your ${APP_NAME} account` }];

function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at > 0 ? `*****${email.slice(at)}` : "your email";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const pending = await resolvePendingWebSession(request);
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  if (!pending)
    throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  if (pending.session.mfaVerifiedAt) throw redirect(returnTo);

  const challenge = await latestMfaChallenge(pending.session.id);
  const phase = !pending.user.emailVerifiedAt
    ? ("email" as const)
    : !pending.user.phoneVerifiedAt
      ? ("phone" as const)
      : ("challenge" as const);

  return {
    phase,
    challenge,
    email: maskEmail(pending.user.email),
    phone: maskPhone(pending.user.phoneLast4),
    returnTo,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    return data({ error: "Your session expired. Try again." }, { status: 403 });
  }

  const pending = await resolvePendingWebSession(request);
  if (!pending) throw redirect("/login");
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  const limited = await firstDeniedRequestLimit({
    request,
    scope: "web-mfa",
    windowMs: 15 * 60 * 1_000,
    ipLimit: 30,
    subject: pending.user.id,
    subjectLimit: 20,
  });
  if (limited) {
    return data(
      { error: RATE_LIMIT_MESSAGE },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "send-email" || intent === "send-sms") {
    const channel: MfaChannel = intent === "send-email" ? "email" : "sms";
    const purpose: MfaPurpose =
      channel === "email" && !pending.user.emailVerifiedAt
        ? "enroll_email"
        : channel === "sms" && !pending.user.phoneVerifiedAt
          ? "enroll_phone"
          : "login";
    const phone = String(form.get("phone") ?? "");
    if (purpose === "enroll_phone" && !normalizePhoneNumber(phone)) {
      return data(
        { error: "Enter a phone number with its country code." },
        { status: 400 },
      );
    }
    try {
      await startMfaChallenge({
        session: { ...pending.session, user: pending.user },
        purpose,
        channel,
        phone,
      });
      return redirect(`/mfa?returnTo=${encodeURIComponent(returnTo)}`);
    } catch (error) {
      void error;
      return data(
        {
          error:
            "The authentication code could not be sent. Try again shortly.",
        },
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
              ? "That code expired or was already used. Send a new one."
              : "That authentication code is not valid.",
        },
        { status: 400 },
      );
    }

    const purpose = String(form.get("purpose") ?? "");
    if (purpose === "login" || purpose === "reauth") throw redirect(returnTo);
    throw redirect(`/mfa?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return data(
    { error: "Unrecognised authentication request." },
    { status: 400 },
  );
}

export default function Mfa() {
  const { phase, challenge, email, phone } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <AccountShell
      title="Protect your account"
      tagline="Standalone access requires verified email and phone recovery channels plus a fresh sign-in code."
    >
      <div className="account-form">
        <p className="account-fineprint">
          Shopify-admin access continues to use Shopify&apos;s signed session.
          These factors protect only your separate MyMeridian browser account.
        </p>

        {challenge ? (
          <Form method="post" className="account-form">
            <input type="hidden" name="intent" value="verify" />
            <input type="hidden" name="challengeId" value={challenge.id} />
            <input type="hidden" name="purpose" value={challenge.purpose} />
            <p className="account-fineprint">
              Enter the six-digit code sent by{" "}
              {challenge.channel === "sms" ? "text message" : "email"}.
            </p>
            <Field
              label="Authentication code"
              name="code"
              type="text"
              autoComplete="one-time-code"
              inputMode="numeric"
            />
            <FormError message={actionData?.error ?? null} />
            <button type="submit" className="account-submit">
              Verify code
            </button>
          </Form>
        ) : phase === "email" ? (
          <Form method="post" className="account-form">
            <input type="hidden" name="intent" value="send-email" />
            <p className="account-fineprint">First verify {email}.</p>
            <FormError message={actionData?.error ?? null} />
            <button type="submit" className="account-submit">
              Email my code
            </button>
          </Form>
        ) : phase === "phone" ? (
          <Form method="post" className="account-form">
            <input type="hidden" name="intent" value="send-sms" />
            <Field
              label="Mobile phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              hint="Include the country code, for example +1 212 555 0100."
            />
            <FormError message={actionData?.error ?? null} />
            <button type="submit" className="account-submit">
              Text my code
            </button>
          </Form>
        ) : (
          <div className="account-form">
            <p className="account-fineprint">
              Send a fresh sign-in code to {email} or{" "}
              {phone ?? "your verified phone"}.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="send-email" />
              <button type="submit" className="account-submit">
                Email my code
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="send-sms" />
              <button type="submit" className="account-submit secondary">
                Text my code
              </button>
            </Form>
            <FormError message={actionData?.error ?? null} />
          </div>
        )}
      </div>
    </AccountShell>
  );
}
