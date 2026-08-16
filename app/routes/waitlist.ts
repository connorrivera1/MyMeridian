import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import {
  createWaitlistSignup,
  validateWaitlistSubmission,
} from "~/lib/waitlist.server";
import { honeypotTriggered } from "~/lib/form-anti-bot";
import { normalizeEmail } from "~/lib/webauth.server";
import { requestOriginIsSelf } from "~/lib/web-session.server";

/** The form only posts here; its polished confirmation has a dedicated URL. */
export function loader(_args: LoaderFunctionArgs) {
  throw redirect("/#waitlist");
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function action({ request }: ActionFunctionArgs) {
  if (!requestOriginIsSelf(request)) {
    return data({ error: "Your session expired. Return to the waitlist and try again." }, { status: 403 });
  }

  const form = await request.formData();
  // Silent honeypot success prevents an automated form fill from learning
  // which anti-abuse controls fired, while no real contact is written.
  if (honeypotTriggered(form)) throw redirect("/waitlist/confirmed");

  const rawEmail = stringField(form, "email");
  const limited = await firstDeniedRequestLimit({
    request,
    scope: "public-waitlist",
    windowMs: 60 * 60 * 1_000,
    ipLimit: 12,
    subject: normalizeEmail(rawEmail).slice(0, 254),
    subjectLimit: 3,
  });
  if (limited) {
    return data(
      { error: RATE_LIMIT_MESSAGE },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }

  const validated = validateWaitlistSubmission({
    email: rawEmail,
    storeUrl: stringField(form, "store_url"),
    marketingConsent: stringField(form, "marketing_consent") === "true",
    source: stringField(form, "source"),
    utmSource: stringField(form, "utm_source"),
    utmMedium: stringField(form, "utm_medium"),
    utmCampaign: stringField(form, "utm_campaign"),
    utmTerm: stringField(form, "utm_term"),
    utmContent: stringField(form, "utm_content"),
  });
  if (!validated.ok) {
    // Avoid exposing any database state. The only specific feedback is about
    // the caller's own malformed input, and the visitor returns to the form.
    throw redirect("/?waitlist=check-details#waitlist");
  }

  await createWaitlistSignup(validated.value);
  // Intentionally identical for a new row and an existing email: no account
  // or waitlist membership oracle is exposed from this public endpoint.
  throw redirect("/waitlist/confirmed");
}
