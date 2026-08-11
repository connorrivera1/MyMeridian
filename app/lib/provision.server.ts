import {
  CostRuleKind,
  CostRuleOrigin,
  ConnectorProvider,
  ConnectorStatus,
  SyncStatus,
} from "@prisma/client";

import prisma from "~/db.server";
import { parseScopes } from "~/lib/scopes";

/**
 * Default cost assumptions applied at install time.
 *
 * These are deliberately conservative industry defaults rather than zeroes: a
 * dashboard that shows 100% margin on day one because nobody has entered a
 * shipping cost yet teaches the merchant to distrust it. Every default is
 * labelled as an estimate in the UI until the merchant confirms it.
 */
const DEFAULT_COST_RULES = [
  {
    kind: CostRuleKind.PAYMENT_FEE,
    label: "Shopify Payments (US online rate)",
    percentRate: "0.029",
    fixedPerOrder: "0.30",
    fixedPerItem: null,
    monthlyAmount: null,
  },
  {
    kind: CostRuleKind.SHIPPING_DEFAULT,
    label: "Estimated outbound shipping",
    percentRate: null,
    fixedPerOrder: "8.50",
    fixedPerItem: null,
    monthlyAmount: null,
  },
  {
    kind: CostRuleKind.PICK_PACK,
    label: "Pick, pack and materials",
    percentRate: null,
    fixedPerOrder: "1.75",
    fixedPerItem: "0.35",
    monthlyAmount: null,
  },
  {
    kind: CostRuleKind.OVERHEAD_MONTHLY,
    label: "Fixed monthly overhead",
    percentRate: null,
    fixedPerOrder: null,
    fixedPerItem: null,
    monthlyAmount: "0",
  },
] as const;

/**
 * The connector rows every store gets at install.
 *
 * One entry per `ConnectorProvider` in the schema, and a test holds it to that.
 * `TIKTOK_ADS` was in the enum, labelled on the Settings screen, given a purpose
 * string, and created by the seed — but never created here. So the demo store
 * showed a TikTok Ads row and a real install showed nothing at all: not
 * "Not configured", not an error, just one ad channel silently absent from the
 * table while the engine went on computing TikTok CAC and ROAS beside it. Same
 * shape as the listing copy that sold channels the app cannot connect, one
 * layer down.
 *
 * Ad and payment providers start `NOT_CONFIGURED` because they are — none has
 * an OAuth flow yet, and a row saying so is the honest version of that.
 */
function initialConnectors(domain: string) {
  return [
    {
      provider: ConnectorProvider.SHOPIFY,
      status: ConnectorStatus.CONNECTED,
      displayName: domain,
      lastSyncedAt: new Date(),
    },
    {
      provider: ConnectorProvider.FACEBOOK_ADS,
      status: ConnectorStatus.NOT_CONFIGURED,
    },
    {
      provider: ConnectorProvider.GOOGLE_ADS,
      status: ConnectorStatus.NOT_CONFIGURED,
    },
    {
      provider: ConnectorProvider.TIKTOK_ADS,
      status: ConnectorStatus.NOT_CONFIGURED,
    },
    {
      provider: ConnectorProvider.STRIPE,
      status: ConnectorStatus.NOT_CONFIGURED,
    },
    {
      provider: ConnectorProvider.WAREHOUSE_3PL,
      status: ConnectorStatus.NOT_CONFIGURED,
    },
    {
      provider: ConnectorProvider.SHIPSTATION,
      status: ConnectorStatus.NOT_CONFIGURED,
    },
    {
      provider: ConnectorProvider.SHOPIFY_SHIPPING,
      status: ConnectorStatus.NOT_CONFIGURED,
    },
  ];
}

/** Shopify Shipping needs no second credential, but its cost schema is gated. */
export async function synchroniseShopifyShippingConnector(
  shopId: string,
  grantedScopes: string | null | undefined,
) {
  const connected = parseScopes(grantedScopes).has("read_reports");
  return prisma.connector.upsert({
    where: {
      shopId_provider: { shopId, provider: ConnectorProvider.SHOPIFY_SHIPPING },
    },
    create: {
      shopId,
      provider: ConnectorProvider.SHOPIFY_SHIPPING,
      status: connected ? ConnectorStatus.CONNECTED : ConnectorStatus.NOT_CONFIGURED,
      displayName: "Shopify Shipping",
      lastError: connected
        ? null
        : "read_reports is not granted; shipping-label cost reconciliation is unavailable.",
    },
    update: {
      status: connected ? ConnectorStatus.CONNECTED : ConnectorStatus.DISCONNECTED,
      displayName: "Shopify Shipping",
      lastError: connected
        ? null
        : "read_reports was revoked; shipping-label cost reconciliation is paused.",
    },
  });
}

export async function ensureShopProvisioned(domain: string, name?: string) {
  const existing = await prisma.shop.findUnique({ where: { domain } });
  if (existing) {
    if (existing.uninstalledAt) {
      // Webhook subscriptions die with the install, so nothing that happened
      // while the app was uninstalled exists anywhere — no orders, no refunds,
      // no product changes. Leaving syncStatus as COMPLETE meant afterAuth's
      // `alreadyImported` check skipped the backfill, and the merchant came
      // back to a dashboard that loaded perfectly while silently missing every
      // sale from the gap. Reset it so the import runs again on reinstall.
      // A store installed before a provider existed has no row for it. Done on
      // this path rather than on every call: `ensureShopProvisioned` runs on
      // every authenticated request, and reinstall is already a write.
      await prisma.connector.createMany({
        data: initialConnectors(domain).map((connector) => ({
          ...connector,
          shopId: existing.id,
        })),
        skipDuplicates: true,
      });

      return prisma.shop.update({
        where: { id: existing.id },
        data: {
          uninstalledAt: null,
          installedAt: new Date(),
          syncStatus: SyncStatus.PENDING,
        },
      });
    }
    return existing;
  }

  const shop = await prisma.shop.create({
    data: {
      domain,
      name: name ?? domain.replace(".myshopify.com", ""),
      costRules: {
        create: DEFAULT_COST_RULES.map((rule) => ({
          kind: rule.kind,
          label: rule.label,
          percentRate: rule.percentRate,
          fixedPerOrder: rule.fixedPerOrder,
          fixedPerItem: rule.fixedPerItem,
          monthlyAmount: rule.monthlyAmount,
          origin: CostRuleOrigin.INSTALL_DEFAULT,
          confirmedAt: null,
        })),
      },
      connectors: { create: initialConnectors(domain) },
    },
  });

  return shop;
}
