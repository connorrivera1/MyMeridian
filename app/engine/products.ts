import { allocate, ratio, type Cents } from "./money";
import { costOfUnits } from "./money";
import type { EngineOrder, OrderProfit } from "./types";

/**
 * Product-level profitability, and the question the merchant actually cares
 * about: is this red number a product to kill, or a product that is buying
 * customers who go on to be profitable?
 */

export type ProductClass =
  "PROFITABLE" | "STRATEGIC_LOSS_LEADER" | "BLEEDING" | "THIN_MARGIN";

/** Below this many acquired customers the downstream signal is noise. */
export const MIN_COHORT_FOR_STRATEGIC = 5;

/**
 * How much better than the store's average customer a loss leader's buyers must
 * be before the loss counts as deliberate rather than just a loss.
 *
 * Beating the average by a hair is not evidence — with enough products some
 * will clear an average purely by selection. Requiring a clear margin keeps the
 * label meaning something.
 */
export const STRATEGIC_UPLIFT_THRESHOLD = 1.25;

/** Contribution margin under this is flagged as thin even when positive. */
export const THIN_MARGIN_THRESHOLD = 0.1;

export interface ProductMeta {
  productId: string;
  title: string;
  imageUrl?: string | null;
  productType?: string | null;
  vendor?: string | null;
}

export interface ProductProfit extends ProductMeta {
  units: number;
  ordersContaining: number;

  grossRevenueCents: Cents;
  discountCents: Cents;
  netRevenueCents: Cents;
  cogsCents: Cents;

  allocatedShippingCents: Cents;
  allocatedPaymentFeeCents: Cents;
  allocatedPickPackCents: Cents;
  allocatedAdCostCents: Cents;

  contributionProfitCents: Cents;
  marginPct: number | null;
  /** Profit per unit sold — the number that decides whether to scale. */
  profitPerUnitCents: Cents;

  /** At least one sold unit had no Shopify COGS snapshot. */
  hasMissingCogs: boolean;
  /** At least one contributing order used configured rather than measured cost. */
  usesModeledCosts: boolean;

  classification: ProductClass;

  /** Customers whose very first order contained this product. */
  acquiredCustomers: number;
  /** Contribution profit those customers generated on every later order. */
  downstreamProfitCents: Cents;
  downstreamProfitPerCustomerCents: Cents;

  attachRatePct: number | null;
  revenueSharePct: number | null;
}

interface LineAllocation {
  productId: string;
  netRevenueCents: Cents;
  grossRevenueCents: Cents;
  discountCents: Cents;
  cogsCents: Cents;
  units: number;
  shippingCents: Cents;
  paymentFeeCents: Cents;
  pickPackCents: Cents;
  adCostCents: Cents;
  hasMissingCogs: boolean;
  usesModeledCosts: boolean;
}

/**
 * Push an order's order-level costs down onto its line items.
 *
 * Split is by each line's share of the order's product revenue. Shipping is
 * arguably better split by weight and pick/pack by unit count, but revenue
 * share is the one merchants can verify by hand — and a number they can check
 * is worth more than a number that is marginally more precise.
 */
function allocateOrderToProducts(
  order: EngineOrder,
  profit: OrderProfit,
): LineAllocation[] {
  const lines = order.lineItems.filter((item) => item.productId);
  if (lines.length === 0) return [];

  const lineNet = lines.map((item) => {
    const soldQty = Math.max(0, item.quantity - item.refundedQty);
    return Math.max(0, item.unitPriceCents * soldQty - item.discountCents);
  });

  const weightTotal = lineNet.reduce((a, b) => a + b, 0);
  const weights = weightTotal > 0 ? lineNet : lines.map(() => 1);

  const shipping = allocate(profit.shippingCostCents, weights);
  const payment = allocate(profit.paymentFeeCents, weights);
  const pickPack = allocate(profit.pickPackCents, weights);
  const adCost = allocate(profit.adCostCents, weights);

  // Order-level discounts and refunds also have to land somewhere.
  const orderDiscount = allocate(
    Math.max(0, order.discountTotalCents),
    weights,
  );
  const orderRefund = allocate(Math.max(0, order.refundedTotalCents), weights);

  return lines.map((item, i) => {
    const soldQty = Math.max(0, item.quantity - item.refundedQty);
    const gross = item.unitPriceCents * soldQty;
    const discount = item.discountCents + (orderDiscount[i] ?? 0);

    return {
      productId: item.productId!,
      grossRevenueCents: gross,
      discountCents: discount,
      netRevenueCents: gross - discount - (orderRefund[i] ?? 0),
      cogsCents: costOfUnits(item.unitCostMicros, soldQty),
      units: soldQty,
      shippingCents: shipping[i] ?? 0,
      paymentFeeCents: payment[i] ?? 0,
      pickPackCents: pickPack[i] ?? 0,
      adCostCents: adCost[i] ?? 0,
      hasMissingCogs: item.unitCostMicros <= 0 && soldQty > 0,
      usesModeledCosts: profit.usesModeledCosts,
    };
  });
}

