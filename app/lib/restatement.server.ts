import {
  PeriodStatus,
  Prisma,
  RecalcJobKind,
  type RecalcJob,
} from "@prisma/client";
import { z } from "zod";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { centsToDollars, toCents } from "~/engine/money";
import { enqueueRecalcJob } from "~/lib/recalc-queue.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";

/**
 * The historical recalculation engine.
 *
 * Correcting a cost you got wrong is table stakes; doing it without destroying
 * the numbers you already reported is the hard part. A merchant who filed on
 * March, paid a partner on March, or briefed an investor on March's margin
 * needs the correction to *be* a correction — visible, bounded and reversible
 * in the sense that the original figures still exist somewhere.
 *
 * So a restatement is four things in a fixed order:
 *
 *   1. Freeze. Any affected month with no `PeriodSnapshot` gets one, holding
 *      the figures as they were reported. Those numbers are then immutable.
 *   2. Refuse. A month the merchant has CLOSED is not restated unless the
 *      request names closed periods explicitly, and the refusal happens before
 *      any write, so a five-month window cannot half-apply.
 *   3. Rewrite. Line-item COGS is re-derived from the cost timeline at each
 *      order's own `processedAt` — never from today's cost — and the profit
 *      engine re-materialises from there.
 *   4. Record. Every month that moved gets an append-only `PeriodRestatement`
 *      saying what it said before, what it says now, and why.
 *
 * None of this runs on a request thread. It is a `RecalcJob`.
 */

const MONTH_KEY = /^\d{4}-\d{2}$/;

export class ClosedPeriodError extends Error {
  constructor(readonly periodKeys: readonly string[]) {
    super(
      `This change reaches into ${periodKeys.length} closed period(s): ` +
        `${periodKeys.join(", ")}. Reopen them, or confirm the restatement ` +
        `explicitly, before their reported figures can move.`,
    );
    this.name = "ClosedPeriodError";
  }
}

export interface PeriodBounds {
  periodKey: string;
  from: Date;
  toExclusive: Date;
}

