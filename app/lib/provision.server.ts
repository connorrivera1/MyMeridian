import {
  CostRuleKind,
  ConnectorProvider,
  ConnectorStatus,
  SyncStatus,
} from "@prisma/client";

import prisma from "~/db.server";

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
        })),
      },
      connectors: {
        create: [
          {
            provider: ConnectorProvider.SHOPIFY,
            status: ConnectorStatus.CONNECTED,
            displayName: domain,
            lastSyncedAt: new Date(),
          },
          { provider: ConnectorProvider.FACEBOOK_ADS, status: ConnectorStatus.NOT_CONFIGURED },
          { provider: ConnectorProvider.GOOGLE_ADS, status: ConnectorStatus.NOT_CONFIGURED },
          { provider: ConnectorProvider.STRIPE, status: ConnectorStatus.NOT_CONFIGURED },
          { provider: ConnectorProvider.WAREHOUSE_3PL, status: ConnectorStatus.NOT_CONFIGURED },
        ],
      },
    },
  });

  return shop;
}