export function computeProductProfitability(
  orders: readonly EngineOrder[],
  orderProfits: readonly OrderProfit[],
  products: ReadonlyMap<string, ProductMeta>,
): ProductProfit[] {
  const profitByOrderId = new Map(orderProfits.map((p) => [p.orderId, p]));

  const totals = new Map<
    string,
    LineAllocation & { ordersContaining: number }
  >();

  for (const order of orders) {
    const profit = profitByOrderId.get(order.id);
    if (!profit) continue;

    const seenInOrder = new Set<string>();

    for (const line of allocateOrderToProducts(order, profit)) {
      const current = totals.get(line.productId) ?? {
        productId: line.productId,
        grossRevenueCents: 0,
        discountCents: 0,
        netRevenueCents: 0,
        cogsCents: 0,
        units: 0,
        shippingCents: 0,
        paymentFeeCents: 0,
        pickPackCents: 0,
        adCostCents: 0,
        hasMissingCogs: false,
        usesModeledCosts: false,
        ordersContaining: 0,
      };

      current.grossRevenueCents += line.grossRevenueCents;
      current.discountCents += line.discountCents;
      current.netRevenueCents += line.netRevenueCents;
      current.cogsCents += line.cogsCents;
      current.units += line.units;
      current.shippingCents += line.shippingCents;
      current.paymentFeeCents += line.paymentFeeCents;
      current.pickPackCents += line.pickPackCents;
      current.adCostCents += line.adCostCents;
      current.hasMissingCogs ||= line.hasMissingCogs;
      current.usesModeledCosts ||= line.usesModeledCosts;

      if (!seenInOrder.has(line.productId)) {
        current.ordersContaining += 1;
        seenInOrder.add(line.productId);
      }

      totals.set(line.productId, current);
    }
  }

  const { byProduct: downstream, storeAveragePerCustomerCents } =
    computeDownstreamValue(orders, orderProfits);

  const totalOrders = orders.length;
  const totalNetRevenue = orderProfits.reduce(
    (sum, p) => sum + p.netRevenueCents,
    0,
  );

  const results: ProductProfit[] = [];

  for (const [productId, t] of totals) {
    const meta = products.get(productId) ?? {
      productId,
      title: "Unknown product",
    };

    const contributionProfitCents =
      t.netRevenueCents -
      t.cogsCents -
      t.shippingCents -
      t.paymentFeeCents -
      t.pickPackCents -
      t.adCostCents;

    const marginPct = ratio(contributionProfitCents, t.netRevenueCents);

    const cohort = downstream.get(productId);
    const acquiredCustomers = cohort?.customers ?? 0;
    const downstreamProfitCents = cohort?.profitCents ?? 0;
    const downstreamProfitPerCustomerCents = acquiredCustomers
      ? Math.round(downstreamProfitCents / acquiredCustomers)
      : 0;

    let classification: ProductClass;
    if (contributionProfitCents > 0) {
      classification =
        marginPct !== null && marginPct < THIN_MARGIN_THRESHOLD
          ? "THIN_MARGIN"
          : "PROFITABLE";
    } else if (
      acquiredCustomers >= MIN_COHORT_FOR_STRATEGIC &&
      downstreamProfitCents > -contributionProfitCents &&
      downstreamProfitPerCustomerCents >
        storeAveragePerCustomerCents * STRATEGIC_UPLIFT_THRESHOLD
    ) {
      // Two conditions, and the second is the one that carries the weight.
      //
      // Covering the loss is not enough: almost any product clears that bar,
      // because the customers who happened to buy it go on to buy other things
      // regardless. What makes a loss leader genuinely strategic is that its
      // buyers come back *better than the store's average customer does* — that
      // is the part attributable to the product rather than to the store.
      classification = "STRATEGIC_LOSS_LEADER";
    } else {
      classification = "BLEEDING";
    }

    results.push({
      ...meta,
      productId,
      units: t.units,
      ordersContaining: t.ordersContaining,
      grossRevenueCents: t.grossRevenueCents,
      discountCents: t.discountCents,
      netRevenueCents: t.netRevenueCents,
      cogsCents: t.cogsCents,
      allocatedShippingCents: t.shippingCents,
      allocatedPaymentFeeCents: t.paymentFeeCents,
      allocatedPickPackCents: t.pickPackCents,
      allocatedAdCostCents: t.adCostCents,
      contributionProfitCents,
      marginPct,
      profitPerUnitCents: t.units
        ? Math.round(contributionProfitCents / t.units)
        : 0,
      hasMissingCogs: t.hasMissingCogs,
      usesModeledCosts: t.usesModeledCosts,
      classification,
      acquiredCustomers,
      downstreamProfitCents,
      downstreamProfitPerCustomerCents,
      attachRatePct: ratio(t.ordersContaining, totalOrders),
      revenueSharePct: ratio(t.netRevenueCents, totalNetRevenue),
    });
  }

  return results.sort(
    (a, b) => b.contributionProfitCents - a.contributionProfitCents,
  );
}

