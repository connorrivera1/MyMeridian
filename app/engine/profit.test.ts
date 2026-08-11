import { describe, expect, it } from "vitest";

import {
  allocateOverhead,
  attributeAdSpend,
  computeOrderProfit,
  computeProfitForPeriod,
  dayKey,
} from "./profit";
import type { AdSpendRow, CostRuleSet, EngineOrder } from "./types";

const RULES: CostRuleSet = {
  paymentPercentRate: 0.029,
  paymentFixedPerOrderCents: 30,
  shippingDefaultPerOrderCents: 850,
  pickPackPerOrderCents: 175,
  pickPackPerItemCents: 35,
  monthlyOverheadCents: 0,
  provenance: {
    paymentFee: { origin: "INSTALL_DEFAULT", confirmed: true },
    shippingDefault: { origin: "INSTALL_DEFAULT", confirmed: true },
    pickPack: { origin: "INSTALL_DEFAULT", confirmed: true },
    monthlyOverhead: { origin: "INSTALL_DEFAULT", confirmed: true },
  },
};

const TZ = "America/New_York";

function makeOrder(overrides: Partial<EngineOrder> = {}): EngineOrder {
  return {
    id: "order-1",
    orderNumber: 1001,
    processedAt: new Date("2026-03-10T15:00:00Z"),
    customerId: "cust-1",
    channel: "FACEBOOK",
    campaignId: null,
    isFirstOrder: true,
    subtotalCents: 9000,
    discountTotalCents: 500,
    shippingChargedCents: 500,
    taxTotalCents: 700,
    totalCents: 9700,
    refundedTotalCents: 0,
    actualShippingCostCents: null,
    actualPickPackCostCents: null,
    lineItems: [
      {
        id: "li-1",
        productId: "prod-a",
        variantId: "var-a",
        title: "Item A",
        quantity: 2,
        refundedQty: 0,
        unitPriceCents: 2500,
        discountCents: 0,
        unitCostMicros: 80_000, // $8.0000
      },
      {
        id: "li-2",
        productId: "prod-b",
        variantId: "var-b",
        title: "Item B",
        quantity: 1,
        refundedQty: 0,
        unitPriceCents: 4000,
        discountCents: 500,
        unitCostMicros: 155_000, // $15.5000
      },
    ],
    ...overrides,
  };
}

