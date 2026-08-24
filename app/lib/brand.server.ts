import type { ContactDetails } from "./brand";

/**
 * The contact details Shopify's listing requirements and the privacy policy
 * both need.
 *
 * Environment-driven rather than hardcoded so the public routes always render
 * the support contact configured for this deployment.
 */
export function contactDetails(): ContactDetails {
  const supportEmail = process.env.MERIDIAN_SUPPORT_EMAIL?.trim() || "";
  const supportUrl = process.env.MERIDIAN_SUPPORT_URL?.trim() || "";
  return {
    supportEmail,
    supportUrl,
    complete: Boolean(supportEmail),
  };
}
