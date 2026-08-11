import { useEffect, useState } from "react";
import {
  data,
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  Form,
  Link,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { AccountShell, Field, FormError } from "~/design/account";
import { BrandMark } from "~/design/components";
import { APP_NAME } from "~/lib/brand";
import { CODE_LENGTH } from "~/lib/password-reset";
import {
  clearResetCookie,
  deliverResetCode,
  issueResetCode,
  maskEmail,
  readPendingResetEmail,
  resetPasswordWithCode,
  serializeResetCookie,
} from "~/lib/password-reset.server";
import { emailLooksValid, normalizeEmail } from "~/lib/webauth.server";
import { requestIsSecure, requestOriginIsSelf } from "~/lib/web-session.server";

export const meta = () => [{ title: `Reset your ${APP_NAME} password` }];

type Phase = "email" | "code" | "done";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  if (url.searchParams.get("done") === "1") {
    return { phase: "done" as Phase, masked: null };
  }

  const pending = readPendingResetEmail(request);
  if (pending) {
    return { phase: "code" as Phase, masked: maskEmail(pending) };
  }

  return { phase: "email" as Phase, masked: null };
}

export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    return data({ error: "Your session expired. Try again." }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const secure = requestIsSecure(request);

  /* ------------------------------------------------- step 1: ask for a code */

  if (intent === "request") {
    const email = normalizeEmail(String(form.get("email") ?? ""));

    if (!emailLooksValid(email)) {
      return data({ error: "Enter a valid email address." }, { status: 400 });
    }

    const issued = await issueResetCode(email);

    /*
     * `issued.code` is null when no account has this address, and this is the
     * one branch that must not show. The screen, the redirect and the masked
     * address are identical either way — the address shown is the one that was
     * just typed, never one read back from the database — so the form says
     * nothing about who has an account here.
     */
    if (issued.code) await deliverResetCode(email, issued.code);

    return redirect("/forgot", {
      headers: { "set-cookie": serializeResetCookie(email, secure) },
    });
  }

  /* ------------------------------------- step 2: prove it, and set the new one */

  if (intent === "reset") {
    const email = readPendingResetEmail(request);
    if (!email) return redirect("/forgot");

    const outcome = await resetPasswordWithCode(
      email,
      String(form.get("code") ?? ""),
      String(form.get("password") ?? ""),
    );

    if (outcome.status === "weak-password") {
      return data({ error: outcome.error }, { status: 400 });
    }

    if (outcome.status === "invalid-code") {
      return data(
        { error: "That code is not right. Check the email and try again." },
        { status: 400 },
      );
    }

    if (outcome.status === "no-code") {
      // Expired, already used, or too many wrong guesses. All three mean the
      // same thing to the person: start again.
      return data(
        {
          error:
            "That code has expired or been used too many times. Request a new one.",
          restart: true,
        },
        { status: 400 },
      );
    }

    return redirect("/forgot?done=1", {
      headers: { "set-cookie": clearResetCookie(secure) },
    });
  }

  /* --------------------------------------------------- start over, on request */

  if (intent === "restart") {
    return redirect("/forgot", {
      headers: { "set-cookie": clearResetCookie(secure) },
    });
  }

  return data({ error: "Unrecognised request." }, { status: 400 });
}

export default function Forgot() {
  const { phase, masked } = useLoaderData<typeof loader>();

  if (phase === "done") return <ResetDone />;
  if (phase === "code") return <EnterCode masked={masked!} />;
  return <AskForEmail />;
}

/* ------------------------------------------------------------- step one */

function AskForEmail() {
  const actionData = useActionData<typeof action>();

  return (
    <AccountShell
      title="Reset your password"
      tagline="Enter the email on your account and we'll send a one-time code."
      footer={
        <p className="account-alt">
          Remembered it? <Link to="/login">Sign in</Link>
        </p>
      }
    >
      <Form method="post" className="account-form">
        <input type="hidden" name="intent" value="request" />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <FormError message={actionData?.error ?? null} />
        <button type="submit" className="account-submit">
          Send code
        </button>
      </Form>
    </AccountShell>
  );
}

/* ------------------------------------------------------------- step two */

/**
 * The code screen, on the splash.
 *
 * Same sky, mark and entrance timings as the welcome splash, because this is
 * the other moment the app speaks to someone directly rather than showing them
 * their numbers. The form sits on it rather than following it, so the code goes
 * in on the screen that announced it.
 */
function EnterCode({ masked }: { masked: string }) {
  const actionData = useActionData<typeof action>();

  return (
    <div className="splash welcome-splash">
      <div className="welcome-inner reset-inner">
        <div className="splash-globe">
          <BrandMark size={84} spin />
        </div>

        <h1 className="welcome-word reset-word">
          <span style={{ animationDelay: "0.34s" }}>Your one-time</span>
          <span style={{ animationDelay: "0.45s" }}>authorization code</span>
          <span style={{ animationDelay: "0.56s" }}>has been sent</span>
        </h1>

        <p className="welcome-sub">
          Please enter the code sent to <strong>{masked}</strong>
        </p>

        <Form method="post" className="account-form reset-form">
          <input type="hidden" name="intent" value="reset" />

          <label className="account-field">
            <span className="account-label">Authorization code</span>
            <input
              className="account-input reset-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH + 2}
              placeholder="000000"
              required
              autoFocus
            />
          </label>

          <Field
            label="New password"
            name="password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters."
          />

          <FormError message={actionData?.error ?? null} />

          <button type="submit" className="account-submit">
            Reset password
          </button>
        </Form>

        <Form method="post" className="reset-restart">
          <input type="hidden" name="intent" value="restart" />
          <button type="submit" className="welcome-skip">
            Use a different email
          </button>
        </Form>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- step three */

function ResetDone() {
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hold = reduced ? 1200 : 2600;

    const toFade = window.setTimeout(() => setLeaving(true), hold);
    const toGo = window.setTimeout(
      () => navigate("/login", { replace: true }),
      hold + 320,
    );

    return () => {
      window.clearTimeout(toFade);
      window.clearTimeout(toGo);
    };
  }, [navigate]);

  return (
    <div className={leaving ? "splash welcome-splash out" : "splash welcome-splash"}>
      <div className="welcome-inner">
        <div className="splash-globe">
          <BrandMark size={104} spin />
        </div>

        <h1 className="welcome-word">
          {["Your", "password", "has", "been", "reset!"].map((word, i) => (
            <span key={word} style={{ animationDelay: `${0.34 + i * 0.08}s` }}>
              {word}
            </span>
          ))}
        </h1>

        {/*
          Said plainly, because it is the one consequence a person would not
          predict: the reset ended every session, which is the entire point of
          resetting after someone else has been in the account.
        */}
        <p className="welcome-sub">
          Every device signed in to this account has been signed out. Sign in
          again with your new password.
        </p>

        <button
          type="button"
          className="welcome-skip"
          onClick={() => navigate("/login", { replace: true })}
        >
          Sign in
        </button>
      </div>
    </div>
  );
}
