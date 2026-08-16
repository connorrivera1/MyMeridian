import type { LoaderFunctionArgs } from "react-router";

import confirmedHtml from "../../site/waitlist-confirmed.html?raw";
import { canonicalDeploymentRedirect } from "~/lib/public-origin.server";

const unsubscribedHtml = confirmedHtml
  .replaceAll("You’re Early — MyMeridian", "Unsubscribed — MyMeridian")
  .replaceAll(
    "You’re On The MyMeridian Waitlist.",
    "You Are Unsubscribed From MyMeridian Product Updates.",
  )
  .replaceAll("Founding Merchant", "Email Preferences")
  .replaceAll("You’re Early.", "You’re Unsubscribed.")
  .replaceAll(
    "Thanks for joining the MyMeridian waitlist.",
    "You will no longer receive MyMeridian product updates.",
  )
  .replaceAll(
    "We’ll let you know when early access opens. As a founding merchant, you’ll also be eligible for <strong>15% off your first 12 months on a monthly Meridian plan</strong> when the offer is activated at launch.",
    "Necessary account and service notices may still be sent when relevant.",
  );

async function unsubscribedResponse(): Promise<Response> {
  const { addPublicDocumentSecurityHeadersForHtml } = await import(
    "~/lib/public-document-security.server"
  );
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  addPublicDocumentSecurityHeadersForHtml(headers, confirmedHtml);
  return new Response(unsubscribedHtml, {
    headers,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return canonicalDeploymentRedirect(request) ?? (await unsubscribedResponse());
}
