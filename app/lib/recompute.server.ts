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

  // The reporting window has to reach computeProfitForPeriod, or allocateOverhead
  // skips its pro-rata branch and charges a whole month of overhead across only
  // the orders that exist so far. On the in-progress month that is roughly nine
  // times too much per order, and it moves every time another order lands.
  //
  // Bounded to the orders actually loaded rather than the epoch-wide default
  // range: allocateOverhead walks the window a day at a time, and starting at
  // the epoch would be tens of thousands of pointless iterations.
  const earliestOrder = orders.reduce<Date | null>(
    (min, order) => (!min || order.processedAt < min ? order.processedAt : min),
    null,
  );

  const overheadRange = earliestOrder
    ? { from: earliestOrder, to: effectiveRange.to }
    : effectiveRange;

  const period = computeProfitForPeriod(
    orders,
    spend,
    rules,
    shop.timezone,
    overheadRange,
  );

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

    // `firstOrderAt` is cast through `timestamptz`, not straight to `timestamp`.
    //
    // The column is `timestamp without time zone` holding UTC, which is what
    // every other writer puts there — `syncCustomer`, `reconcileFirstOrder` and
    // the backfill all write it through Prisma, which binds a `Date` as UTC.
    // Casting a bound `Date` directly to `::timestamp` instead renders it in the
    // *session* time zone and drops the offset, so this statement wrote a value
    // shifted by whatever `TimeZone` the connection happened to have. On this
    // machine (`America/New_York`) that is four hours, and it is not even a
    // constant — the offset follows DST, so orders either side of a transition
    // shift by different amounts.
    //
    // That made `recompute` a second writer with a second meaning for one
    // column: `reconcileFirstOrder` would settle a customer's first order
    // correctly and the next recompute would move it. It stayed invisible here
    // because a server running in UTC has a zero offset, which is the one
    // configuration where the bug does nothing.
    //
    // `::timestamptz` binds the instant correctly, and `AT TIME ZONE 'UTC'`
    // renders it back to a naive timestamp in UTC — the same value Prisma writes.
    const rows = chunk.map(
      ([customerId, agg]) => Prisma.sql`(
        ${customerId}::text,
        ${agg.orders}::integer,
        ${centsToDollars(agg.revenueCents)}::numeric,
        ${centsToDollars(agg.profitCents)}::numeric,
        ${agg.firstAt}::timestamptz AT TIME ZONE 'UTC'
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
