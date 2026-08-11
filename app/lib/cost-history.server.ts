import { CostSource, Prisma, type PrismaClient } from "@prisma/client";

import prisma from "~/db.server";
import {
  costDivergenceFrom,
  costEffectiveAt,
  normaliseCostTimeline,
  type CostVersion,
} from "~/engine/cost-history";
import { toMicros } from "~/engine/money";

/**
 * The database side of effective-dated cost.
 *
 * Reads hand the engine plain `CostVersion`s and take nothing back; writes are
 * the one place `Variant.unitCost` and the `VariantCost` timeline are kept
 * consistent with each other. Nothing here rewrites a reported number — that is
 * `restatement.server.ts`, deliberately separate, because recording what a
 * thing cost and restating what you already published are different acts with
 * very different blast radii.
 */

type Client = PrismaClient | Prisma.TransactionClient;

/** Micros back to the 4dp string Prisma wants for a Decimal(12,4). */
export function microsToDecimal(micros: number): string {
  const negative = micros < 0;
  const abs = Math.abs(Math.trunc(micros));
  const body = `${Math.trunc(abs / 10_000)}.${String(abs % 10_000).padStart(4, "0")}`;
  return negative ? `-${body}` : body;
}

export interface CostTimelineRow {
  variantId: string;
  unitCost: Prisma.Decimal | string | number;
  effectiveAt: Date;
  source: CostSource;
}

export function toCostVersion(row: CostTimelineRow): CostVersion {
  return {
    unitCostMicros: toMicros(row.unitCost),
    effectiveAt: row.effectiveAt,
    source: row.source,
  };
}

/**
 * Every cost timeline in the shop, or just the named variants'.
 *
 * Returned normalised, so callers can binary-search without re-sorting. The
 * whole-shop read is bounded by variant count, not order count — a catalog
 * large enough for this to matter is a catalog whose order history would have
 * hit `MAX_ENGINE_ORDERS` long before.
 */
export async function loadCostTimelines(
  shopId: string,
  variantIds?: readonly string[],
  client: Client = prisma,
): Promise<Map<string, CostVersion[]>> {
  if (variantIds && variantIds.length === 0) return new Map();

  const rows = await client.variantCost.findMany({
    where: {
      shopId,
      ...(variantIds ? { variantId: { in: [...variantIds] } } : {}),
    },
    select: {
      variantId: true,
      unitCost: true,
      effectiveAt: true,
      source: true,
    },
    orderBy: [{ variantId: "asc" }, { effectiveAt: "asc" }],
  });

  const timelines = new Map<string, CostVersion[]>();
  for (const row of rows) {
    const version = toCostVersion(row);
    const existing = timelines.get(row.variantId);
    if (existing) existing.push(version);
    else timelines.set(row.variantId, [version]);
  }

  return timelines;
}

export async function loadCostTimeline(
  shopId: string,
  variantId: string,
  client: Client = prisma,
): Promise<CostVersion[]> {
  const timelines = await loadCostTimelines(shopId, [variantId], client);
  return timelines.get(variantId) ?? [];
}

/**
 * Republish `Variant.unitCost` from the timeline's value as of now.
 *
 * Never from the value just written: a cost backdated to March must not
 * overwrite a June cost that is still the current one — that would be a
 * correction to the past silently undoing a change in the present. A
 * forward-dated cost is likewise not current yet and must not be published
 * early.
 *
 * Clearing matters as much as setting. When a bundle mapping breaks and its
 * derived timeline is withdrawn, leaving the last derived number in the catalog
 * would keep asserting a cost nothing supports any more.
 */
async function publishCurrentCost(
  variantId: string,
  before: readonly CostVersion[],
  after: readonly CostVersion[],
  client: Client,
): Promise<boolean> {
  const now = new Date();
  const currentBefore = costEffectiveAt(normaliseCostTimeline(before), now);
  const currentAfter = costEffectiveAt(normaliseCostTimeline(after), now);

  const changed =
    (currentBefore?.unitCostMicros ?? null) !==
    (currentAfter?.unitCostMicros ?? null);
  if (!changed) return false;

  await client.variant.update({
    where: { id: variantId },
    data: currentAfter
      ? {
          unitCost: new Prisma.Decimal(
            microsToDecimal(currentAfter.unitCostMicros),
          ),
          costSource: currentAfter.source as CostSource,
        }
      : { unitCost: null, costSource: CostSource.ESTIMATED },
  });

  return true;
}