export interface PeriodFigures {
  periodKey: string;
  orderCount: number;
  units: number;
  netRevenueCents: number;
  cogsCents: number;
  contributionProfitCents: number;
  netProfitCents: number;
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
 * Every merchant-local calendar month the window touches, with exact bounds.
 *
 * Whole months, not the window: restating from the 15th still moves that
 * month's total, and a period whose figures moved must be snapshotted and
 * logged in full or the audit trail lies by omission.
 *
 * The calendar arithmetic is Postgres', not JavaScript's. Stepping a month at a
 * time in UTC is wrong for every non-UTC shop and wrong twice a year for all of
 * them; this is the same conversion `loadRecomputeMonthSlices` uses, so a
 * snapshot boundary and an engine boundary are the same boundary.
 */
export async function periodsInWindow(
  timeZone: string,
  from: Date,
  to: Date,
): Promise<PeriodBounds[]> {
  const zone = validTimeZone(timeZone);
  return prisma.$queryRaw<PeriodBounds[]>`
    SELECT
      to_char(d, 'YYYY-MM') AS "periodKey",
      (d::timestamp AT TIME ZONE ${zone}) AS "from",
      ((d + INTERVAL '1 month')::timestamp AT TIME ZONE ${zone}) AS "toExclusive"
    FROM generate_series(
      date_trunc('month', (${from}::timestamptz AT TIME ZONE ${zone})),
      date_trunc('month', (${to}::timestamptz AT TIME ZONE ${zone})),
      INTERVAL '1 month'
    ) AS d
  `;
}

interface RawFigures {
  periodKey: string;
  orderCount: number;
  units: number;
  netRevenue: Prisma.Decimal;
  cogs: Prisma.Decimal;
  contributionProfit: Prisma.Decimal;
  netProfit: Prisma.Decimal;
}

/**
 * What each period currently says, read from the materialised order columns.
 *
 * The revenue expression is the same one `writeCustomerAggregates` uses, down
 * to rounding the ex-tax refund share per order before summing. Two different
 * definitions of "net revenue" in one codebase is how a reconciliation report
 * ends up off by pennies that nobody can explain.
 *
 * Net profit here is the sum over orders and therefore excludes ad spend that
 * attributed to no order. That is deliberate: a period snapshot answers "what
 * did these orders say", and unattributed spend belongs to the period-level
 * engine result, not to any order in it.
 */
export async function readPeriodFigures(
  shopId: string,
  timeZone: string,
  periods: readonly PeriodBounds[],
): Promise<Map<string, PeriodFigures>> {
  const result = new Map<string, PeriodFigures>();
  if (periods.length === 0) return result;

  const zone = validTimeZone(timeZone);
  const from = new Date(
    Math.min(...periods.map((period) => period.from.getTime())),
  );
  const toExclusive = new Date(
    Math.max(...periods.map((period) => period.toExclusive.getTime())),
  );

  const rows = await prisma.$queryRaw<RawFigures[]>`
    SELECT
      to_char(
        (o."processedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone},
        'YYYY-MM'
      ) AS "periodKey",
      COUNT(*)::int AS "orderCount",
      COALESCE(SUM(u.units), 0)::int AS "units",
      COALESCE(SUM(
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
      ), 0) AS "netRevenue",
      COALESCE(SUM(o."cogsTotal"), 0) AS "cogs",
      COALESCE(SUM(o."contributionProfit"), 0) AS "contributionProfit",
      COALESCE(SUM(o."netProfit"), 0) AS "netProfit"
    FROM "Order" AS o
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        SUM(GREATEST(0, l.quantity - l."refundedQty")), 0
      )::int AS units
      FROM "OrderLineItem" AS l
      WHERE l."orderId" = o.id
    ) AS u ON TRUE
    WHERE o."shopId" = ${shopId}
      AND o."processedAt" >= ${from}
      AND o."processedAt" < ${toExclusive}
    GROUP BY 1
  `;

  const wanted = new Set(periods.map((period) => period.periodKey));
  for (const row of rows) {
    if (!wanted.has(row.periodKey)) continue;
    result.set(row.periodKey, {
      periodKey: row.periodKey,
      orderCount: row.orderCount,
      units: row.units,
      netRevenueCents: toCents(row.netRevenue),
      cogsCents: toCents(row.cogs),
      contributionProfitCents: toCents(row.contributionProfit),
      netProfitCents: toCents(row.netProfit),
    });
  }

  return result;
}

/**
 * Freeze the as-reported figures for any period that has not been frozen yet.
 *
 * Only ever creates. An existing snapshot is the record of what was published
 * and must survive every later correction — updating it would turn the audit
 * trail into a second copy of the live numbers, which is no audit trail at all.
 */
export async function freezePeriodSnapshots(
  shopId: string,
  figures: ReadonlyMap<string, PeriodFigures>,
): Promise<number> {
  if (figures.size === 0) return 0;

  const created = await prisma.periodSnapshot.createMany({
    data: [...figures.values()].map((period) => ({
      shopId,
      periodKey: period.periodKey,
      orderCount: period.orderCount,
      units: period.units,
      netRevenue: centsToDollars(period.netRevenueCents),
      cogs: centsToDollars(period.cogsCents),
      contributionProfit: centsToDollars(period.contributionProfitCents),
      netProfit: centsToDollars(period.netProfitCents),
    })),
    skipDuplicates: true,
  });

  return created.count;
}

interface AffectedPeriod {
  periodKey: string;
  lineItemsAffected: number;
  ordersAffected: number;
}

/**
 * Re-snapshot line-item COGS from the cost timeline, order by order.
 *
 * The lateral picks the cost version in effect at that order's own
 * `processedAt` — the whole point, and the reason this cannot be a simple
 * `SET unitCost = variant.unitCost`. A line whose variant has no cost version
 * at or before the order simply keeps what it had: an April correction says
 * nothing about a February order, and inventing a value for it would be the
 * corruption this engine exists to prevent.
 *
 * Only lines whose cost actually moves are touched, so the returned counts mean
 * "changed", not "considered", and re-running a restatement is a no-op.
 */
/**
 * The candidate set: every line whose COGS would move, and to what.
 *
 * Shared verbatim between the dry count and the rewrite so the two can never
 * disagree about what "affected" means — a preflight that selects a different
 * set from the statement it is protecting is worse than no preflight.
 */
function candidateLineItems(
  shopId: string,
  zone: string,
  from: Date,
  toExclusive: Date,
  variantIds: readonly string[] | null,
): Prisma.Sql {
  const variantFilter =
    variantIds && variantIds.length > 0
      ? Prisma.sql`AND li."variantId" IN (${Prisma.join([...variantIds])})`
      : Prisma.empty;

  return Prisma.sql`
    SELECT
      li.id AS line_id,
      o.id AS order_id,
      to_char(
        (o."processedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone},
        'YYYY-MM'
      ) AS period_key,
      c."unitCost" AS new_cost,
      c."effectiveAt" AS cost_effective_at
    FROM "OrderLineItem" AS li
    JOIN "Order" AS o ON o.id = li."orderId"
    CROSS JOIN LATERAL (
      SELECT vc."unitCost", vc."effectiveAt"
      FROM "VariantCost" AS vc
      WHERE vc."variantId" = li."variantId"
        AND vc."effectiveAt" <= o."processedAt"
      ORDER BY vc."effectiveAt" DESC
      LIMIT 1
    ) AS c
    WHERE li."shopId" = ${shopId}
      AND o."processedAt" >= ${from}
      AND o."processedAt" < ${toExclusive}
      AND li."variantId" IS NOT NULL
      ${variantFilter}
      AND li."unitCost" IS DISTINCT FROM c."unitCost"
  `;
}

/**
 * How many lines a restatement would move, without moving any of them.
 *
 * This exists so the expensive part can be skipped entirely when a merchant
 * restates a window nothing has changed in — which is the common case for a
 * repeat click, and which used to cost a full recompute to discover.
 */
async function countPendingCostChanges(
  shopId: string,
  zone: string,
  from: Date,
  toExclusive: Date,
  variantIds: readonly string[] | null,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ pending: bigint }[]>`
    WITH candidate AS (
      ${candidateLineItems(shopId, zone, from, toExclusive, variantIds)}
    )
    SELECT COUNT(*)::bigint AS pending FROM candidate
  `;
  return Number(rows[0]?.pending ?? 0);
}