describe("computeOrderProfit", () => {
  it("computes a worked example exactly", () => {
    const profit = computeOrderProfit(makeOrder(), RULES);

    // COGS: 2 x $8.00 + 1 x $15.50
    expect(profit.cogsCents).toBe(3150);
    expect(profit.units).toBe(3);

    // Net revenue excludes tax entirely: 90.00 - 5.00 + 5.00
    expect(profit.netRevenueCents).toBe(9000);

    expect(profit.shippingCostCents).toBe(850);
    expect(profit.pickPackCents).toBe(280); // 175 + 3 x 35
    expect(profit.paymentFeeCents).toBe(311); // 2.9% of 9700, + 30

    expect(profit.contributionProfitCents).toBe(4409);
    expect(profit.netProfitCents).toBe(4409);
    expect(profit.contributionMarginPct).toBeCloseTo(0.4899, 4);
  });

  it("never counts sales tax as revenue", () => {
    const withTax = computeOrderProfit(
      makeOrder({ taxTotalCents: 5000 }),
      RULES,
    );
    const withoutTax = computeOrderProfit(
      makeOrder({ taxTotalCents: 0 }),
      RULES,
    );

    expect(withTax.netRevenueCents).toBe(withoutTax.netRevenueCents);
  });

  it("removes both revenue and COGS for refunded units", () => {
    const order = makeOrder({
      refundedTotalCents: 2500,
      lineItems: makeOrder().lineItems.map((item, i) =>
        i === 0 ? { ...item, refundedQty: 1 } : item,
      ),
    });

    const profit = computeOrderProfit(order, RULES);

    expect(profit.units).toBe(2);
    expect(profit.cogsCents).toBe(800 + 1550);
    // $25.00 refunded gross; the ex-tax share is 9000/9700 of that = $23.20.
    expect(profit.refundCents).toBe(2320);
    expect(profit.netRevenueCents).toBe(9000 - 2320);
  });

  it("subtracts only the ex-tax share of a refund from ex-tax revenue", () => {
    // Fully refunded: $97.00 back, of which $7.00 was tax.
    const profit = computeOrderProfit(
      makeOrder({ refundedTotalCents: 9700 }),
      RULES,
    );

    // The $90.00 of actual revenue is reversed, not $97.00.
    expect(profit.refundCents).toBe(9000);
    expect(profit.netRevenueCents).toBe(0);
  });

  it("reports no margin rather than a nonsense one on a fully refunded order", () => {
    const profit = computeOrderProfit(
      makeOrder({ refundedTotalCents: 9700 }),
      RULES,
    );

    expect(profit.netRevenueCents).toBe(0);
    expect(profit.netMarginPct).toBeNull();
    expect(profit.contributionMarginPct).toBeNull();
    // The costs are still real, so the order is still a loss.
    expect(profit.netProfitCents).toBeLessThan(0);
  });

  it("handles a partial refund proportionally", () => {
    // Half the order refunded: $48.50 of $97.00, $3.50 of it tax.
    const profit = computeOrderProfit(
      makeOrder({ refundedTotalCents: 4850 }),
      RULES,
    );

    expect(profit.refundCents).toBe(4500);
    expect(profit.netRevenueCents).toBe(4500);
    expect(profit.netMarginPct).not.toBeNull();
  });

  it("charges processor fees on the original total, as processors actually do", () => {
    // Stripe and Shopify Payments do not return fees when you refund an order.
    const refunded = computeOrderProfit(
      makeOrder({ refundedTotalCents: 9700 }),
      RULES,
    );
    const notRefunded = computeOrderProfit(makeOrder(), RULES);

    expect(refunded.paymentFeeCents).toBe(notRefunded.paymentFeeCents);
  });

  it("applies a merchant's custom processing structure to a partial refund", () => {
    const customRules: CostRuleSet = {
      ...RULES,
      paymentPercentRate: 0.035,
      paymentFixedPerOrderCents: 49,
    };
    const order = makeOrder({ refundedTotalCents: 4850 });

    const profit = computeOrderProfit(order, customRules);

    // The $48.50 refund reverses $45.00 of ex-tax revenue, but the processor
    // keeps its 3.5% + $0.49 fee on the original $97.00 capture.
    expect(profit.refundCents).toBe(4500);
    expect(profit.netRevenueCents).toBe(4500);
    expect(profit.paymentFeeCents).toBe(389);
  });

  it("uses custom merchant fee structures exactly, including a zero fixed fee", () => {
    const customRules: CostRuleSet = {
      ...RULES,
      paymentPercentRate: 0.0175,
      paymentFixedPerOrderCents: 0,
    };

    const profit = computeOrderProfit(makeOrder(), customRules);

    // 1.75% of the $97.00 captured total, rounded to the nearest cent.
    expect(profit.paymentFeeCents).toBe(170);
    expect(profit.netProfitCents).toBe(4409 + 311 - 170);
  });

  it("prefers real fulfilment costs over default estimates", () => {
    const measuredRules: CostRuleSet = {
      ...RULES,
      paymentPercentRate: 0,
      paymentFixedPerOrderCents: 0,
    };
    const profit = computeOrderProfit(
      makeOrder({
        actualShippingCostCents: 1200,
        actualPickPackCostCents: 400,
      }),
      measuredRules,
    );

    expect(profit.shippingCostCents).toBe(1200);
    expect(profit.pickPackCents).toBe(400);
    expect(profit.hasMissingCogs).toBe(false);
    expect(profit.usesModeledCosts).toBe(false);
    expect(profit.usesEstimatedCosts).toBe(false);
  });

  it("flags missing product cost independently of confirmed defaults", () => {
    const noCogs = makeOrder({
      lineItems: makeOrder().lineItems.map((i) => ({
        ...i,
        unitCostMicros: 0,
      })),
    });
    const profit = computeOrderProfit(noCogs, RULES);
    expect(profit.hasMissingCogs).toBe(true);
    expect(profit.usesEstimatedCosts).toBe(true);
  });

  it("flags a reviewed payment-fee model even with measured fulfilment", () => {
    const rules: CostRuleSet = {
      ...RULES,
      provenance: {
        ...RULES.provenance,
        paymentFee: { origin: "INSTALL_DEFAULT", confirmed: true },
      },
    };
    const order = makeOrder({
      actualShippingCostCents: 1200,
      actualPickPackCostCents: 400,
    });

    const profit = computeOrderProfit(order, rules);
    expect(profit.hasMissingCogs).toBe(false);
    expect(profit.usesModeledCosts).toBe(true);
    expect(profit.usesEstimatedCosts).toBe(true);
  });

  it("flags reviewed fulfilment fallbacks only when the order uses them", () => {
    const rules: CostRuleSet = {
      ...RULES,
      paymentPercentRate: 0,
      paymentFixedPerOrderCents: 0,
      provenance: {
        ...RULES.provenance,
        shippingDefault: { origin: "INSTALL_DEFAULT", confirmed: true },
        pickPack: { origin: "INSTALL_DEFAULT", confirmed: true },
      },
    };

    expect(computeOrderProfit(makeOrder(), rules).usesEstimatedCosts).toBe(
      true,
    );
    expect(
      computeOrderProfit(
        makeOrder({
          actualShippingCostCents: 1200,
          actualPickPackCostCents: 400,
        }),
        rules,
      ).usesEstimatedCosts,
    ).toBe(false);
  });

  it("flags non-zero reviewed overhead across every order in its month", () => {
    const rules: CostRuleSet = {
      ...RULES,
      paymentPercentRate: 0,
      paymentFixedPerOrderCents: 0,
      shippingDefaultPerOrderCents: 0,
      pickPackPerOrderCents: 0,
      pickPackPerItemCents: 0,
      monthlyOverheadCents: 1,
      provenance: {
        ...RULES.provenance,
        monthlyOverhead: { origin: "INSTALL_DEFAULT", confirmed: true },
      },
    };

    // The individual allocation can round to zero; the headline still rests
    // on the modelled monthly amount.
    expect(
      computeOrderProfit(makeOrder(), rules, 0, 0).usesEstimatedCosts,
    ).toBe(true);
  });

  it("does not flag zero-value fallbacks even when they are unconfirmed", () => {
    const zeroRules: CostRuleSet = {
      ...RULES,
      paymentPercentRate: 0,
      paymentFixedPerOrderCents: 0,
      shippingDefaultPerOrderCents: 0,
      pickPackPerOrderCents: 0,
      pickPackPerItemCents: 0,
      provenance: {
        paymentFee: { origin: "INSTALL_DEFAULT", confirmed: false },
        shippingDefault: { origin: "INSTALL_DEFAULT", confirmed: false },
        pickPack: { origin: "INSTALL_DEFAULT", confirmed: false },
        monthlyOverhead: { origin: "INSTALL_DEFAULT", confirmed: false },
      },
    };

    expect(
      computeOrderProfit(makeOrder({ lineItems: [] }), zeroRules)
        .usesEstimatedCosts,
    ).toBe(false);
  });

  it("reports a null margin rather than dividing by zero", () => {
    const free = makeOrder({
      subtotalCents: 0,
      discountTotalCents: 0,
      shippingChargedCents: 0,
      totalCents: 0,
      lineItems: [],
    });

    expect(computeOrderProfit(free, RULES).contributionMarginPct).toBeNull();
  });

  it("subtracts attributed ad spend and overhead", () => {
    const profit = computeOrderProfit(makeOrder(), RULES, 1500, 250);

    expect(profit.contributionProfitCents).toBe(4409 - 1500);
    expect(profit.netProfitCents).toBe(4409 - 1500 - 250);
  });
});

