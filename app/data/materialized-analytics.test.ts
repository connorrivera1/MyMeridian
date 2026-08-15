import { Decimal } from "@prisma/client/runtime/library";
import { describe, expect, it } from "vitest";

import {
  productProfitFromRollup,
  rollupMaterializedProfits,
  toMaterializedOrderProfit,
  type MaterializedOrder,
} from "./materialized-analytics.server";

const money = (value: string | number) => new Decimal(value);

function row(overrides: Partial<MaterializedOrder> = {}): MaterializedOrder {
  return {
    id: "order_1",
    orderNumber: 1001,
    processedAt: new Date("2026-08-10T12:00:00.000Z"),
    customerId: null,
    channel: "DIRECT",
    campaignId: null,
    isFirstOrder: false,
    subtotal: money(100),
    discountTotal: money(0),
    shippingCharged: money(10),
    total: money(118),
    taxTotal: money(8),
    refundedTotal: money(0),
    returnFeesRetained: money(0),
    cogsTotal: money(30),
    adCostAttributed: money(5),
    overheadAllocated: money(4),
    contributionProfit: money(55),
    netProfit: money(51),
    materializedPaymentFee: money(3),
    materializedPickPackCost: money(2),
    materializedOutboundShippingCost: money(5),
    materializedReturnShippingCost: money(0),
    materializedUnits: 2,
    materializedMissingCogs: false,
    materializedModeledCosts: true,
    ...overrides,
  };
}

describe("large-window materialized analytics", () => {
  it("reconstructs the exact engine identity without line-item hydration", () => {
    const profit = toMaterializedOrderProfit(row());
    expect(profit.netRevenueCents).toBe(10_000);
    expect(profit.totalCostCents).toBe(4_900);
    expect(profit.contributionProfitCents).toBe(5_500);
    expect(profit.netProfitCents).toBe(5_100);
    expect(profit.usesModeledCosts).toBe(true);
  });

  it("keeps unattributed platform spend in period net profit", () => {
    const profit = toMaterializedOrderProfit(row());
    const period = rollupMaterializedProfits([profit], [
      {
        date: new Date("2026-08-10"),
        channel: "FACEBOOK",
        campaignId: null,
        campaignName: null,
        spendCents: 800,
        impressions: 0,
        clicks: 0,
        platformConversions: 0,
        platformRevenueCents: 0,
      },
    ]);
    expect(period.attributedAdCostCents).toBe(500);
    expect(period.unattributedAdCostCents).toBe(300);
    expect(period.netProfitCents).toBe(4_800);
  });

  it("includes return shipping in materialized product contribution", () => {
    const product = productProfitFromRollup(
      {
        productId: "product_1",
        title: "Returned Jacket",
        imageUrl: null,
        productType: null,
        vendor: null,
        units: 1n,
        ordersContaining: 1n,
        grossRevenue: money(100),
        discount: money(10),
        netRevenue: money(95),
        cogs: money(30),
        shipping: money(0),
        payment: money(0),
        pickPack: money(0),
        adCost: money(0),
        returnShipping: money(3),
        missingCogs: false,
        modeledCosts: false,
      },
      1,
      9_500,
    );

    expect(product.allocatedReturnShippingCents).toBe(300);
    expect(product.contributionProfitCents).toBe(6_200);
    expect(product.revenueSharePct).toBe(1);
  });
});
