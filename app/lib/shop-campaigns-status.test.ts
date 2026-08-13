import { ConnectorStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  SHOP_CAMPAIGNS_PROTECTED_DATA_ERROR,
  SHOP_CAMPAIGNS_REPORT_ACCESS_ERROR,
} from "~/lib/shop-campaigns.server";
import { classifyShopCampaignsSource } from "./shop-campaigns-status.server";

const connected = {
  status: ConnectorStatus.CONNECTED,
  lastSyncedAt: new Date("2026-08-12T12:00:00Z"),
  lastError: null,
};

describe("Shop Campaigns source status", () => {
  it("distinguishes no Shop Campaign rows from an observed zero-spend row", () => {
    expect(
      classifyShopCampaignsSource({
        reportsGranted: true,
        connector: connected,
        hasSpendInRange: false,
        hasRowsInRange: false,
      }),
    ).toBe("empty");
    expect(
      classifyShopCampaignsSource({
        reportsGranted: true,
        connector: connected,
        hasSpendInRange: false,
        hasRowsInRange: true,
      }),
    ).toBe("zero");
  });

  it("does not turn missing scope or Shopify approval into a zero", () => {
    expect(
      classifyShopCampaignsSource({
        reportsGranted: false,
        connector: connected,
        hasSpendInRange: false,
        hasRowsInRange: false,
      }),
    ).toBe("needs_reports");
    expect(
      classifyShopCampaignsSource({
        reportsGranted: true,
        connector: {
          ...connected,
          status: ConnectorStatus.ERROR,
          lastError: SHOP_CAMPAIGNS_PROTECTED_DATA_ERROR,
        },
        hasSpendInRange: false,
        hasRowsInRange: false,
      }),
    ).toBe("needs_approval");
    expect(
      classifyShopCampaignsSource({
        reportsGranted: true,
        connector: {
          ...connected,
          status: ConnectorStatus.ERROR,
          lastError: SHOP_CAMPAIGNS_REPORT_ACCESS_ERROR,
        },
        hasSpendInRange: false,
        hasRowsInRange: false,
      }),
    ).toBe("needs_reports");
  });

  it("shows a first sync as unavailable input until it completes", () => {
    expect(
      classifyShopCampaignsSource({
        reportsGranted: true,
        connector: { ...connected, lastSyncedAt: null },
        hasSpendInRange: false,
        hasRowsInRange: false,
      }),
    ).toBe("syncing");
  });

  it("does not call a connector that has not been configured an in-progress sync", () => {
    expect(
      classifyShopCampaignsSource({
        reportsGranted: true,
        connector: {
          ...connected,
          status: ConnectorStatus.NOT_CONFIGURED,
          lastSyncedAt: null,
        },
        hasSpendInRange: false,
        hasRowsInRange: false,
      }),
    ).toBe("unavailable");
  });
});
