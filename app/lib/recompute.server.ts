import { Prisma } from "@prisma/client";

import prisma from "~/db.server";
import {
  loadAdSpend,
  loadCostRules,
  loadEngineOrders,
  type DateRange,
} from "~/data/queries.server";
import { centsToDollars } from "~/engine/money";
import { computeProfitForPeriod } from "~/engine/profit";
import type { OrderProfit } from "~/engine/types";

/**
 * Materialise per-order profit.
 *
 * The dashboard cannot re-derive six months of order economics on every page
 * load, so the engine's output is written back onto the orders. Anything that
 * invalidates the result — a changed cost rule, a new ad spend import, a
 * refund — re-runs this.
 *
 * Seeding and production share this exact path, so demo data is produced by the
 * same code that will run against a real store.
 */

const WRITE_CHUNK = 500;

export interface RecomputeResult {
  ordersUpdated: number;
  customersUpdated: number;
  netProfitCents: number;
  unattributedAdSpendCents: number;
  durationMs: number;
}

export async function recomputeShopProfitability(
  shopId: string,
  range?: DateRange,
): Promise<RecomputeResult> {
  const startedAt = Date.now();

  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

  const effectiveRange: DateRange = range ?? {
    from: new Date(0),
    to: new Date(Date.now() + 86_400_000),
  };

  const [orders, spend, rules] = await Promise.all([
    loadEngineOrders(shopId, effectiveRange),
    loadAdSpend(shopId, effectiveRange),
    loadCostRules(shopId),
  ]);

  const period = computeProfitForPeriod(orders, spend, rules, shop.timezone);

  await writeOrderProfits(period.orders);
  const customersUpdated = await writeCustomerAggregates(shopId, period.orders);

  await prisma.shop.update({
    where: { id: shopId },
    data: { lastComputedAt: new Date() },
  });

  return {
    ordersUpdated: period.orders.length,
    customersUpdated,
    netProfitCents: period.netProfitCents,
    unattributedAdSpendCents: period.unattributedAdCostCents,
    durationMs: Date.now() - startedAt,
  };
}

async function writeOrderProfits(profits: readonly OrderProfit[]) {
  for (let i = 0; i < profits.length; i += WRITE_CHUNK) {
    const chunk = profits.slice(i, i + WRITE_CHUNK);

    // One statement per chunk rather than one per order: at eight thousand
    // orders the round trips dominate everything else.
    const rows = chunk.map(
      (p) => Prisma.sql`(
        ${p.orderId}::text,
        ${centsToDollars(p.cogsCents)}::numeric,
        ${centsToDollars(p.shippingCostCents)}::numeric,
        ${centsToDollars(p.paymentFeeCents + p.pickPackCents)}::numeric,
        ${centsToDollars(p.adCostCents)}::numeric,
        ${centsToDollars(p.overheadCents)}::numeric,
        ${centsToDollars(p.contributionProfitCents)}::numeric,
        ${centsToDollars(p.netProfitCents)}::numeric
      )`,
    );

    await prisma.$executeRaw`
      UPDATE "Order" AS o SET
        "cogsTotal"          = v.cogs,
        "shippingCost"       = v.shipping,
        "paymentFee"         = v.fees,
        "adCostAttributed"   = v.ad_cost,
        "overheadAllocated"  = v.overhead,
        "contributionProfit" = v.contribution,
        "netProfit"          = v.net,
        "computedAt"         = NOW()
      FROM (VALUES ${Prisma.join(rows)})
        AS v(id, cogs, shipping, fees, ad_cost, overhead, contribution, net)
      WHERE o.id = v.id
    `;
  }
}

async function writeCustomerAggregates(
  shopId: string,
  profits: readonly OrderProfit[],
): Promise<number> {
  const byCustomer = new Map<
    string,
    { orders: number; revenueCents: number; profitCents: number; firstAt: Date }
  >();

  for (const profit of profits) {
    if (!profit.customerId) continue;

    const current = byCustomer.get(profit.customerId);
    if (current) {
      current.orders += 1;
      current.revenueCents += profit.netRevenueCents;
      current.profitCents += profit.contributionProfitCents;
      if (profit.processedAt < current.firstAt) current.firstAt = profit.processedAt;
    } else {
      byCustomer.set(profit.customerId, {
        orders: 1,
        revenueCents: profit.netRevenueCents,
        profitCents: profit.contributionProfitCents,
        firstAt: profit.processedAt,
      });
    }
  }

  const entries = [...byCustomer.entries()];

  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    const chunk = entries.slice(i, i + WRITE_CHUNK);

    const rows = chunk.map(
      ([customerId, agg]) => Prisma.sql`(
        ${customerId}::text,
        ${agg.orders}::integer,
        ${centsToDollars(agg.revenueCents)}::numeric,
        ${centsToDollars(agg.profitCents)}::numeric,
        ${agg.firstAt}::timestamp
      )`,
    );

    await prisma.$executeRaw`
      UPDATE "Customer" AS c SET
        "ordersCount"     = v.orders_count,
        "lifetimeRevenue" = v.revenue,
        "lifetimeProfit"  = v.profit,
        "firstOrderAt"    = v.first_at
      FROM (VALUES ${Prisma.join(rows)})
        AS v(id, orders_count, revenue, profit, first_at)
      WHERE c.id = v.id AND c."shopId" = ${shopId}
    `;
  }

  return entries.length;
}
