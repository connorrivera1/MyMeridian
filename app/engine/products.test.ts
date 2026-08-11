import { describe, expect, it } from "vitest";

import { computeOrderProfit } from "./profit";
import { computeProductProfitability, type ProductMeta } from "./products";
import {
  ZERO_COST_RULES,
  type EngineLineItem,
  type EngineOrder,
} from "./types";

/** Zero cost rules keep the arithmetic legible: contribution = revenue − COGS. */
const RULES = ZERO_COST_RULES;

const PRODUCTS = new Map<string, ProductMeta>([
  ["hero", { productId: "hero", title: "Hero Jacket" }],
  ["tripwire", { productId: "tripwire", title: "Sample Pack" }],
  ["dud", { productId: "dud", title: "Clearance Mug" }],
  ["thin", { productId: "thin", title: "Thin Margin Tee" }],
]);

function line(
  productId: string,
  priceCents: number,
  costCents: number,
  quantity = 1,
): EngineLineItem {
  return {
    id: `li-${productId}-${Math.random()}`,
    productId,
    variantId: `var-${productId}`,
    title: productId,
    quantity,
    refundedQty: 0,
    unitPriceCents: priceCents,
    discountCents: 0,
    unitCostMicros: costCents * 100,
  };
}

function order(
  id: string,
  customerId: string,
  processedAt: Date,
  lineItems: EngineLineItem[],
  /**
   * Whether this is the customer's first ever order, as `Order.isFirstOrder`
   * records it. Downstream value is only credited to the products in an
   * acquiring order, so leaving this false models a customer who was already
   * acquired before the window opened.
   */
  isFirstOrder = false,
): EngineOrder {
  const subtotal = lineItems.reduce(
    (s, l) => s + l.unitPriceCents * l.quantity,
    0,
  );

  return {
    id,
    orderNumber: Number(id.replace(/\D/g, "")) || 1,
    processedAt,
    customerId,
    channel: "FACEBOOK",
    campaignId: null,
    isFirstOrder,
    subtotalCents: subtotal,
    discountTotalCents: 0,
    shippingChargedCents: 0,
    taxTotalCents: 0,
    totalCents: subtotal,
    refundedTotalCents: 0,
    actualShippingCostCents: 0,
    actualPickPackCostCents: 0,
    lineItems,
  };
}

function analyse(orders: EngineOrder[]) {
  const profits = orders.map((o) => computeOrderProfit(o, RULES));
  return computeProductProfitability(orders, profits, PRODUCTS);
}