async function rewriteLineItemCosts(
  shopId: string,
  timeZone: string,
  from: Date,
  toExclusive: Date,
  variantIds: readonly string[] | null,
  now: Date,
): Promise<AffectedPeriod[]> {
  const zone = validTimeZone(timeZone);

  return prisma.$queryRaw<AffectedPeriod[]>`
    WITH candidate AS (
      ${candidateLineItems(shopId, zone, from, toExclusive, variantIds)}
    ),
    updated AS (
      UPDATE "OrderLineItem" AS li
      SET
        "unitCost" = candidate.new_cost,
        "costEffectiveAt" = candidate.cost_effective_at,
        "costRestatedAt" = ${now}
      FROM candidate
      WHERE li.id = candidate.line_id
      RETURNING candidate.period_key AS period_key, candidate.order_id AS order_id
    )
    SELECT
      period_key AS "periodKey",
      COUNT(*)::int AS "lineItemsAffected",
      COUNT(DISTINCT order_id)::int AS "ordersAffected"
    FROM updated
    GROUP BY period_key
  `;
}

export interface RestatementRequest {
  shopId: string;
  /** Left edge — normally the divergence instant a cost edit reported. */
  from: Date;
  /** Right edge, defaulting to now. */
  to?: Date;
  /** Restrict to these variants; omit for every variant in the window. */
  variantIds?: readonly string[] | null;
  reason: string;
  /** Required to move a period the merchant has closed. */
  includeClosedPeriods?: boolean;
  /** Set when the work is running under a queued job. */
  jobId?: string | null;
}

