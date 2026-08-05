import { CostRuleKind, type CostRule } from "@prisma/client";

import prisma from "~/db.server";
import { toCents, toMicros } from "~/engine/money";
import type { CapacityDayInput } from "~/engine/capacity";
import type { PriceObservation, PricingInput } from "~/engine/pricing";
import type { ProductMeta } from "~/engine/products";
import type {
  AdSpendRow,
  Channel,
  CostRuleSet,
  EngineOrder,
} from "~/engine/types";

/**
 * The boundary between Prisma and the profit engine.
 *
 * Everything below converts database rows into the engine's plain input types.
 * The engine never imports Prisma, which is what makes it testable without a
 * database and keeps the money conversions in exactly one place.
 */

export interface DateRange {
  from: Date;
  to: Date;
}

export function toCostRuleSet(rules: readonly CostRule[]): CostRuleSet {
  const active = rules.filter((r) => r.active);
  const find = (kind: CostRuleKind) => active.find((r) => r.kind === kind);

  const payment = find(CostRuleKind.PAYMENT_FEE);
  const shipping = find(CostRuleKind.SHIPPING_DEFAULT);
  const pickPack = find(CostRuleKind.PICK_PACK);
  const overhead = find(CostRuleKind.OVERHEAD_MONTHLY);

  return {
    paymentPercentRate: payment?.percentRate ? Number(payment.percentRate) : 0,
    paymentFixedPerOrderCents: toCents(payment?.fixedPerOrder),
    shippingDefaultPerOrderCents: toCents(shipping?.fixedPerOrder),
    pickPackPerOrderCents: toCents(pickPack?.fixedPerOrder),
    pickPackPerItemCents: toCents(pickPack?.fixedPerItem),
    monthlyOverheadCents: toCents(overhead?.monthlyAmount),
  };
}

export async function loadCostRules(shopId: string): Promise<CostRuleSet> {
  const rules = await prisma.costRule.findMany({ where: { shopId } });
  return toCostRuleSet(rules);
}

export async function loadEngineOrders(
  shopId: string,
  range: DateRange,
): Promise<EngineOrder[]> {
  const orders = await prisma.order.findMany({
    where: { shopId, processedAt: { gte: range.from, lte: range.to } },
    include: {
      lineItems: true,
      fulfillments: { select: { shippingCost: true, pickPackCost: true } },
    },
    orderBy: { processedAt: "asc" },
  });

  return orders.map((order) => {
    // Shopify's own fulfilment webhooks carry no carrier cost — that arrives
    // from the 3PL connector. A zero therefore means "not known yet", not
    // "shipped for free", and must fall back to the merchant's cost rule.
    const shippingCostCents = order.fulfillments.reduce(
      (sum, f) => sum + toCents(f.shippingCost),
      0,
    );
    const pickPackCostCents = order.fulfillments.reduce(
      (sum, f) => sum + toCents(f.pickPackCost),
      0,
    );

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      processedAt: order.processedAt,
      customerId: order.customerId,
      channel: order.channel as Channel,
      campaignId: order.campaignId,
      isFirstOrder: order.isFirstOrder,

      subtotalCents: toCents(order.subtotal),
      discountTotalCents: toCents(order.discountTotal),
      shippingChargedCents: toCents(order.shippingCharged),
      taxTotalCents: toCents(order.taxTotal),
      totalCents: toCents(order.total),
      refundedTotalCents: toCents(order.refundedTotal),

      actualShippingCostCents: shippingCostCents > 0 ? shippingCostCents : null,
      actualPickPackCostCents: pickPackCostCents > 0 ? pickPackCostCents : null,

      lineItems: order.lineItems.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        title: item.title,
        quantity: item.quantity,
        refundedQty: item.refundedQty,
        unitPriceCents: toCents(item.unitPrice),
        discountCents: toCents(item.discount),
        unitCostMicros: toMicros(item.unitCost),
      })),
    };
  });
}

export interface CohortRow {
  customerId: string;
  processedAt: Date;
  channel: Channel;
  campaignId: string | null;
  contributionProfitCents: number;
  adCostCents: number;
}

