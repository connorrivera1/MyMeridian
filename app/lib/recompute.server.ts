import { Prisma } from "@prisma/client";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import {
  assertEngineOrderWindow,
  loadAdSpend,
  loadCostRules,
  loadEngineOrders,
  type DateRange,
} from "~/data/queries.server";
import { centsToDollars } from "~/engine/money";
import { computeProfitForPeriod, spendDayKey } from "~/engine/profit";
import type { OrderProfit } from "~/engine/types";
import { withAnalyticsAdmission } from "~/lib/analytics-admission.server";

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
const DAY_MS = 86_400_000;
const SPEND_BOUNDARY_PAD_MS = 36 * 60 * 60 * 1000;

export interface RecomputeResult {
  ordersUpdated: number;
  customersUpdated: number;
  netProfitCents: number;
  unattributedAdSpendCents: number;
  durationMs: number;
}

/**
 * Recompute a shop's whole history. There is deliberately no range parameter.
 *
 * `writeCustomerAggregates` builds `ordersCount`, `lifetimeRevenue`,
 * `lifetimeProfit` and `firstOrderAt` from every normalized order in SQL. The
 * engine materialisation is internally bounded by exact calendar months, but
 * the public operation remains whole-history: exposing a caller-supplied window
 * would still let window totals wear lifetime labels.
 *
 * The parameter used to exist, was optional, and read like a safe incremental
 * knob. Every caller passed nothing, so it never fired; it was a loaded gun
 * left on the table. Anyone who wants an incremental recompute has to solve the
 * lifetime-aggregate problem first, and removing the parameter is what forces
 * that conversation instead of hiding it behind a default.
 */
const recomputesInFlight = new Map<string, Promise<RecomputeResult>>();

export function recomputeShopProfitability(
  shopId: string,
): Promise<RecomputeResult> {
  const existing = recomputesInFlight.get(shopId);
  if (existing) return existing;

  // Release retained full-window rows before this heavy operation waits for
  // admission. Any analytics build already running observes the generation
  // change and refuses to repopulate the cache with its now-stale result.
  invalidateAnalyticsCache();
  const recompute = withAnalyticsAdmission(() => performRecompute(shopId));
  recomputesInFlight.set(shopId, recompute);

  const cleanup = () => {
    if (recomputesInFlight.get(shopId) === recompute) {
      recomputesInFlight.delete(shopId);
    }
  };
  void recompute.then(cleanup, cleanup);

  return recompute;
}