describe("computeProductProfitability", () => {
  it("propagates missing COGS and modeled order costs to the product", () => {
    const missingOrder = order(
      "quality-1",
      "c-quality",
      new Date("2026-01-01"),
      [line("hero", 10_000, 0)],
      true,
    );
    const modeledRules = {
      ...ZERO_COST_RULES,
      paymentFixedPerOrderCents: 30,
    };
    const [result] = computeProductProfitability(
      [missingOrder],
      [computeOrderProfit(missingOrder, modeledRules)],
      PRODUCTS,
    );

    expect(result).toMatchObject({
      productId: "hero",
      hasMissingCogs: true,
      usesModeledCosts: true,
    });
  });

  it("marks a healthy product profitable", () => {
    const results = analyse([
      order(
        "o1",
        "c1",
        new Date("2026-01-01"),
        [line("hero", 10_000, 3000)],
        true,
      ),
    ]);

    const hero = results.find((r) => r.productId === "hero")!;

    expect(hero.contributionProfitCents).toBe(7000);
    expect(hero.marginPct).toBeCloseTo(0.7, 5);
    expect(hero.classification).toBe("PROFITABLE");
    expect(hero.profitPerUnitCents).toBe(7000);
  });

  it("flags a positive but thin margin separately from a healthy one", () => {
    const results = analyse([
      order(
        "o1",
        "c1",
        new Date("2026-01-01"),
        [line("thin", 10_000, 9200)],
        true,
      ),
    ]);

    const thin = results.find((r) => r.productId === "thin")!;

    expect(thin.contributionProfitCents).toBe(800);
    expect(thin.classification).toBe("THIN_MARGIN");
  });

  it("separates a working loss leader from one that is just bleeding", () => {
    const orders: EngineOrder[] = [];

    // Six customers acquired by a sample pack sold below cost, who each come
    // back for a full-price jacket.
    for (let i = 1; i <= 6; i++) {
      orders.push(
        order(
          `first-${i}`,
          `c${i}`,
          new Date("2026-01-01"),
          [line("tripwire", 1000, 1500)],
          true,
        ),
      );
      orders.push(
        order(`repeat-${i}`, `c${i}`, new Date("2026-02-01"), [
          line("hero", 10_000, 3000),
        ]),
      );
    }

    // Three customers who buy a below-cost mug and never return.
    for (let i = 7; i <= 9; i++) {
      orders.push(
        order(
          `dud-${i}`,
          `c${i}`,
          new Date("2026-01-05"),
          [line("dud", 1000, 1500)],
          true,
        ),
      );
    }

    const results = analyse(orders);

    const tripwire = results.find((r) => r.productId === "tripwire")!;
    expect(tripwire.contributionProfitCents).toBe(-3000); // 6 × −$5
    expect(tripwire.acquiredCustomers).toBe(6);
    expect(tripwire.downstreamProfitCents).toBe(42_000); // 6 × $70
    expect(tripwire.classification).toBe("STRATEGIC_LOSS_LEADER");

    const dud = results.find((r) => r.productId === "dud")!;
    expect(dud.contributionProfitCents).toBe(-1500);
    expect(dud.acquiredCustomers).toBe(3);
    expect(dud.downstreamProfitCents).toBe(0);
    expect(dud.classification).toBe("BLEEDING");
  });

  it("will not call a loss leader strategic on a handful of customers", () => {
    const orders: EngineOrder[] = [];

    // Same economics as above, but only three customers — below the cohort
    // floor, so the downstream signal is not trusted.
    for (let i = 1; i <= 3; i++) {
      orders.push(
        order(
          `first-${i}`,
          `c${i}`,
          new Date("2026-01-01"),
          [line("tripwire", 1000, 1500)],
          true,
        ),
      );
      orders.push(
        order(`repeat-${i}`, `c${i}`, new Date("2026-02-01"), [
          line("hero", 10_000, 3000),
        ]),
      );
    }

    const tripwire = analyse(orders).find((r) => r.productId === "tripwire")!;

    expect(tripwire.acquiredCustomers).toBe(3);
    expect(tripwire.classification).toBe("BLEEDING");
  });

  it("does not credit a returning customer's earliest visible order with acquiring them", () => {
    const orders: EngineOrder[] = [];

    // Six customers acquired inside the window by a full-price jacket, who do
    // not come back. They set the store's downstream average at zero.
    for (let i = 1; i <= 6; i++) {
      orders.push(
        order(
          `new-${i}`,
          `c${i}`,
          new Date("2026-01-02"),
          [line("hero", 10_000, 3000)],
          true,
        ),
      );
    }

    // Six customers acquired long before the window. Their earliest order
    // *inside* it happens to be a below-cost mug, and each then buys a jacket.
    // The order that actually acquired them is outside the window and absent.
    for (let i = 7; i <= 12; i++) {
      orders.push(
        order(`mug-${i}`, `c${i}`, new Date("2026-01-05"), [
          line("dud", 1000, 1500),
        ]),
      );
      orders.push(
        order(`later-${i}`, `c${i}`, new Date("2026-02-05"), [
          line("hero", 10_000, 3000),
        ]),
      );
    }

    const dud = analyse(orders).find((r) => r.productId === "dud")!;

    // The mug still loses $5 a unit — that part was never in doubt.
    expect(dud.contributionProfitCents).toBe(-3000); // 6 × −$5

    // But it acquired nobody, so it has no downstream value to show for it.
    // Reading `sorted[0]` as the acquiring order gave it six customers and
    // $420 of other people's repeat purchases, clearing the cohort floor and
    // the uplift bar and reporting a clearance line as a deliberate,
    // working loss leader.
    expect(dud.acquiredCustomers).toBe(0);
    expect(dud.downstreamProfitCents).toBe(0);
    expect(dud.classification).toBe("BLEEDING");
  });

  it("splits shared order costs across products by revenue share", () => {
    const shared = order(
      "o1",
      "c1",
      new Date("2026-01-01"),
      [line("hero", 7500, 1000), line("dud", 2500, 500)],
      true,
    );
    shared.actualShippingCostCents = 1000;
    shared.actualPickPackCostCents = 0;

    const profits = [computeOrderProfit(shared, RULES)];
    const results = computeProductProfitability([shared], profits, PRODUCTS);

    const hero = results.find((r) => r.productId === "hero")!;
    const dud = results.find((r) => r.productId === "dud")!;

    // 75/25 revenue split means a 75/25 shipping split.
    expect(hero.allocatedShippingCents).toBe(750);
    expect(dud.allocatedShippingCents).toBe(250);
    expect(hero.allocatedShippingCents + dud.allocatedShippingCents).toBe(1000);
  });

  it("tracks attach rate and revenue share", () => {
    const results = analyse([
      order(
        "o1",
        "c1",
        new Date("2026-01-01"),
        [line("hero", 10_000, 3000)],
        true,
      ),
      order(
        "o2",
        "c2",
        new Date("2026-01-02"),
        [line("hero", 10_000, 3000)],
        true,
      ),
      order(
        "o3",
        "c3",
        new Date("2026-01-03"),
        [line("dud", 10_000, 3000)],
        true,
      ),
      order(
        "o4",
        "c4",
        new Date("2026-01-04"),
        [line("dud", 10_000, 3000)],
        true,
      ),
    ]);

    const hero = results.find((r) => r.productId === "hero")!;

    expect(hero.ordersContaining).toBe(2);
    expect(hero.attachRatePct).toBeCloseTo(0.5, 5);
    expect(hero.revenueSharePct).toBeCloseTo(0.5, 5);
  });

  it("counts a product once per order even when it appears on several lines", () => {
    const multi = order(
      "o1",
      "c1",
      new Date("2026-01-01"),
      [line("hero", 10_000, 3000), line("hero", 10_000, 3000)],
      true,
    );

    const hero = analyse([multi]).find((r) => r.productId === "hero")!;

    expect(hero.ordersContaining).toBe(1);
    expect(hero.units).toBe(2);
  });
});