export interface RestatementSummary {
  periodsConsidered: string[];
  periodsFrozen: number;
  periodsRestated: {
    periodKey: string;
    ordersAffected: number;
    lineItemsAffected: number;
    cogsDeltaCents: number;
    netProfitDeltaCents: number;
  }[];
  lineItemsAffected: number;
  ordersAffected: number;
  skipped: boolean;
}

/**
 * Apply a restatement across the window, or refuse it whole.
 *
 * Refusal is all-or-nothing by design, and for the same reason the recompute
 * preflights every month before writing any of them: a partly-applied
 * restatement leaves a ledger where March is on the new cost basis and April is
 * on the old one, with nothing on either row to say so.
 */
export async function restateCosts(
  request: RestatementRequest,
): Promise<RestatementSummary> {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: request.shopId },
    select: { id: true, timezone: true },
  });
  const timeZone = validTimeZone(shop.timezone);

  const to = request.to ?? new Date();
  if (request.from.getTime() > to.getTime()) {
    return {
      periodsConsidered: [],
      periodsFrozen: 0,
      periodsRestated: [],
      lineItemsAffected: 0,
      ordersAffected: 0,
      skipped: true,
    };
  }

  const periods = await periodsInWindow(timeZone, request.from, to);
  if (periods.length === 0) {
    return {
      periodsConsidered: [],
      periodsFrozen: 0,
      periodsRestated: [],
      lineItemsAffected: 0,
      ordersAffected: 0,
      skipped: true,
    };
  }

  const periodKeys = periods.map((period) => period.periodKey);

  // Refuse before writing anything, including before freezing: a closed period
  // is a statement that these numbers are final, and taking a snapshot of one
  // would imply an intention to move it.
  if (!request.includeClosedPeriods) {
    const closed = await prisma.periodSnapshot.findMany({
      where: {
        shopId: shop.id,
        periodKey: { in: periodKeys },
        status: PeriodStatus.CLOSED,
      },
      select: { periodKey: true },
    });
    if (closed.length > 0) {
      throw new ClosedPeriodError(closed.map((row) => row.periodKey));
    }
  }

  // What the merchant actually saw, frozen before anything at all happens.
  const asReported = await readPeriodFigures(shop.id, timeZone, periods);
  const periodsFrozen = await freezePeriodSnapshots(shop.id, asReported);

  const now = new Date();
  const windowFrom = new Date(
    Math.min(...periods.map((period) => period.from.getTime())),
  );
  const windowToExclusive = new Date(
    Math.max(...periods.map((period) => period.toExclusive.getTime())),
  );

  const scopedVariantIds =
    request.variantIds && request.variantIds.length > 0
      ? [...request.variantIds]
      : null;

  // Nothing to do is worth discovering cheaply. A repeat click on a window that
  // has already been restated is the common case, and it used to cost two full
  // recomputes to find that out.
  const pending = await countPendingCostChanges(
    shop.id,
    timeZone,
    windowFrom,
    windowToExclusive,
    scopedVariantIds,
  );
  if (pending === 0) {
    return {
      periodsConsidered: periodKeys,
      periodsFrozen,
      periodsRestated: [],
      lineItemsAffected: 0,
      ordersAffected: 0,
      skipped: false,
    };
  }

  // Bring the materialised ledger up to date *before* measuring the baseline.
  //
  // Without this the recorded delta silently absorbs anything else that had
  // drifted since the last recompute — and one thing always has: monthly
  // overhead is prorated across the days a period covers, so the in-progress
  // month's allocation moves every single day whether or not a cost changed.
  // Measured on a real store, a $180 COGS correction reported an $8,002 fall in
  // net profit, of which $7,822 was overhead catching up. A restatement log
  // that attributes unrelated drift to the merchant's correction is worse than
  // no log, because it is confidently wrong about the one number it exists to
  // explain.
  //
  // The snapshot above is deliberately taken before this: it records what was
  // reported, which is a different question from what this restatement did.
  await recomputeShopProfitability(shop.id);
  const before = await readPeriodFigures(shop.id, timeZone, periods);

  const affected = await rewriteLineItemCosts(
    shop.id,
    timeZone,
    // The rewrite covers whole periods too. A window opening mid-month would
    // otherwise leave the first half of March on the old basis and the second
    // half on the new one, inside a single month's reported total.
    windowFrom,
    windowToExclusive,
    scopedVariantIds,
    now,
  );

  const lineItemsAffected = affected.reduce(
    (sum, period) => sum + period.lineItemsAffected,
    0,
  );

  if (lineItemsAffected === 0) {
    // The preflight said there was work and the rewrite found none, which means
    // another writer got there first. Nothing to record.
    return {
      periodsConsidered: periodKeys,
      periodsFrozen,
      periodsRestated: [],
      lineItemsAffected: 0,
      ordersAffected: 0,
      skipped: false,
    };
  }

  await recomputeShopProfitability(shop.id);
  invalidateAnalyticsCache();

  const after = await readPeriodFigures(shop.id, timeZone, periods);

  const snapshots = await prisma.periodSnapshot.findMany({
    where: { shopId: shop.id, periodKey: { in: affected.map((p) => p.periodKey) } },
    select: { id: true, periodKey: true },
  });
  const snapshotByKey = new Map(
    snapshots.map((snapshot) => [snapshot.periodKey, snapshot.id]),
  );

  const periodsRestated: RestatementSummary["periodsRestated"] = [];

  for (const period of affected) {
    const snapshotId = snapshotByKey.get(period.periodKey);
    const priorFigures = before.get(period.periodKey);
    const nextFigures = after.get(period.periodKey);
    if (!snapshotId || !priorFigures || !nextFigures) continue;

    await prisma.periodRestatement.create({
      data: {
        shopId: shop.id,
        snapshotId,
        jobId: request.jobId ?? null,
        periodKey: period.periodKey,
        reason: request.reason,
        ordersAffected: period.ordersAffected,
        lineItemsAffected: period.lineItemsAffected,
        cogsBefore: centsToDollars(priorFigures.cogsCents),
        cogsAfter: centsToDollars(nextFigures.cogsCents),
        contributionProfitBefore: centsToDollars(
          priorFigures.contributionProfitCents,
        ),
        contributionProfitAfter: centsToDollars(
          nextFigures.contributionProfitCents,
        ),
        netProfitBefore: centsToDollars(priorFigures.netProfitCents),
        netProfitAfter: centsToDollars(nextFigures.netProfitCents),
      },
    });
    await prisma.periodSnapshot.update({
      where: { id: snapshotId },
      data: { restatementCount: { increment: 1 } },
    });

    periodsRestated.push({
      periodKey: period.periodKey,
      ordersAffected: period.ordersAffected,
      lineItemsAffected: period.lineItemsAffected,
      cogsDeltaCents: nextFigures.cogsCents - priorFigures.cogsCents,
      netProfitDeltaCents: nextFigures.netProfitCents - priorFigures.netProfitCents,
    });
  }

  return {
    periodsConsidered: periodKeys,
    periodsFrozen,
    periodsRestated,
    lineItemsAffected,
    ordersAffected: affected.reduce(
      (sum, period) => sum + period.ordersAffected,
      0,
    ),
    skipped: false,
  };
}