export interface EffectiveCost {
  variantId: string;
  unitCost: Prisma.Decimal;
  effectiveAt: Date;
}

/**
 * The cost in effect for each variant at one instant, resolved in Postgres.
 *
 * This is what an order sync needs: the cost as it was when the order was
 * placed, not the cost today. For a live webhook the two are the same, so
 * nothing changes; for the historical import they are emphatically not, and
 * stamping today's cost onto a two-year-old order — which is what happened
 * before cost history existed — is a quiet rewrite of the entire backfill.
 *
 * `DISTINCT ON` rather than a lateral per variant: one index-ordered pass over
 * a bounded id list beats N round trips inside an order transaction.
 */
export async function loadEffectiveCosts(
  variantIds: readonly string[],
  at: Date,
  client: Client = prisma,
): Promise<Map<string, EffectiveCost>> {
  const result = new Map<string, EffectiveCost>();
  if (variantIds.length === 0) return result;

  const rows = await client.$queryRaw<EffectiveCost[]>`
    SELECT DISTINCT ON (vc."variantId")
      vc."variantId" AS "variantId",
      vc."unitCost" AS "unitCost",
      vc."effectiveAt" AS "effectiveAt"
    FROM "VariantCost" AS vc
    WHERE vc."variantId" IN (${Prisma.join([...variantIds])})
      AND vc."effectiveAt" <= ${at}
    ORDER BY vc."variantId", vc."effectiveAt" DESC
  `;

  for (const row of rows) result.set(row.variantId, row);
  return result;
}

/**
 * The instant an install's opening cost basis is dated from.
 *
 * Epoch, deliberately, and identical to the value the cost-history migration
 * back-filled with. It reads as "as far back as this install can see, the cost
 * was this" — which is not a new claim, it is exactly what a line-item snapshot
 * already assumed when it froze today's number onto a two-year-old order.
 */
export const OPENING_COST_BASIS_AT = new Date(0);

/**
 * Give a variant a floor to its cost timeline, once.
 *
 * The historical import is the only place a brand-new install learns what
 * anything costs, and without this its timeline would start empty: the merchant
 * makes their first backdated correction, and it has nothing to supersede.
 * Existing installs got this floor from the migration; new ones get it here.
 *
 * Only when the timeline is empty. On a re-import six months later there are
 * already webhook-dated versions, and overwriting the opening basis with
 * today's cost would silently restate every order the store has ever taken.
 */
export async function seedOpeningCostBasis(
  input: Omit<RecordCostInput, "effectiveAt">,
  client: Client = prisma,
): Promise<boolean> {
  const existing = await client.variantCost.findFirst({
    where: { variantId: input.variantId },
    select: { id: true },
  });
  if (existing) return false;

  await client.variantCost.create({
    data: {
      shopId: input.shopId,
      variantId: input.variantId,
      unitCost: new Prisma.Decimal(microsToDecimal(input.unitCostMicros)),
      effectiveAt: OPENING_COST_BASIS_AT,
      source: input.source,
      note: input.note ?? "Opening cost basis, observed during the initial import",
    },
  });
  return true;
}

/**
 * Record a cost Shopify (or an import) observed, without restating anything.
 *
 * An observed cost change is a statement about the present: the supplier put
 * their price up, and orders from last quarter were still bought at the old
 * one. So this appends to the timeline and stops. Rewriting history is only
 * ever the merchant's explicit decision, never a side effect of a webhook.
 *
 * Idempotent against redelivery on two levels — the same `effectiveAt` upserts
 * onto one row, and an unchanged cost writes nothing at all, which is what
 * keeps a legacy payload with no source timestamp from appending a row per
 * delivery.
 */
export async function observeVariantCost(
  input: RecordCostInput,
  client: Client = prisma,
): Promise<boolean> {
  const current = await client.variantCost.findFirst({
    where: { variantId: input.variantId, effectiveAt: { lte: input.effectiveAt } },
    orderBy: { effectiveAt: "desc" },
    select: { unitCost: true, effectiveAt: true },
  });

  if (current && toMicros(current.unitCost) === input.unitCostMicros) return false;

  await client.variantCost.upsert({
    where: {
      variantId_effectiveAt: {
        variantId: input.variantId,
        effectiveAt: input.effectiveAt,
      },
    },
    create: {
      shopId: input.shopId,
      variantId: input.variantId,
      unitCost: new Prisma.Decimal(microsToDecimal(input.unitCostMicros)),
      effectiveAt: input.effectiveAt,
      source: input.source,
      note: input.note ?? null,
    },
    update: {
      unitCost: new Prisma.Decimal(microsToDecimal(input.unitCostMicros)),
      source: input.source,
      recordedAt: new Date(),
    },
  });

  return true;
}

