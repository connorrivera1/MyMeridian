/**
 * The staging Shopify app's public client id. This is intentionally not a
 * secret — Shopify exposes client ids in OAuth authorization URLs — but it is
 * an effective production safety interlock. A production Fly process must
 * never start with the staging app identity.
 *
 * Keep this synchronized with shopify.app.staging.toml. The corresponding
 * test makes a drift explicit during CI.
 */
export const STAGING_SHOPIFY_CLIENT_ID = "9dfbe484752628b0a96c4755caf4f502";

export function validateProductionShopifyClient(
  env: NodeJS.ProcessEnv = process.env,
) {
  const origin = env.SHOPIFY_APP_URL?.trim();
  if (origin !== "https://mymeridian.io") return;
  if (env.SHOPIFY_API_KEY?.trim() === STAGING_SHOPIFY_CLIENT_ID) {
    throw new Error(
      "Production refuses the staging Shopify client id. Configure the separately issued production public-app credentials.",
    );
  }
}