/**
 * Lean per-order rows for cohort analysis, read from the materialised profit
 * columns rather than recomputed.
 *
 * Customer lifetime value has to look back much further than the reporting
 * window — a merchant viewing "last 30 days" still wants the 90-day value of
 * each channel, which can only come from cohorts acquired more than 90 days
 * ago. Loading a year of full orders with line items for that would be far too
 * slow, so this reads only the columns the journey needs.
 */
export async function loadCohortRows(
  shopId: string,
  range: DateRange,
): Promise<CohortRow[]> {
  const rows = await prisma.order.findMany({
    where: {
      shopId,
      processedAt: { gte: range.from, lte: range.to },
      customerId: { not: null },
    },
    select: {
      customerId: true,
      processedAt: true,
      channel: true,
      campaignId: true,
      contributionProfit: true,
      adCostAttributed: true,
    },
    orderBy: { processedAt: "asc" },
  });

  return rows.map((row) => ({
    customerId: row.customerId!,
    processedAt: row.processedAt,
    channel: row.channel as Channel,
    campaignId: row.campaignId,
    contributionProfitCents: toCents(row.contributionProfit),
    adCostCents: toCents(row.adCostAttributed),
  }));
}

export async function loadAdSpend(
  shopId: string,
  range: DateRange,
): Promise<AdSpendRow[]> {
  const rows = await prisma.adSpend.findMany({
    where: { shopId, date: { gte: range.from, lte: range.to } },
    orderBy: { date: "asc" },
  });

  return rows.map((row) => ({
    date: row.date,
    channel: row.channel as Channel,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    spendCents: toCents(row.spend),
    impressions: row.impressions,
    clicks: row.clicks,
    platformConversions: row.platformConversions,
    platformRevenueCents: toCents(row.platformRevenue),
  }));
}

export async function loadProductMeta(
  shopId: string,
): Promise<Map<string, ProductMeta>> {
  const products = await prisma.product.findMany({
    where: { shopId },
    select: {
      id: true,
      title: true,
      imageUrl: true,
      productType: true,
      vendor: true,
    },
  });

  return new Map(
    products.map((p) => [
      p.id,
      {
        productId: p.id,
        title: p.title,
        imageUrl: p.imageUrl,
        productType: p.productType,
        vendor: p.vendor,
      },
    ]),
  );
}

export async function loadCapacityDays(
  shopId: string,
  range: DateRange,
): Promise<CapacityDayInput[]> {
  const days = await prisma.capacityDay.findMany({
    where: { shopId, date: { gte: range.from, lte: range.to } },
    orderBy: { date: "asc" },
  });

  return days.map((day) => ({
    date: day.date,
    ordersReceived: day.ordersReceived,
    ordersFulfilled: day.ordersFulfilled,
    backlogEnd: day.backlogEnd,
    maxDailyCapacity: day.maxDailyCapacity,
    staffedHours: Number(day.staffedHours),
  }));
}

/**
 * Assemble the per-variant price/demand history the elasticity model needs.
 *
 * One observation per variant per day: the price in force that day and the
 * units that moved. Days with no sales still count — zero demand at a price is
 * a real signal.
 */
/**
 * Width of a realised-price bucket, as a fraction of list price.
 *
 * This is an errors-in-variables control. Daily realised price is a noisy
 * measure of the price actually being tested — ordinary discount mix moves it a
 * percent or two either way — and noise in a regressor biases the fitted slope
 * toward zero. Buckets wider than that noise absorb it; buckets narrower than a
 * genuine promotion would erase the signal. Swept against the seeded store's
 * known elasticities in scripts/elasticity-accuracy.ts.
 */
export const PRICE_BUCKET_PCT = 0.06;

