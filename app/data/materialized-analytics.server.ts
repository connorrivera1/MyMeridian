import { Prisma, type Shop } from "@prisma/client";

import prisma from "~/db.server";
import { computeCampaignPerformance, computeChannelPerformance } from "~/engine/acquisition";
import { analyseCapacity } from "~/engine/capacity";
import { ratio } from "~/engine/money";
import type { PeriodProfit } from "~/engine/profit";
import type { ProductClass, ProductProfit } from "~/engine/products";
import type { AdSpendRow, Channel, EngineOrder, OrderProfit } from "~/engine/types";
import { loadAdSpend, loadCapacityDays, loadCostRules, type DateRange } from "./queries.server";

function cents(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100);
}

export type MaterializedOrder = Awaited<ReturnType<typeof loadMaterializedRows>>[number];

async function loadMaterializedRows(shopId: string, range: DateRange) {
  const where = {
    shopId,
    processedAt: { gte: range.from, lte: range.to },
  } as const;
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
    where: {
      ...where,
      computedAt: { not: null },
    },
    orderBy: [{ processedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      orderNumber: true,
      processedAt: true,
      customerId: true,
      channel: true,
      campaignId: true,
      isFirstOrder: true,
      subtotal: true,
      discountTotal: true,
      shippingCharged: true,
      total: true,
      taxTotal: true,
      refundedTotal: true,
      returnFeesRetained: true,
      cogsTotal: true,
      adCostAttributed: true,
      overheadAllocated: true,
      contributionProfit: true,
      netProfit: true,
      materializedPaymentFee: true,
      materializedPickPackCost: true,
      materializedOutboundShippingCost: true,
      materializedReturnShippingCost: true,
      materializedUnits: true,
      materializedMissingCogs: true,
      materializedModeledCosts: true,
    },
    }),
  ]);
  if (rows.length !== total) {
    throw new Error(
      `Large-window analytics requires a complete materialized ledger; ${
        total - rows.length
      } order(s) still need profit recomputation.`,
    );
  }
  return rows;
}

export function toMaterializedOrderProfit(order: MaterializedOrder): OrderProfit {
  const grossRevenueCents = cents(order.subtotal);
  const discountCents = cents(order.discountTotal);
  const shippingRevenueCents = cents(order.shippingCharged);
  const cogsCents = cents(order.cogsTotal);
  const shippingCostCents = cents(order.materializedOutboundShippingCost);
  const paymentFeeCents = cents(order.materializedPaymentFee);
  const pickPackCents = cents(order.materializedPickPackCost);
  const adCostCents = cents(order.adCostAttributed);
  const returnShippingCostCents = cents(order.materializedReturnShippingCost);
  const overheadCents = cents(order.overheadAllocated);
  const contributionProfitCents = cents(order.contributionProfit);
  const netProfitCents = cents(order.netProfit);
  // The materialized contribution identity gives the exact ex-tax revenue the
  // engine used, including return-fee tax treatment, without re-running it.
  const netRevenueCents =
    contributionProfitCents + cogsCents + shippingCostCents + paymentFeeCents +
    pickPackCents + adCostCents + returnShippingCostCents;
  const refundCents = Math.max(
    0,
    grossRevenueCents - discountCents + shippingRevenueCents - netRevenueCents,
  );
  const totalCostCents =
    cogsCents + shippingCostCents + paymentFeeCents + pickPackCents +
    adCostCents + returnShippingCostCents + overheadCents;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    processedAt: order.processedAt,
    channel: order.channel as Channel,
    customerId: order.customerId,
    isFirstOrder: order.isFirstOrder,
    grossRevenueCents,
    discountCents,
    refundCents,
    returnFeesRetainedCents: cents(order.returnFeesRetained),
    shippingRevenueCents,
    netRevenueCents,
    cogsCents,
    shippingCostCents,
    paymentFeeCents,
    pickPackCents,
    adCostCents,
    overheadCents,
    returnShippingCostCents,
    totalCostCents,
    contributionProfitCents,
    netProfitCents,
    contributionMarginPct: ratio(contributionProfitCents, netRevenueCents),
    netMarginPct: ratio(netProfitCents, netRevenueCents),
    units: order.materializedUnits,
    hasMissingCogs: order.materializedMissingCogs,
    usesModeledCosts: order.materializedModeledCosts,
    usesEstimatedCosts:
      order.materializedMissingCogs || order.materializedModeledCosts,
  };
}

