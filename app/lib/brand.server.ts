import type { ContactDetails } from "./brand";

/**
 * The contact details Shopify's listing requirements and the privacy policy
 * both need.
 *
 * Environment-driven rather than hardcoded because this is the one part of a
 * submission that cannot be inferred from the code — the address a merchant
 * emails has to be a mailbox someone actually reads. Anything left empty here
 * renders as an explicit gap on `/privacy` and `/support` rather than as a
 * plausible-looking address that bounces.
 */
export function contactDetails(): ContactDetails {
  const supportEmail = process.env.MERIDIAN_SUPPORT_EMAIL ?? "";
  const supportUrl = process.env.MERIDIAN_SUPPORT_URL ?? "";
  const legalEntity = process.env.MERIDIAN_LEGAL_ENTITY ?? "";

  return {
    supportEmail,
    supportUrl,
    legalEntity,
    complete: Boolean(supportEmail && legalEntity),
  };
}