// ---------------------------------------------------------------------------
// Period close
// ---------------------------------------------------------------------------

/**
 * Lock a period's reported figures.
 *
 * Closing captures the snapshot if there is not one already, because a period
 * cannot be declared final without recording what it was final *at*.
 */
export async function closePeriod(
  shopId: string,
  periodKey: string,
): Promise<void> {
  if (!MONTH_KEY.test(periodKey)) {
    throw new Error(`"${periodKey}" is not a YYYY-MM period key`);
  }

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { timezone: true },
  });
  const timeZone = validTimeZone(shop.timezone);

  const [periods] = await Promise.all([
    periodsInWindow(
      timeZone,
      new Date(`${periodKey}-01T12:00:00Z`),
      new Date(`${periodKey}-01T12:00:00Z`),
    ),
  ]);
  const bounds = periods.find((period) => period.periodKey === periodKey);
  if (!bounds) throw new Error(`Could not resolve period ${periodKey}`);

  const figures = await readPeriodFigures(shopId, timeZone, [bounds]);
  await freezePeriodSnapshots(shopId, figures);

  const closedAt = new Date();
  const updated = await prisma.periodSnapshot.updateMany({
    where: { shopId, periodKey },
    data: { status: PeriodStatus.CLOSED, closedAt },
  });

  // A period with no orders has no snapshot to close. Create the lock anyway:
  // a merchant closing an empty month is asserting it stays empty, and a later
  // backdated order landing in it should hit the same refusal.
  if (updated.count === 0) {
    await prisma.periodSnapshot.create({
      data: {
        shopId,
        periodKey,
        status: PeriodStatus.CLOSED,
        closedAt,
        orderCount: 0,
        units: 0,
        netRevenue: 0,
        cogs: 0,
        contributionProfit: 0,
        netProfit: 0,
      },
    });
  }
}