/**
 * For each product, the profit generated by customers it acquired, on every
 * order *after* the one that acquired them.
 *
 * This is what separates a loss leader that is working from one that is just
 * losing money.
 */
function computeDownstreamValue(
  orders: readonly EngineOrder[],
  orderProfits: readonly OrderProfit[],
): {
  byProduct: Map<string, { customers: number; profitCents: Cents }>;
  /** What a typical customer of this store is worth after their first order. */
  storeAveragePerCustomerCents: Cents;
} {
  const profitByOrderId = new Map(orderProfits.map((p) => [p.orderId, p]));

  const byCustomer = new Map<string, EngineOrder[]>();
  for (const order of orders) {
    if (!order.customerId) continue;
    const bucket = byCustomer.get(order.customerId);
    if (bucket) bucket.push(order);
    else byCustomer.set(order.customerId, [order]);
  }

  const result = new Map<string, { customers: number; profitCents: Cents }>();
  let storeDownstreamCents = 0;
  let storeCustomers = 0;

  for (const customerOrders of byCustomer.values()) {
    if (customerOrders.length === 0) continue;

    const sorted = [...customerOrders].sort(
      (a, b) => a.processedAt.getTime() - b.processedAt.getTime(),
    );

    const first = sorted[0]!;

    // Only customers this window actually saw arrive. `sorted[0]` is the
    // earliest order in the loaded window, which for a customer acquired
    // earlier is just a repeat purchase — crediting the products in it with
    // having acquired them would hand a loss-leader verdict to whatever a
    // returning customer happened to buy, and count their remaining orders as
    // that product's downstream value.
    if (!first.isFirstOrder) continue;

    const laterProfit = sorted
      .slice(1)
      .reduce(
        (sum, o) =>
          sum + (profitByOrderId.get(o.id)?.contributionProfitCents ?? 0),
        0,
      );

    storeDownstreamCents += laterProfit;
    storeCustomers += 1;

    // Credit the acquisition to every distinct product in that first order.
    const acquiringProducts = new Set(
      first.lineItems
        .map((l) => l.productId)
        .filter((id): id is string => !!id),
    );

    for (const productId of acquiringProducts) {
      const current = result.get(productId) ?? { customers: 0, profitCents: 0 };
      current.customers += 1;
      current.profitCents += laterProfit;
      result.set(productId, current);
    }
  }

  return {
    byProduct: result,
    storeAveragePerCustomerCents: storeCustomers
      ? Math.round(storeDownstreamCents / storeCustomers)
      : 0,
  };
}
