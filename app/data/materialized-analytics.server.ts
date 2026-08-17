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

export type ProductRollupRow = {
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
  returnShipping: Prisma.Decimal;
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
        CASE WHEN li.quantity > 0 THEN
          li.discount * GREATEST(li.quantity - li."refundedQty", 0) / li.quantity
          ELSE 0
        END::numeric AS discount,
        (li."unitCost" * GREATEST(li.quantity - li."refundedQty", 0))::numeric AS cogs,
        GREATEST(
          li."unitPrice" * GREATEST(li.quantity - li."refundedQty", 0) -
            CASE WHEN li.quantity > 0 THEN
              li.discount * GREATEST(li.quantity - li."refundedQty", 0) / li.quantity
              ELSE 0
            END,
          0
        )::numeric AS line_weight,
        SUM(GREATEST(
          li."unitPrice" * GREATEST(li.quantity - li."refundedQty", 0) -
            CASE WHEN li.quantity > 0 THEN
              li.discount * GREATEST(li.quantity - li."refundedQty", 0) / li.quantity
              ELSE 0
            END,
          0
        )) OVER (PARTITION BY li."orderId") AS order_weight,
        COUNT(*) OVER (PARTITION BY li."orderId")::numeric AS line_count,
        (NOT li."cogsKnown" AND GREATEST(li.quantity - li."refundedQty", 0) > 0) AS missing_cogs
      FROM "OrderLineItem" li
      JOIN "Order" o ON o.id = li."orderId"
      WHERE li."shopId" = ${shopId}
        AND li."productId" IS NOT NULL
        -- processedAt is "timestamp without time zone" holding UTC wall clock.
        -- A bound JS Date arrives as timestamptz, and comparing the two makes
        -- Postgres render the instant in the session timezone first — so an
        -- America/New_York session silently moves both ends of the window four
        -- or five hours earlier and drops the tail of the range. The order-side
        -- loader goes through Prisma's typed filters and does not shift, so the
        -- two halves of this screen disagreed. Same idiom as the customer
        -- rollup in recompute.server.ts.
        AND o."processedAt" >= (${range.from}::timestamptz AT TIME ZONE 'UTC')
        AND o."processedAt" <= (${range.to}::timestamptz AT TIME ZONE 'UTC')
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
        o."materializedReturnShippingCost" AS return_shipping,
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
      COALESCE(SUM(a.return_shipping * a.weight), 0)::numeric AS "returnShipping",
      COALESCE(BOOL_OR(a.missing_cogs), false) AS "missingCogs",
      COALESCE(BOOL_OR(a.modeled_costs), false) AS "modeledCosts"
    FROM allocated a
    JOIN "Product" p ON p.id = a.product_id
    GROUP BY p.id, p.title, p."imageUrl", p."productType", p.vendor
  `);
  return productProfitsFromRollups(rows, totalOrders, totalNetRevenueCents);
}

/**
 * The money columns of a product rollup, in exact cents.
 *
 * Every one of these is a fractional-dollar figure in Postgres: `grossRevenue`
 * and `cogs` because unit prices and costs carry four decimal places, and the
 * five allocated cost columns because they are an order-level dollar amount
 * multiplied by a line's share of that order.
 */
const PRODUCT_MONEY_FIELDS = [
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

type ProductMoneyField = (typeof PRODUCT_MONEY_FIELDS)[number];

type ProductRollupCents = Record<ProductMoneyField, number>;

/**
 * Round one money column across the whole result set without inventing or
 * losing pennies against the total the query produced.
 *
 * Rounding each product independently is what a per-row `Math.round` does, and
 * it does not conserve the aggregate: an order's shipping cost split across
 * three products arrives as three fractional cents that each round to zero, so
 * the Products screen reports nothing where the ledger charged a cent. The
 * error is unbounded in the number of products, and it is signed — the rows can
 * just as easily sum to a cent more than the order ledger holds.
 *
 * So the column is rounded once, as a whole, using the largest-remainder
 * method: floor every row, then hand the leftover pennies to the rows with the
 * largest discarded fractions. `Math.floor` rather than `Math.trunc` is load
 * bearing — allocated columns go negative on a refund-heavy window, and only
 * flooring keeps every fraction in `[0, 1)` so that one comparison orders
 * positive and negative rows alike.
 */
export function allocateRollupCents(exact: readonly number[]): number[] {
  const values = exact.map((value) => (Number.isFinite(value) ? value : 0));
  const floors = values.map((value) => Math.floor(value));
  const target = Math.round(values.reduce((sum, value) => sum + value, 0));
  let remainder = target - floors.reduce((sum, value) => sum + value, 0);
  if (remainder <= 0 || values.length === 0) return floors;

  const byFraction = values
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const { index } of byFraction) {
    if (remainder === 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

export function productProfitsFromRollups(
  rows: readonly ProductRollupRow[],
  totalOrders: number,
  totalNetRevenueCents: number,
): ProductProfit[] {
  const allocated = new Map<ProductMoneyField, number[]>(
    PRODUCT_MONEY_FIELDS.map((field) => [
      field,
      allocateRollupCents(rows.map((row) => Number(row[field] ?? 0) * 100)),
    ]),
  );

  return rows
    .map((row, index) =>
      productProfitFromCents(
        row,
        Object.fromEntries(
          PRODUCT_MONEY_FIELDS.map((field) => [
            field,
            allocated.get(field)?.[index] ?? 0,
          ]),
        ) as ProductRollupCents,
        totalOrders,
        totalNetRevenueCents,
      ),
    )
    .sort((a, b) => b.contributionProfitCents - a.contributionProfitCents);
}

export function productProfitFromRollup(
  row: ProductRollupRow,
  totalOrders: number,
  totalNetRevenueCents: number,
): ProductProfit {
  return productProfitFromCents(
    row,
    Object.fromEntries(
      PRODUCT_MONEY_FIELDS.map((field) => [field, cents(row[field])]),
    ) as ProductRollupCents,
    totalOrders,
    totalNetRevenueCents,
  );
}

function productProfitFromCents(
  row: ProductRollupRow,
  amounts: ProductRollupCents,
  totalOrders: number,
  totalNetRevenueCents: number,
): ProductProfit {
  const units = Number(row.units);
  const ordersContaining = Number(row.ordersContaining);
  const grossRevenueCents = amounts.grossRevenue;
  const discountCents = amounts.discount;
  const netRevenueCents = amounts.netRevenue;
  const cogsCents = amounts.cogs;
  const allocatedShippingCents = amounts.shipping;
  const allocatedPaymentFeeCents = amounts.payment;
  const allocatedPickPackCents = amounts.pickPack;
  const allocatedAdCostCents = amounts.adCost;
  const allocatedReturnShippingCents = amounts.returnShipping;
  const contributionProfitCents =
    netRevenueCents -
    cogsCents -
    allocatedShippingCents -
    allocatedPaymentFeeCents -
    allocatedPickPackCents -
    allocatedAdCostCents -
    allocatedReturnShippingCents;
  const marginPct = ratio(contributionProfitCents, netRevenueCents);
  const classification: ProductClass =
    contributionProfitCents <= 0
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
    allocatedReturnShippingCents,
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
