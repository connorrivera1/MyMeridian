import type { LoaderFunctionArgs } from "react-router";

import confirmedHtml from "../../site/waitlist-confirmed.html?raw";
import { canonicalDeploymentRedirect } from "~/lib/public-origin.server";

const UNSUBSCRIBED = new Response(
  confirmedHtml
    .replaceAll("You’re Early — MyMeridian", "Unsubscribed — MyMeridian")
    .replaceAll("You’re On The MyMeridian Waitlist.", "You are unsubscribed from MyMeridian product updates.")
    .replaceAll("Founding Merchant", "Email Preferences")
    .replaceAll("You’re Early.", "You’re Unsubscribed.")
    .replaceAll("Thanks for joining the MyMeridian waitlist.", "You will no longer receive MyMeridian product updates.")
    .replaceAll("We’ll let you know when early access opens. As a founding merchant, you’ll also be eligible for <strong>15% off your first 12 months on a monthly Meridian plan</strong> when the offer is activated at launch.", "Necessary account and service notices may still be sent when relevant."),
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
);

export function loader({ request }: LoaderFunctionArgs) {
  return canonicalDeploymentRedirect(request) ?? UNSUBSCRIBED.clone();
}
