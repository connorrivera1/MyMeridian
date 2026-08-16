/**
 * Client-safe brand constants. Anything that reads `process.env` lives in
 * `brand.server.ts` instead — a route that renders these also ships them to the
 * browser, and `process` does not exist there.
 */
export const APP_NAME = "MyMeridian";

/**
 * Last substantive change to the privacy policy. Bumped by hand: Shopify's
 * review reads the date, and deriving it from the build clock would make every
 * deploy look like a policy change.
 */
export const PRIVACY_UPDATED = "12 August 2026";

export interface ContactDetails {
  supportEmail: string;
  supportUrl: string;
  legalEntity: string;
  /** True when every field a Shopify listing requires is filled in. */
  complete: boolean;
}