describe("attributeAdSpend", () => {
  const spendRow = (over: Partial<AdSpendRow> = {}): AdSpendRow => ({
    date: new Date("2026-03-10T12:00:00Z"),
    channel: "FACEBOOK",
    campaignId: null,
    campaignName: null,
    spendCents: 10_000,
    impressions: 1000,
    clicks: 50,
    platformConversions: 2,
    platformRevenueCents: 20_000,
    ...over,
  });

  it("splits a day's channel spend equally across that channel's orders", () => {
    const orders = [
      makeOrder({ id: "a" }),
      makeOrder({ id: "b" }),
      makeOrder({ id: "c" }),
    ];

    const result = attributeAdSpend(orders, [spendRow()], TZ);

    expect(result.byOrderId.get("a")).toBe(3334);
    expect(result.byOrderId.get("b")).toBe(3333);
    expect(result.byOrderId.get("c")).toBe(3333);
    expect(result.unattributedCents).toBe(0);
  });

  it("does not value-weight — a bigger basket does not carry more ad cost", () => {
    const orders = [
      makeOrder({ id: "small", subtotalCents: 1000, totalCents: 1000 }),
      makeOrder({ id: "large", subtotalCents: 90_000, totalCents: 90_000 }),
    ];

    const result = attributeAdSpend(orders, [spendRow()], TZ);

    expect(result.byOrderId.get("small")).toBe(5000);
    expect(result.byOrderId.get("large")).toBe(5000);
  });

  it("keeps spend on zero-order days instead of silently dropping it", () => {
    const orders = [makeOrder({ id: "a" })];
    const spend = [
      spendRow(),
      spendRow({ date: new Date("2026-03-11T12:00:00Z"), spendCents: 7500 }),
    ];

    const result = attributeAdSpend(orders, spend, TZ);

    expect(result.byOrderId.get("a")).toBe(10_000);
    expect(result.unattributedCents).toBe(7500);
    expect(result.unattributedByChannel.get("FACEBOOK")).toBe(7500);
  });

  it("treats a zero-spend ad day as no cost, not an unattributed gap", () => {
    const orders = [makeOrder({ id: "a" })];

    const result = attributeAdSpend(
      orders,
      [spendRow({ spendCents: 0 })],
      TZ,
    );

    expect(result.byOrderId.get("a")).toBeUndefined();
    expect(result.unattributedCents).toBe(0);
    expect(result.unattributedByChannel.size).toBe(0);
  });

  it("prefers campaign-level matching over channel-level", () => {
    const orders = [
      makeOrder({ id: "camp", campaignId: "c-1" }),
      makeOrder({ id: "other", campaignId: "c-2" }),
    ];

    const result = attributeAdSpend(
      orders,
      [spendRow({ campaignId: "c-1", spendCents: 6000 })],
      TZ,
    );

    expect(result.byOrderId.get("camp")).toBe(6000);
    expect(result.byOrderId.get("other")).toBeUndefined();
  });

  it("falls back to the channel when a campaign produced no orders", () => {
    const orders = [makeOrder({ id: "a", campaignId: "c-9" })];

    const result = attributeAdSpend(
      orders,
      [spendRow({ campaignId: "c-unknown", spendCents: 4000 })],
      TZ,
    );

    expect(result.byOrderId.get("a")).toBe(4000);
    expect(result.unattributedCents).toBe(0);
  });

  it("never allocates one spend row twice", () => {
    const orders = [
      makeOrder({ id: "a", campaignId: "c-1" }),
      makeOrder({ id: "b", campaignId: "c-1" }),
    ];

    const result = attributeAdSpend(
      orders,
      [spendRow({ campaignId: "c-1", spendCents: 10_000 })],
      TZ,
    );

    const total = [...result.byOrderId.values()].reduce((a, b) => a + b, 0);
    expect(total + result.unattributedCents).toBe(10_000);
  });

  it("buckets days in the merchant's timezone, not UTC", () => {
    // 03:00 UTC on the 11th is still the evening of the 10th in New York.
    const lateOrder = makeOrder({
      id: "late",
      processedAt: new Date("2026-03-11T03:00:00Z"),
    });

    expect(dayKey(lateOrder.processedAt, TZ)).toBe("2026-03-10");

    const result = attributeAdSpend(
      [lateOrder],
      [spendRow({ date: new Date("2026-03-10T17:00:00Z") })],
      TZ,
    );

    expect(result.byOrderId.get("late")).toBe(10_000);
  });
});