export async function reopenPeriod(
  shopId: string,
  periodKey: string,
): Promise<void> {
  await prisma.periodSnapshot.updateMany({
    where: { shopId, periodKey },
    data: { status: PeriodStatus.OPEN, closedAt: null },
  });
}

// ---------------------------------------------------------------------------
// Queue integration
// ---------------------------------------------------------------------------

const restatementPayload = z.object({
  from: z.string(),
  to: z.string().nullable().optional(),
  variantIds: z.array(z.string()).nullable().optional(),
  reason: z.string(),
  includeClosedPeriods: z.boolean().optional(),
});

export type CostRestatementPayload = z.infer<typeof restatementPayload>;

/**
 * Queue a restatement, collapsing a burst of edits into one run.
 *
 * The dedupe key is the shop alone, not the window: six cost corrections in one
 * sitting should produce one restatement covering all of them, and the payload
 * is widened to the earliest window seen while the job is still queued.
 */
export async function enqueueRestatement(
  request: Omit<RestatementRequest, "jobId">,
): Promise<void> {
  const dedupeKey = `restate:${request.shopId}`;
  const existing = await prisma.recalcJob.findUnique({ where: { dedupeKey } });

  let from = request.from;
  let variantIds = request.variantIds ? [...request.variantIds] : null;
  let reason = request.reason;

  if (existing && existing.status === "QUEUED") {
    const parsed = restatementPayload.safeParse(existing.payload);
    if (parsed.success) {
      const queuedFrom = new Date(parsed.data.from);
      if (queuedFrom.getTime() < from.getTime()) from = queuedFrom;

      // A pending run scoped to every variant cannot be narrowed by a later,
      // narrower edit — that would silently drop the first edit's reach.
      const queuedVariants = parsed.data.variantIds ?? null;
      variantIds =
        queuedVariants && variantIds
          ? [...new Set([...queuedVariants, ...variantIds])]
          : null;
      reason = parsed.data.reason === reason ? reason : "Several cost changes";
    }
  }

  await enqueueRecalcJob({
    shopId: request.shopId,
    kind: RecalcJobKind.COST_RESTATEMENT,
    dedupeKey,
    payload: {
      from: from.toISOString(),
      to: request.to ? request.to.toISOString() : null,
      variantIds,
      reason,
      includeClosedPeriods: request.includeClosedPeriods ?? false,
    },
  });
}

export async function runCostRestatementJob(
  job: RecalcJob,
): Promise<Prisma.InputJsonValue> {
  const payload = restatementPayload.parse(job.payload);

  const summary = await restateCosts({
    shopId: job.shopId,
    from: new Date(payload.from),
    to: payload.to ? new Date(payload.to) : undefined,
    variantIds: payload.variantIds ?? null,
    reason: payload.reason,
    includeClosedPeriods: payload.includeClosedPeriods ?? false,
    jobId: job.id,
  });

  return summary as unknown as Prisma.InputJsonValue;
}