export function rollupMaterializedProfits(
  orders: OrderProfit[],
  spend: readonly AdSpendRow[],
): PeriodProfit {
  const sum = (pick: (order: OrderProfit) => number) =>
    orders.reduce((total, order) => total + pick(order), 0);
  const netRevenueCents = sum((order) => order.netRevenueCents);
  const contributionProfitCents = sum((order) => order.contributionProfitCents);
  const attributedAdCostCents = sum((order) => order.adCostCents);
  const platformSpendCents = spend.reduce((total, row) => total + row.spendCents, 0);
  const unattributedAdCostCents = Math.max(0, platformSpendCents - attributedAdCostCents);
  const netProfitCents = sum((order) => order.netProfitCents) - unattributedAdCostCents;
  return {
    orders,
    orderCount: orders.length,
    units: sum((order) => order.units),
    grossRevenueCents: sum((order) => order.grossRevenueCents),
    discountCents: sum((order) => order.discountCents),
    refundCents: sum((order) => order.refundCents),
    returnFeesRetainedCents: sum((order) => order.returnFeesRetainedCents),
    shippingRevenueCents: sum((order) => order.shippingRevenueCents),
    netRevenueCents,
    cogsCents: sum((order) => order.cogsCents),
    shippingCostCents: sum((order) => order.shippingCostCents),
    paymentFeeCents: sum((order) => order.paymentFeeCents),
    pickPackCents: sum((order) => order.pickPackCents),
    attributedAdCostCents,
    unattributedAdCostCents,
    totalAdCostCents: attributedAdCostCents + unattributedAdCostCents,
    returnShippingCostCents: sum((order) => order.returnShippingCostCents),
    overheadCents: sum((order) => order.overheadCents),
    contributionProfitCents,
    netProfitCents,
    contributionMarginPct: ratio(contributionProfitCents, netRevenueCents),
    netMarginPct: ratio(netProfitCents, netRevenueCents),
    averageOrderValueCents: orders.length ? Math.round(netRevenueCents / orders.length) : 0,
    profitPerOrderCents: orders.length ? Math.round(netProfitCents / orders.length) : 0,
  };
}

function leanEngineOrder(order: MaterializedOrder): EngineOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    processedAt: order.processedAt,
    customerId: order.customerId,
    channel: order.channel as Channel,
    campaignId: order.campaignId,
    isFirstOrder: order.isFirstOrder,
    subtotalCents: cents(order.subtotal),
    discountTotalCents: cents(order.discountTotal),
    shippingChargedCents: cents(order.shippingCharged),
    taxTotalCents: cents(order.taxTotal),
    totalCents: cents(order.total),
    refundedTotalCents: cents(order.refundedTotal),
    returnFeesRetainedCents: cents(order.returnFeesRetained),
    lineItems: [],
    actualShippingCostCents: cents(order.materializedOutboundShippingCost),
    actualPickPackCostCents: cents(order.materializedPickPackCost),
    returnShippingCostCents: cents(order.materializedReturnShippingCost),
  };
}

type ProductRollupRow = {
  productId: string;
  title: string;
  imageUrl: string | null;
  productType: string | null;
  vendor: string | null;
  units: bigint;
  ordersContaining: bigint;
  grossRevenue: Prisma.Decimal;
  discount: Prisma.Decimal;
  netRevenue: Prisma.Decimal;
  cogs: Prisma.Decimal;
  shipping: Prisma.Decimal;
  payment: Prisma.Decimal;
  pickPack: Prisma.Decimal;
  adCost: Prisma.Decimal;
  missingCogs: boolean;
  modeledCosts: boolean;
};

