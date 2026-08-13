import { ConnectorProvider, ConnectorStatus } from "@prisma/client";

import prisma from "~/db.server";
import {
  SHOP_CAMPAIGNS_PROTECTED_DATA_ERROR,
  SHOP_CAMPAIGNS_REPORT_ACCESS_ERROR,
} from "~/lib/shop-campaigns.server";

export type ShopCampaignsState =
  | "measured"
  | "zero"
  | "empty"
  | "syncing"
  | "needs_approval"
  | "needs_reports"
  | "unavailable";

export interface ShopCampaignsSourceInput {
  reportsGranted: boolean;
  connector:
    | {
        status: ConnectorStatus;
        lastSyncedAt: Date | null;
        lastError: string | null;
      }
    | null;
  hasSpendInRange: boolean;
  hasRowsInRange: boolean;
}

/**
 * Source availability is intentionally different from a monetary zero. A
 * completed ShopifyQL sync can truthfully say there was no Shop Campaign spend
 * in a selected window; a missing scope or Level 2 approval cannot.
 */
export function classifyShopCampaignsSource(
  input: ShopCampaignsSourceInput,
): ShopCampaignsState {
  if (!input.reportsGranted) return "needs_reports";
  if (!input.connector) return "unavailable";
  if (
    input.connector.status === ConnectorStatus.NOT_CONFIGURED ||
    input.connector.status === ConnectorStatus.DISCONNECTED
  ) {
    return "unavailable";
  }
  if (
    input.connector.lastError?.startsWith(
      SHOP_CAMPAIGNS_PROTECTED_DATA_ERROR,
    )
  ) {
    return "needs_approval";
  }
  if (
    input.connector.lastError?.startsWith(SHOP_CAMPAIGNS_REPORT_ACCESS_ERROR)
  ) {
    return "needs_reports";
  }
  if (input.connector.lastSyncedAt === null) return "syncing";
  if (input.hasSpendInRange) return "measured";
  return input.hasRowsInRange ? "zero" : "empty";
}

export async function loadShopCampaignsSource(
  shopId: string,
  reportsGranted: boolean,
  hasSpendInRange: boolean,
  hasRowsInRange: boolean,
): Promise<ShopCampaignsState> {
  const connector = await prisma.connector.findUnique({
    where: {
      shopId_provider: {
        shopId,
        provider: ConnectorProvider.SHOPIFY_SHOP_CAMPAIGNS,
      },
    },
    select: { status: true, lastSyncedAt: true, lastError: true },
  });
  return classifyShopCampaignsSource({
    reportsGranted,
    connector,
    hasSpendInRange,
    hasRowsInRange,
  });
}