async function performRecompute(shopId: string): Promise<RecomputeResult> {
  const startedAt = Date.now();
  // Freeze the upper bound once. A long recompute must not keep extending its
  // own horizon as it moves month by month, or the final month can include a
  // different set of rows from the month-discovery query.
  const runStartedAt = new Date(startedAt);

  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const timeZone = validTimeZone(shop.timezone);

  // Data is a point-in-time snapshot by processedAt. The extra day belongs to
  // overhead proration only: using it as the row cutoff allowed an order that
  // arrived halfway through a long run to appear in a later month even though
  // month discovery had already finished.
  const dataRange: DateRange = {
    from: new Date(0),
    to: runStartedAt,
  };
  const overheadRangeEnd = new Date(runStartedAt.getTime() + DAY_MS);

  const [monthSlices, earliestOrder, rules] = await Promise.all([
    loadRecomputeMonthSlices(shopId, timeZone, dataRange),
    prisma.order.aggregate({
      where: {
        shopId,
        processedAt: { gte: dataRange.from, lte: dataRange.to },
      },
      _min: { processedAt: true },
    }),
    loadCostRules(shopId),
  ]);

  // The reporting window has to reach computeProfitForPeriod, or allocateOverhead
  // skips its pro-rata branch and charges a whole month of overhead across only
  // the orders that exist so far. On the in-progress month that is roughly nine
  // times too much per order, and it moves every time another order lands.
  //
  // This *same* global window is passed to every monthly build. Overhead is
  // allocated independently per merchant-local calendar month, so a complete
  // month can be computed in isolation, but using each slice as the reporting
  // range would incorrectly charge full overhead to the first and last partial
  // months. Keeping the global range preserves the one-shot engine semantics.
  const overheadRange = earliestOrder._min.processedAt
    ? { from: earliestOrder._min.processedAt, to: overheadRangeEnd }
    : { from: dataRange.from, to: overheadRangeEnd };

  let ordersUpdated = 0;
  let netProfitCents = 0;
  let unattributedAdSpendCents = 0;

  const monthRanges = monthSlices.map((slice) => ({
    slice,
    range: {
      from: slice.from,
      to: new Date(
        Math.min(slice.toExclusive.getTime() - 1, dataRange.to.getTime()),
      ),
    } satisfies DateRange,
  }));

  // Preflight every month before the first materialised write. Without this,
  // January could be rewritten under a new cost rule before an oversized
  // February throws, leaving a mixed old/new-cost ledger with no completion
  // stamp. `loadEngineOrders` repeats the count at hydration time so the guard
  // remains race-safe; the inexpensive duplicate scan buys all-or-nothing
  // admission without holding one enormous transaction open for the full run.
  for (const { range } of monthRanges) {
    await assertEngineOrderWindow(shopId, range);
  }

  // One merchant-local month is the exact independence boundary: ad spend is
  // attributed by local day and overhead is allocated by local month. Loading
  // any smaller unit changes penny allocation; loading any larger unit spends
  // memory without changing an answer. The 60k admission guard therefore now
  // applies to a month, while a shop may have arbitrarily many such months.
  for (const { slice, range } of monthRanges) {
    // `AdSpend.date` is a SQL DATE and buckets by its face value — the
    // calendar day the platform reported — while this month's boundaries are
    // merchant-local instants. Pad the database read across the boundary
    // days both interpretations could touch, then keep exactly the rows whose
    // spend month is this slice, so no first-of-month row is double-loaded or
    // dropped and spend-only months still compute.
    const spendRange: DateRange = {
      from: new Date(
        Math.max(
          dataRange.from.getTime(),
          range.from.getTime() - SPEND_BOUNDARY_PAD_MS,
        ),
      ),
      to: new Date(
        Math.min(
          dataRange.to.getTime(),
          range.to.getTime() + SPEND_BOUNDARY_PAD_MS,
        ),
      ),
    };

    const [orders, spendCandidates] = await Promise.all([
      loadEngineOrders(shopId, range),
      loadAdSpend(shopId, spendRange),
    ]);
    const spend = spendCandidates.filter(
      (row) => spendDayKey(row.date).slice(0, 7) === slice.monthKey,
    );

    const period = computeProfitForPeriod(
      orders,
      spend,
      rules,
      timeZone,
      overheadRange,
    );

    await writeOrderProfits(period.orders);
    ordersUpdated += period.orderCount;
    netProfitCents += period.netProfitCents;
    unattributedAdSpendCents += period.unattributedAdCostCents;
  }

  // Customer lifetime fields are one SQL aggregation over the freshly
  // materialised rows. No whole-history order graph or customer Map survives
  // the month loop, and customers with no linked orders are reset as well. The
  // SQL uses the same processedAt cutoff as the month loaders: a later order
  // cannot enter lifetime totals with default/stale materialised profit.
  //
  // This is a temporal cutoff, not an MVCC snapshot. A delayed historical row
  // inserted during the run with processedAt before the cutoff can still race
  // it; production backfill avoids that by invoking recompute only after import
  // completes. Fully serialising arbitrary external writers would require a
  // shared shop lock or one long repeatable-read transaction.
  const customersUpdated = await writeCustomerAggregates(shopId, runStartedAt);

  await prisma.shop.update({
    where: { id: shopId },
    // This is the data cutoff, not the wall-clock completion time. Calling a
    // ten-minute run "computed now" would overstate freshness by ten minutes.
    data: { lastComputedAt: runStartedAt },
  });

  return {
    ordersUpdated,
    customersUpdated,
    netProfitCents,
    unattributedAdSpendCents,
    durationMs: Date.now() - startedAt,
  };
}

interface RecomputeMonthSlice {
  monthKey: string;
  from: Date;
  toExclusive: Date;
}

function validTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Discover only the merchant-local months that contain an order or ad spend.
 *
 * The boundaries come back as real instants. Constructing them with UTC month
 * arithmetic would be wrong for every non-UTC shop and especially around DST;
 * Postgres' IANA timezone database performs the calendar conversion directly.
 */
async function loadRecomputeMonthSlices(
  shopId: string,
  timeZone: string,
  range: DateRange,
): Promise<RecomputeMonthSlice[]> {
  return prisma.$queryRaw<RecomputeMonthSlice[]>`
    WITH month_keys AS (
      SELECT DISTINCT to_char(
        (o."processedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone},
        'YYYY-MM'
      ) AS month_key
      FROM "Order" AS o
      WHERE o."shopId" = ${shopId}
        AND o."processedAt" >= ${range.from}
        AND o."processedAt" <= ${range.to}

      UNION

      -- Spend months come from the date's face value: a DATE column is the
      -- platform's calendar day, not an instant to convert.
      SELECT DISTINCT to_char(a."date", 'YYYY-MM') AS month_key
      FROM "AdSpend" AS a
      WHERE a."shopId" = ${shopId}
        AND a."date" >= ${range.from}
        AND a."date" <= ${range.to}
    )
    SELECT
      month_key AS "monthKey",
      (to_date(month_key || '-01', 'YYYY-MM-DD')::timestamp
        AT TIME ZONE ${timeZone}) AS "from",
      ((to_date(month_key || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')::timestamp
        AT TIME ZONE ${timeZone}) AS "toExclusive"
    FROM month_keys
    WHERE month_key IS NOT NULL
    ORDER BY month_key ASC
  `;
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
        ${centsToDollars(p.shippingCostCents + p.returnShippingCostCents)}::numeric,
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
  cutoff: Date,
): Promise<number> {
  // Revenue is reconstructed from the normalized order inputs, not from an
  // accumulated JavaScript Map. The refund expression deliberately rounds *per
  // order* before SUM, exactly like computeOrderProfit:
  //
  //   Math.round(refundedTotalCents * (totalCents - taxTotalCents) / totalCents)
  //
  // Moving the rounding outside SUM changes indivisible pennies across orders.
  // All source money columns are two-decimal NUMERICs, so multiplying by 100 is
  // an exact integer-cent conversion. `FLOOR(x + 0.5)` is Math.round for both
  // signs (Postgres ROUND differs from JavaScript at negative half-pennies).
  // Contribution profit is already materialised in cents by writeOrderProfits
  // above and can be summed directly.
  //
  // Starting from Customer and LEFT JOINing Order is intentional: a customer
  // whose last order was detached or deleted must be reset to zero/null rather
  // than retaining yesterday's lifetime values forever.
  return prisma.$executeRaw`
    WITH aggregates AS (
      SELECT
        c.id AS customer_id,
        COUNT(o.id)::integer AS orders_count,
        COALESCE(
          SUM(
            o.subtotal
            - o."discountTotal"
            + o."shippingCharged"
            - CASE
                WHEN o.total > 0 THEN
                  FLOOR(
                    (o."refundedTotal" * 100)
                    * ((o.total - o."taxTotal") / o.total)
                    + 0.5
                  ) / 100
                ELSE o."refundedTotal"
              END
          ),
          0
        ) AS lifetime_revenue,
        COALESCE(SUM(o."contributionProfit"), 0) AS lifetime_profit,
        MIN(o."processedAt") AS first_order_at
      FROM "Customer" AS c
      LEFT JOIN "Order" AS o
        ON o."customerId" = c.id
       AND o."shopId" = c."shopId"
       AND o."processedAt" <= (
         ${cutoff}::timestamptz AT TIME ZONE 'UTC'
       )
      WHERE c."shopId" = ${shopId}
      GROUP BY c.id
    )
    UPDATE "Customer" AS c SET
      "ordersCount"     = a.orders_count,
      "lifetimeRevenue" = a.lifetime_revenue,
      "lifetimeProfit"  = a.lifetime_profit,
      "firstOrderAt"    = a.first_order_at
    FROM aggregates AS a
    WHERE c.id = a.customer_id
      AND c."shopId" = ${shopId}
  `;
}