async function loadMaterializedProducts(
  shopId: string,
  range: DateRange,
  totalOrders: number,
  totalNetRevenueCents: number,
): Promise<ProductProfit[]> {
  const rows = await prisma.$queryRaw<ProductRollupRow[]>(Prisma.sql`
    WITH line_basis AS (
      SELECT
        li."productId" AS product_id,
        li."orderId" AS order_id,
        GREATEST(li.quantity - li."refundedQty", 0)::numeric AS units,
        (li."unitPrice" * GREATEST(li.quantity - li."refundedQty", 0))::numeric AS gross,
        li.discount::numeric AS discount,
        (li."unitCost" * GREATEST(li.quantity - li."refundedQty", 0))::numeric AS cogs,
        GREATEST(
          li."unitPrice" * GREATEST(li.quantity - li."refundedQty", 0) - li.discount,
          0
        )::numeric AS line_weight,
        SUM(GREATEST(
          li."unitPrice" * GREATEST(li.quantity - li."refundedQty", 0) - li.discount,
          0
        )) OVER (PARTITION BY li."orderId") AS order_weight,
        COUNT(*) OVER (PARTITION BY li."orderId")::numeric AS line_count,
        (li."unitCost" <= 0 AND GREATEST(li.quantity - li."refundedQty", 0) > 0) AS missing_cogs
      FROM "OrderLineItem" li
      JOIN "Order" o ON o.id = li."orderId"
      WHERE li."shopId" = ${shopId}
        AND li."productId" IS NOT NULL
        AND o."processedAt" >= ${range.from}
        AND o."processedAt" <= ${range.to}
        AND o."computedAt" IS NOT NULL
    ), allocated AS (
      SELECT
        b.*,
        CASE WHEN b.order_weight > 0
          THEN b.line_weight / b.order_weight
          ELSE 1 / NULLIF(b.line_count, 0)
        END AS weight,
        o."contributionProfit" + o."cogsTotal"
          + o."materializedOutboundShippingCost"
          + o."materializedPaymentFee"
          + o."materializedPickPackCost"
          + o."adCostAttributed"
          + o."materializedReturnShippingCost" AS order_net_revenue,
        o."materializedOutboundShippingCost" AS shipping,
        o."materializedPaymentFee" AS payment,
        o."materializedPickPackCost" AS pick_pack,
        o."adCostAttributed" AS ad_cost,
        o."materializedModeledCosts" AS modeled_costs
      FROM line_basis b
      JOIN "Order" o ON o.id = b.order_id
    )
    SELECT
      p.id AS "productId",
      p.title,
      p."imageUrl",
      p."productType",
      p.vendor,
      COALESCE(SUM(a.units), 0)::bigint AS units,
      COUNT(DISTINCT a.order_id)::bigint AS "ordersContaining",
      COALESCE(SUM(a.gross), 0)::numeric AS "grossRevenue",
      COALESCE(SUM(a.discount), 0)::numeric AS discount,
      COALESCE(SUM(a.order_net_revenue * a.weight), 0)::numeric AS "netRevenue",
      COALESCE(SUM(a.cogs), 0)::numeric AS cogs,
      COALESCE(SUM(a.shipping * a.weight), 0)::numeric AS shipping,
      COALESCE(SUM(a.payment * a.weight), 0)::numeric AS payment,
      COALESCE(SUM(a.pick_pack * a.weight), 0)::numeric AS "pickPack",
      COALESCE(SUM(a.ad_cost * a.weight), 0)::numeric AS "adCost",
      COALESCE(BOOL_OR(a.missing_cogs), false) AS "missingCogs",
      COALESCE(BOOL_OR(a.modeled_costs), false) AS "modeledCosts"
    FROM allocated a
    JOIN "Product" p ON p.id = a.product_id
    GROUP BY p.id, p.title, p."imageUrl", p."productType", p.vendor
  `);
  return rows.map((row) => {
    const units = Number(row.units);
    const ordersContaining = Number(row.ordersContaining);
    const grossRevenueCents = cents(row.grossRevenue);
    const discountCents = cents(row.discount);
    const netRevenueCents = cents(row.netRevenue);
    const cogsCents = cents(row.cogs);
    const allocatedShippingCents = cents(row.shipping);
    const allocatedPaymentFeeCents = cents(row.payment);
    const allocatedPickPackCents = cents(row.pickPack);
    const allocatedAdCostCents = cents(row.adCost);
    const contributionProfitCents = netRevenueCents - cogsCents -
      allocatedShippingCents - allocatedPaymentFeeCents -
      allocatedPickPackCents - allocatedAdCostCents;
    const marginPct = ratio(contributionProfitCents, netRevenueCents);
    const classification: ProductClass = contributionProfitCents <= 0
      ? "BLEEDING"
      : marginPct !== null && marginPct < 0.1
        ? "THIN_MARGIN"
        : "PROFITABLE";
    return {
      productId: row.productId,
      title: row.title,
      imageUrl: row.imageUrl,
      productType: row.productType,
      vendor: row.vendor,
      units,
      ordersContaining,
      grossRevenueCents,
      discountCents,
      netRevenueCents,
      cogsCents,
      allocatedShippingCents,
      allocatedPaymentFeeCents,
      allocatedPickPackCents,
      allocatedAdCostCents,
      contributionProfitCents,
      marginPct,
      profitPerUnitCents: units ? Math.round(contributionProfitCents / units) : 0,
      hasMissingCogs: row.missingCogs,
      usesModeledCosts: row.modeledCosts,
      classification,
      acquiredCustomers: 0,
      downstreamProfitCents: 0,
      downstreamProfitPerCustomerCents: 0,
      attachRatePct: ratio(ordersContaining, totalOrders),
      revenueSharePct: ratio(netRevenueCents, totalNetRevenueCents),
    };
  }).sort((a, b) => b.contributionProfitCents - a.contributionProfitCents);
}

export async function loadMaterializedShopAnalytics(shop: Shop, range: DateRange) {
  const startedAt = Date.now();
  const [rows, spend, rules, capacityDays] = await Promise.all([
    loadMaterializedRows(shop.id, range),
    loadAdSpend(shop.id, range),
    loadCostRules(shop.id),
    loadCapacityDays(shop.id, range),
  ]);
  const profits = rows.map(toMaterializedOrderProfit);
  const period = rollupMaterializedProfits(profits, spend);
  const engineOrders = rows.map(leanEngineOrder);
  const products = await loadMaterializedProducts(
    shop.id,
    range,
    period.orderCount,
    period.netRevenueCents,
  );
  return {
    shop,
    range,
    rules,
    period,
    products,
    channels: computeChannelPerformance(engineOrders, profits, spend, {
      periodStart: range.from,
      periodEnd: range.to,
    }),
    campaigns: computeCampaignPerformance(engineOrders, profits, spend),
    capacity: analyseCapacity(capacityDays, {
      slaDays: shop.fulfillmentSlaDays,
      today: range.to,
    }),
    computedInMs: Date.now() - startedAt,
  };
}

export async function loadMaterializedPeriodProfit(shopId: string, range: DateRange) {
  const [rows, spend] = await Promise.all([
    loadMaterializedRows(shopId, range),
    loadAdSpend(shopId, range),
  ]);
  return rollupMaterializedProfits(rows.map(toMaterializedOrderProfit), spend);
}
