import type { ContactDetails } from "./brand";

/**
 * The contact details Shopify's listing requirements and the privacy policy
 * both need.
 *
 * Environment-driven rather than hardcoded because the support identity must
 * belong to Meridian's eventual publisher. Until that is selected, the public
 * routes say plainly that contact is not configured instead of borrowing an
 * unrelated brand's details.
 */
export function contactDetails(): ContactDetails {
  const supportEmail = process.env.MERIDIAN_SUPPORT_EMAIL?.trim() || "";
  const supportUrl = process.env.MERIDIAN_SUPPORT_URL?.trim() || "";
  const legalEntity = process.env.MERIDIAN_LEGAL_ENTITY?.trim() || "";

  return {
    supportEmail,
    supportUrl,
    legalEntity,
    complete: Boolean(supportEmail && legalEntity),
  };
}