export async function loadPricingInputs(
  shopId: string,
  range: DateRange,
  options: {
    strategicProductIds?: ReadonlySet<string>;
    priceBucketPct?: number;
  } = {},
): Promise<PricingInput[]> {
  const bucketPct = options.priceBucketPct ?? PRICE_BUCKET_PCT;
  const variants = await prisma.variant.findMany({
    where: { shopId },
    include: {
      product: { select: { id: true, title: true } },
      priceHistory: { orderBy: { effectiveAt: "asc" } },
    },
  });

  // Store-wide daily order counts, used to divide the store's own growth and
  // seasonality out of each product's demand before fitting elasticity.
  const dailyOrders = await prisma.order.groupBy({
    by: ["processedAt"],
    where: { shopId, processedAt: { gte: range.from, lte: range.to } },
    _count: { _all: true },
  });

  const ordersByDay = new Map<string, number>();
  for (const row of dailyOrders) {
    const key = row.processedAt.toISOString().slice(0, 10);
    ordersByDay.set(key, (ordersByDay.get(key) ?? 0) + row._count._all);
  }

  const lineItems = await prisma.orderLineItem.findMany({
    where: {
      shopId,
      order: { processedAt: { gte: range.from, lte: range.to } },
    },
    select: {
      variantId: true,
      quantity: true,
      refundedQty: true,
      unitPrice: true,
      discount: true,
      order: { select: { processedAt: true } },
    },
  });

  const salesByVariantDay = new Map<
    string,
    Map<string, { units: number; revenueCents: number }>
  >();

  for (const item of lineItems) {
    if (!item.variantId) continue;

    const dayIso = item.order.processedAt.toISOString().slice(0, 10);
    const perVariant = salesByVariantDay.get(item.variantId) ?? new Map();
    const existing = perVariant.get(dayIso) ?? { units: 0, revenueCents: 0 };

    const units = Math.max(0, item.quantity - item.refundedQty);
    if (units > 0) {
      // The elasticity model needs the price customers actually paid, not the
      // list price. A promotion is a price change; recording it as list price
      // hands a discount-driven volume spike to the undiscounted price and
      // flattens the estimated elasticity toward zero.
      const discountForSoldUnits = Math.round(
        (toCents(item.discount) * units) / item.quantity,
      );
      existing.units += units;
      existing.revenueCents += toCents(item.unitPrice) * units - discountForSoldUnits;
    }

    perVariant.set(dayIso, existing);
    salesByVariantDay.set(item.variantId, perVariant);
  }

  const dayCount = Math.max(
    1,
    Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000),
  );

  return variants.map((variant) => {
    const sales = salesByVariantDay.get(variant.id) ?? new Map();
    const observations: PriceObservation[] = [];

    for (let i = 0; i < dayCount; i++) {
      const date = new Date(range.from.getTime() + i * 86_400_000);
      const dayIso = date.toISOString().slice(0, 10);

      const listPriceThatDay =
        priceInForce(variant.priceHistory, date) ?? toCents(variant.price);

      const sold = sales.get(dayIso);

      // Steps are proportional to list price: a fixed step cannot serve both a
      // $12 bottle and a $289 jacket. See PRICE_BUCKET_PCT above.
      const step = Math.max(25, Math.round(listPriceThatDay * bucketPct));
      const effectivePrice =
        sold && sold.units > 0
          ? Math.round(sold.revenueCents / sold.units / step) * step
          : listPriceThatDay;

      observations.push({
        date,
        priceCents: effectivePrice,
        units: sold?.units ?? 0,
        demandIndex: ordersByDay.get(dayIso) ?? 0,
      });
    }

    return {
      variantId: variant.id,
      productTitle: variant.product.title,
      variantTitle: variant.title,
      currentPriceCents: toCents(variant.price),
      unitCostMicros: toMicros(variant.unitCost),
      observations,
      isStrategicLossLeader: options.strategicProductIds?.has(variant.product.id),
    };
  });
}

function priceInForce(
  history: readonly { price: unknown; effectiveAt: Date }[],
  date: Date,
): number | null {
  let current: number | null = null;
  for (const entry of history) {
    if (entry.effectiveAt <= date) {
      current = toCents(entry.price as never);
    } else {
      break;
    }
  }
  return current;
}
