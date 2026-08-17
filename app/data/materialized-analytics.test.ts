import { Decimal } from "@prisma/client/runtime/library";
import { describe, expect, it } from "vitest";

import {
  allocateRollupCents,
  productProfitFromRollup,
  productProfitsFromRollups,
  rollupMaterializedProfits,
  toMaterializedOrderProfit,
  type MaterializedOrder,
  type ProductRollupRow,
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

describe("materialized product rollup cent allocation", () => {
  const productRow = (
    productId: string,
    overrides: Partial<ProductRollupRow> = {},
  ): ProductRollupRow => ({
    productId,
    title: productId.toUpperCase(),
    imageUrl: null,
    productType: null,
    vendor: null,
    units: 1n,
    ordersContaining: 1n,
    grossRevenue: money(0),
    discount: money(0),
    netRevenue: money(0),
    cogs: money(0),
    shipping: money(0),
    payment: money(0),
    pickPack: money(0),
    adCost: money(0),
    returnShipping: money(0),
    missingCogs: false,
    modeledCosts: false,
    ...overrides,
  });

  it("keeps a cent that a single order split three ways", () => {
    // One cent of shipping allocated evenly over three products. Rounded per
    // row it is 0.333 of a cent each and disappears; the ledger charged 1c.
    const third = money("0.003333333333");
    const products = productProfitsFromRollups(
      ["a", "b", "c"].map((id) =>
        productRow(id, { netRevenue: third, shipping: third }),
      ),
      1,
      1,
    );

    const shipping = products.reduce(
      (sum, p) => sum + p.allocatedShippingCents,
      0,
    );
    const netRevenue = products.reduce((sum, p) => sum + p.netRevenueCents, 0);
    expect(shipping).toBe(1);
    expect(netRevenue).toBe(1);
    // The penny lands on exactly one product, not on all three.
    expect(
      products.filter((p) => p.allocatedShippingCents === 1),
    ).toHaveLength(1);
  });

  it("conserves the aggregate when allocations are negative", () => {
    // A refund-heavy window drives allocated net revenue below zero. Three rows
    // of -0.66666c total -1.99998c, so the column must round to -2c. Truncating
    // toward zero would floor these to 0 and need the opposite remainder
    // direction to recover; flooring keeps one direction correct for both signs.
    const each = money("-0.0066666");
    const products = productProfitsFromRollups(
      ["a", "b", "c"].map((id) =>
        productRow(id, { netRevenue: each, cogs: each }),
      ),
      1,
      -2,
    );

    expect(products.reduce((sum, p) => sum + p.netRevenueCents, 0)).toBe(-2);
    expect(products.reduce((sum, p) => sum + p.cogsCents, 0)).toBe(-2);
    // Two rows carry a full negative cent and one is forgiven, rather than all
    // three reading -1c and overstating the loss.
    expect(products.filter((p) => p.netRevenueCents === -1)).toHaveLength(2);
    expect(products.filter((p) => p.netRevenueCents === 0)).toHaveLength(1);
  });

  it("conserves a negative aggregate through allocateRollupCents directly", () => {
    expect(allocateRollupCents([-0.66666, -0.66666, -0.66666])).toEqual([
      0, -1, -1,
    ]);
    expect(allocateRollupCents([-1.5, 2.25, -0.25])).toEqual([-1, 2, 0]);
  });

  it("conserves the rounded total for any mix of signs and fractions", () => {
    // The property is the whole point of the function, so assert it over a
    // spread of inputs rather than a couple of hand-computed rows. Seeded so a
    // failure is reproducible.
    let seed = 20260817;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let trial = 0; trial < 500; trial += 1) {
      const length = 1 + Math.floor(next() * 12);
      const values = Array.from(
        { length },
        () => (next() - 0.4) * 2000,
      );
      const allocated = allocateRollupCents(values);
      const exact = values.reduce((sum, value) => sum + value, 0);

      expect(allocated).toHaveLength(length);
      expect(allocated.every((value) => Number.isInteger(value))).toBe(true);
      expect(allocated.reduce((sum, value) => sum + value, 0)).toBe(
        Math.round(exact),
      );
      // No row may drift more than a penny from its own exact share.
      allocated.forEach((value, index) => {
        expect(Math.abs(value - values[index]!)).toBeLessThan(1);
      });
    }
  });

  it("ignores non-finite values instead of poisoning the whole column", () => {
    expect(
      allocateRollupCents([Number.NaN, 150, Number.POSITIVE_INFINITY]),
    ).toEqual([0, 150, 0]);
  });

  it("matches the exact query aggregate for every money column", () => {
    const columns = [
      "grossRevenue",
      "discount",
      "netRevenue",
      "cogs",
      "shipping",
      "payment",
      "pickPack",
      "adCost",
      "returnShipping",
    ] as const;
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) =>
      productRow(id, {
        grossRevenue: money(`${index * 7}.1234567`),
        discount: money(`${index}.9876543`),
        netRevenue: money(`${index * 5}.5555555`),
        cogs: money(`${index * 2}.4444444`),
        shipping: money("0.0066666"),
        payment: money("0.0033333"),
        pickPack: money("0.0016666"),
        adCost: money("0.0083333"),
        returnShipping: money("0.0049999"),
      }),
    );

    const products = productProfitsFromRollups(rows, 7, 100_000);
    const totalOf: Record<(typeof columns)[number], number> = {
      grossRevenue: products.reduce((s, p) => s + p.grossRevenueCents, 0),
      discount: products.reduce((s, p) => s + p.discountCents, 0),
      netRevenue: products.reduce((s, p) => s + p.netRevenueCents, 0),
      cogs: products.reduce((s, p) => s + p.cogsCents, 0),
      shipping: products.reduce((s, p) => s + p.allocatedShippingCents, 0),
      payment: products.reduce((s, p) => s + p.allocatedPaymentFeeCents, 0),
      pickPack: products.reduce((s, p) => s + p.allocatedPickPackCents, 0),
      adCost: products.reduce((s, p) => s + p.allocatedAdCostCents, 0),
      returnShipping: products.reduce(
        (s, p) => s + p.allocatedReturnShippingCents,
        0,
      ),
    };

    for (const column of columns) {
      const exact = rows.reduce(
        (sum, r) => sum + Number(r[column]) * 100,
        0,
      );
      expect(totalOf[column], column).toBe(Math.round(exact));
    }
  });

  it("hands out every leftover penny and no more", () => {
    // Nine rows of 0.5c: the column totals 4.5c, which rounds to 5c, so five
    // rows must gain a penny over the floored 0 and four must not.
    const allocated = allocateRollupCents(Array.from({ length: 9 }, () => 0.5));
    expect(allocated.reduce((sum, value) => sum + value, 0)).toBe(5);
    expect(allocated.filter((value) => value === 1)).toHaveLength(5);
    expect(allocated.filter((value) => value === 0)).toHaveLength(4);
  });

  it("leaves whole-cent columns exactly where they were", () => {
    expect(allocateRollupCents([100, -250, 0, 4_200])).toEqual([
      100, -250, 0, 4_200,
    ]);
  });

  it("returns nothing for an empty result set", () => {
    expect(allocateRollupCents([])).toEqual([]);
    expect(productProfitsFromRollups([], 0, 0)).toEqual([]);
  });
});