export interface RecordCostInput {
  shopId: string;
  variantId: string;
  /** Landed unit cost at 4dp precision, as micros. */
  unitCostMicros: number;
  effectiveAt: Date;
  source: CostSource;
  note?: string | null;
}

export interface RecordCostResult {
  /**
   * The earliest instant at which this variant's resolved cost now differs
   * from what it was before the write, or null if nothing actually moved.
   *
   * This is the restatement window's left edge. A forward-dated price rise
   * diverges from today and touches no history; a correction backdated to
   * March diverges from March and is why history needs revisiting at all.
   */
  divergedFrom: Date | null;
  /** Whether this write changed today's cost, and so the catalog head. */
  changedCurrentCost: boolean;
}

/**
 * Append (or correct) one point on a variant's cost timeline.
 *
 * Idempotent at an instant: re-observing the same cost at the same
 * `effectiveAt` overwrites rather than stacking, which is what lets a webhook
 * retry and a backfill both report the same supplier change without inventing
 * two of them.
 *
 * `Variant.unitCost` is republished from the timeline afterwards, not from the
 * argument. A cost backdated to March must not overwrite a June cost that is
 * still the current one — that would be a correction to the past silently
 * undoing a change in the present.
 */
export async function recordVariantCost(
  input: RecordCostInput,
  client: Client = prisma,
): Promise<RecordCostResult> {
  const before = await loadCostTimeline(input.shopId, input.variantId, client);

  const unitCost = new Prisma.Decimal(microsToDecimal(input.unitCostMicros));
  await client.variantCost.upsert({
    where: {
      variantId_effectiveAt: {
        variantId: input.variantId,
        effectiveAt: input.effectiveAt,
      },
    },
    create: {
      shopId: input.shopId,
      variantId: input.variantId,
      unitCost,
      effectiveAt: input.effectiveAt,
      source: input.source,
      note: input.note ?? null,
    },
    update: {
      unitCost,
      source: input.source,
      note: input.note ?? null,
      recordedAt: new Date(),
    },
  });

  const after = normaliseCostTimeline([
    ...before.filter(
      (version) => version.effectiveAt.getTime() !== input.effectiveAt.getTime(),
    ),
    {
      unitCostMicros: input.unitCostMicros,
      effectiveAt: input.effectiveAt,
      source: input.source,
    },
  ]);

  const changedCurrentCost = await publishCurrentCost(
    input.variantId,
    before,
    after,
    client,
  );

  return {
    divergedFrom: costDivergenceFrom(before, after),
    changedCurrentCost,
  };
}

/**
 * Replace a variant's whole derived timeline in one shot.
 *
 * Only the bundle rollup uses this, and only for `BUNDLE_ROLLUP` rows: a
 * derived timeline is a function of its components, so leaving a superseded
 * derived version behind would make the pack's history disagree with the
 * components it is made of. Merchant- and Shopify-sourced rows are never
 * touched here — the rollup owns its own rows and nothing else's.
 */
export async function replaceDerivedCostTimeline(
  shopId: string,
  variantId: string,
  versions: readonly CostVersion[],
  client: Client = prisma,
): Promise<RecordCostResult> {
  const before = await loadCostTimeline(shopId, variantId, client);

  await client.variantCost.deleteMany({
    where: { shopId, variantId, source: CostSource.BUNDLE_ROLLUP },
  });

  if (versions.length > 0) {
    await client.variantCost.createMany({
      data: versions.map((version) => ({
        shopId,
        variantId,
        unitCost: new Prisma.Decimal(microsToDecimal(version.unitCostMicros)),
        effectiveAt: version.effectiveAt,
        source: CostSource.BUNDLE_ROLLUP,
        note: "Derived from bundle components",
      })),
      // A derived version can land on the same instant as a directly observed
      // one. The direct row is the merchant's own claim and wins.
      skipDuplicates: true,
    });
  }

  const after = await loadCostTimeline(shopId, variantId, client);

  const changedCurrentCost = await publishCurrentCost(
    variantId,
    before,
    after,
    client,
  );

  return {
    divergedFrom: costDivergenceFrom(before, after),
    changedCurrentCost,
  };
}