describe("allocateOverhead", () => {
  it("amortises the monthly figure across that month's orders exactly", () => {
    const orders = [
      makeOrder({ id: "a", processedAt: new Date("2026-03-02T12:00:00Z") }),
      makeOrder({ id: "b", processedAt: new Date("2026-03-15T12:00:00Z") }),
      makeOrder({ id: "c", processedAt: new Date("2026-03-28T12:00:00Z") }),
    ];

    const result = allocateOverhead(orders, 100_000, TZ);
    const total = [...result.values()].reduce((a, b) => a + b, 0);

    expect(total).toBe(100_000);
    expect(result.get("a")).toBe(33_334);
  });

  it("charges each month separately", () => {
    const orders = [
      makeOrder({ id: "mar", processedAt: new Date("2026-03-15T12:00:00Z") }),
      makeOrder({ id: "apr1", processedAt: new Date("2026-04-05T12:00:00Z") }),
      makeOrder({ id: "apr2", processedAt: new Date("2026-04-20T12:00:00Z") }),
    ];

    const result = allocateOverhead(orders, 60_000, TZ);

    expect(result.get("mar")).toBe(60_000);
    expect(result.get("apr1")).toBe(30_000);
    expect(result.get("apr2")).toBe(30_000);
  });

  it("does nothing when no overhead is configured", () => {
    expect(allocateOverhead([makeOrder()], 0, TZ).size).toBe(0);
  });

  it("charges only part of a month when the window covers only part of it", () => {
    // A rolling 30-day window from 3 Jul to 1 Aug: 29 days of July, 1 of August.
    const range = {
      from: new Date("2026-07-03T00:00:00-04:00"),
      to: new Date("2026-08-01T23:59:59-04:00"),
    };

    const orders = [
      makeOrder({ id: "jul", processedAt: new Date("2026-07-15T15:00:00Z") }),
      makeOrder({ id: "aug", processedAt: new Date("2026-08-01T15:00:00Z") }),
    ];

    const result = allocateOverhead(orders, 3_100_000, TZ, range);

    // July: 29 of 31 days -> 3,100,000 x 29/31 = 2,900,000
    expect(result.get("jul")).toBe(2_900_000);
    // August: 1 of 31 days -> 100,000
    expect(result.get("aug")).toBe(100_000);

    // Roughly one month of overhead for a ~30 day window, not two.
    const total = [...result.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(3_100_000 * 1.05);
  });

  it("charges a full month when the window covers all of it", () => {
    const range = {
      from: new Date("2026-03-01T00:00:00-05:00"),
      to: new Date("2026-03-31T23:59:59-04:00"),
    };

    const orders = [
      makeOrder({ id: "a", processedAt: new Date("2026-03-05T15:00:00Z") }),
      makeOrder({ id: "b", processedAt: new Date("2026-03-20T15:00:00Z") }),
    ];

    const result = allocateOverhead(orders, 100_000, TZ, range);
    const total = [...result.values()].reduce((a, b) => a + b, 0);

    expect(total).toBe(100_000);
  });
});

describe("computeProfitForPeriod", () => {
  it("reconciles: order profit plus unattributed spend equals the total", () => {
    const orders = [
      makeOrder({ id: "a" }),
      makeOrder({ id: "b", processedAt: new Date("2026-03-11T15:00:00Z") }),
    ];

    const spend: AdSpendRow[] = [
      {
        date: new Date("2026-03-10T12:00:00Z"),
        channel: "FACEBOOK",
        campaignId: null,
        campaignName: null,
        spendCents: 5000,
        impressions: 0,
        clicks: 0,
        platformConversions: 0,
        platformRevenueCents: 0,
      },
      {
        // A Saturday with spend but no orders.
        date: new Date("2026-03-14T12:00:00Z"),
        channel: "GOOGLE",
        campaignId: null,
        campaignName: null,
        spendCents: 2500,
        impressions: 0,
        clicks: 0,
        platformConversions: 0,
        platformRevenueCents: 0,
      },
    ];

    const period = computeProfitForPeriod(
      orders,
      spend,
      { ...RULES, monthlyOverheadCents: 20_000 },
      TZ,
    );

    expect(period.orderCount).toBe(2);
    expect(period.totalAdCostCents).toBe(7500);
    expect(period.unattributedAdCostCents).toBe(2500);

    const sumOfOrderContribution = period.orders.reduce(
      (sum, o) => sum + o.contributionProfitCents,
      0,
    );

    expect(period.contributionProfitCents).toBe(sumOfOrderContribution);
    expect(period.netProfitCents).toBe(
      sumOfOrderContribution - period.overheadCents - 2500,
    );
  });

  it("handles a period with no orders at all", () => {
    const period = computeProfitForPeriod([], [], RULES, TZ);

    expect(period.orderCount).toBe(0);
    expect(period.netProfitCents).toBe(0);
    expect(period.netMarginPct).toBeNull();
    expect(period.profitPerOrderCents).toBe(0);
  });
});
