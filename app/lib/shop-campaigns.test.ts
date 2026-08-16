import { describe, expect, it } from "vitest";

import {
  isShopCampaignsProtectedDataError,
  isShopCampaignsReportsAccessError,
  parseShopCampaignRows,
  shopCampaignId,
  shopCampaignsQueryForDay,
} from "./shop-campaigns.server";

describe("Shopify Shop Campaigns ShopifyQL adapter", () => {
  it("uses the documented aggregate schema and one stable daily replacement unit", () => {
    expect(shopCampaignsQueryForDay("2026-08-12")).toBe(
      "FROM shop_campaign_insights SHOW shop_campaign_ad_spend, shop_campaign_sales, shop_campaign_customers GROUP BY shop_campaign_name TIMESERIES day SINCE 2026-08-12 UNTIL 2026-08-12 ORDER BY day ASC LIMIT 1000",
    );
  });

  it("normalizes active campaign metrics without treating Shopify sales as orders or refund-adjusted revenue", () => {
    const rows = parseShopCampaignRows({
      data: {
        shopifyqlQuery: {
          tableData: {
            rows: [
              {
                day: "2026-08-12",
                shop_campaign_name: "Autumn prospecting",
                shop_campaign_ad_spend: "23.45",
                shop_campaign_sales: "167.00",
                shop_campaign_customers: 4,
              },
            ],
          },
        },
      },
    });

    expect(rows).toEqual([
      {
        campaignId: shopCampaignId("Autumn prospecting"),
        campaignName: "Autumn prospecting",
        spend: "23.45",
        impressions: 0,
        clicks: 0,
        conversions: 4,
        revenue: "167.00",
      },
    ]);
    // Shopify documents `shop_campaign_sales` as refund-excluded. There is no
    // refund field in this aggregate report, so Meridian must retain the
    // source value and leave refund-aware revenue to its own order ledger.
    expect(rows[0]?.revenue).toBe("167.00");
  });

  it("retains a real zero-spend campaign row rather than erasing it as missing", () => {
    expect(
      parseShopCampaignRows({
        data: {
          shopifyqlQuery: {
            tableData: {
              rows: [
                {
                  shop_campaign_name: "Paused campaign",
                  shop_campaign_ad_spend: 0,
                  shop_campaign_sales: 0,
                  shop_campaign_customers: 0,
                },
              ],
            },
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({ spend: "0.00", revenue: "0.00", conversions: 0 }),
    ]);
  });

  it("makes source access errors actionable and does not accept malformed days", () => {
    expect(() => shopCampaignsQueryForDay("yesterday")).toThrow(/ISO calendar/);
    expect(
      isShopCampaignsProtectedDataError(
        new Error("Level 2 protected customer data is not approved; request access"),
      ),
    ).toBe(true);
    expect(
      isShopCampaignsReportsAccessError(new Error("read_reports access scope is required")),
    ).toBe(true);
  });
});
