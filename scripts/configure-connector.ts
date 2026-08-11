/**
 * Operator-only connector credential bootstrap.
 *
 * Secrets are read from environment variables so they do not land in shell
 * history, encrypted with Meridian's AES-GCM envelope, and never printed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadLocalEnvironment() {
  try {
    for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]!]) continue;
      process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // A deployed operator can supply the same values through the environment.
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

loadLocalEnvironment();

const { ConnectorProvider } = await import("@prisma/client");
const prisma = (await import("../app/db.server.js")).default;
const { storeConnectorCredentials } = await import("../app/integrations/ad-health.server.js");

const providerNames = {
  shipstation: ConnectorProvider.SHIPSTATION,
  meta: ConnectorProvider.FACEBOOK_ADS,
  google: ConnectorProvider.GOOGLE_ADS,
  tiktok: ConnectorProvider.TIKTOK_ADS,
} as const;

const shopDomain = argument("--shop")?.trim().toLowerCase();
const providerName = argument("--provider")?.trim().toLowerCase() as keyof typeof providerNames | undefined;
const accessToken = process.env.MERIDIAN_CONNECTOR_TOKEN;
const refreshToken = process.env.MERIDIAN_CONNECTOR_REFRESH_TOKEN || null;
const expiresAtText = argument("--expires-at");
const expiresAt = expiresAtText ? new Date(expiresAtText) : null;
const standby = process.argv.includes("--standby");

if (!shopDomain || !providerName || !providerNames[providerName] || !accessToken) {
  throw new Error(
    "Usage: MERIDIAN_CONNECTOR_TOKEN=<secret> npm run connector:configure -- " +
      "--shop store.myshopify.com --provider shipstation|meta|google|tiktok " +
      "[--standby] [--expires-at ISO-8601]",
  );
}
if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("--expires-at must be a valid ISO-8601 timestamp.");
if (providerName === "shipstation" && standby) {
  throw new Error("ShipStation API keys do not use the ad-token standby promotion flow.");
}

const shop = await prisma.shop.findUnique({ where: { domain: shopDomain }, select: { id: true } });
if (!shop) throw new Error(`No installed Meridian shop matches ${shopDomain}.`);

const connector = await storeConnectorCredentials({
  shopId: shop.id,
  provider: providerNames[providerName],
  accessToken,
  refreshToken,
  expiresAt,
  standby,
});

if (providerName === "shipstation") {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (
    appUrl &&
    !appUrl.includes("shopify.dev/apps/default-app-home") &&
    !appUrl.includes("localhost") &&
    !appUrl.includes("127.0.0.1")
  ) {
    const { ensureShipStationWebhook } = await import("../app/integrations/shipping.server.js");
    await ensureShipStationWebhook(connector, appUrl);
    console.log("ShipStation fulfillment webhook registered for immediate reconciliation.");
  } else {
    console.warn("ShipStation credential stored, but no public SHOPIFY_APP_URL is configured; the five-minute fallback sweep remains active.");
  }
}
await prisma.$disconnect();

console.log(`${providerName} ${standby ? "standby" : "primary"} credential stored for ${shopDomain}; plaintext was not retained.`);
