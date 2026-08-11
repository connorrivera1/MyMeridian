import {
  BundleSource,
  CostSource,
  Prisma,
  RecalcJobKind,
  type RecalcJob,
} from "@prisma/client";
import { z } from "zod";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import {
  detectBundleCandidates,
  resolveBundleCostTimelines,
  type BundleEdge,
  type BundleProblem,
} from "~/engine/bundles";
import type { CostVersion } from "~/engine/cost-history";
import { toMicros } from "~/engine/money";
import {
  loadCostTimelines,
  replaceDerivedCostTimeline,
} from "~/lib/cost-history.server";
import { enqueueRecalcJob } from "~/lib/recalc-queue.server";
import { enqueueRestatement } from "~/lib/restatement.server";

/**
 * Bundle deconstruction: the database side.
 *
 * Detection proposes; a merchant confirms; the rollup derives. That order is
 * the whole safety argument. A SKU suffix is evidence about a merchant's naming
 * convention, not authorisation to triple a product's COGS, and a profit tool
 * that acts on the inference unasked has changed a number the merchant will be
 * held to without telling them.
 *
 * Once confirmed, the rollup is genuinely automatic: a component's cost moving
 * re-derives every pack containing it, at every level of nesting, across the
 * whole cost timeline — and then hands the resulting divergence to the
 * restatement engine, which decides whether history needs revisiting.
 */

export interface BundleDetectionResult {
  scanned: number;
  proposed: number;
}

/**
 * Scan the catalog and record proposals.
 *
 * `skipDuplicates` is doing real work here: re-running detection must not
 * resurrect a proposal the merchant already rejected-by-editing, nor reset the
 * `confirmedAt` of one they accepted. Existing edges are left exactly as they
 * are and only genuinely new pairs are added.
 */
export async function detectBundlesForShop(
  shopId: string,
): Promise<BundleDetectionResult> {
  const variants = await prisma.variant.findMany({
    where: { shopId },
    select: { id: true, productId: true, sku: true, title: true },
  });

  const candidates = detectBundleCandidates(
    variants.map((variant) => ({
      variantId: variant.id,
      productId: variant.productId,
      sku: variant.sku,
      title: variant.title,
    })),
  );

  if (candidates.length === 0) {
    return { scanned: variants.length, proposed: 0 };
  }

  const created = await prisma.bundleComponent.createMany({
    data: candidates.map((candidate) => ({
      shopId,
      bundleVariantId: candidate.bundleVariantId,
      componentVariantId: candidate.componentVariantId,
      quantity: candidate.quantity,
      source:
        candidate.source === "SKU_PATTERN"
          ? BundleSource.SKU_PATTERN
          : BundleSource.TITLE_PATTERN,
      evidence: candidate.evidence,
    })),
    skipDuplicates: true,
  });

  return { scanned: variants.length, proposed: created.count };
}

/** Confirmed edges only — the rollup never acts on an unreviewed proposal. */
async function loadConfirmedEdges(shopId: string): Promise<BundleEdge[]> {
  const rows = await prisma.bundleComponent.findMany({
    where: { shopId, confirmedAt: { not: null } },
    select: {
      bundleVariantId: true,
      componentVariantId: true,
      quantity: true,
    },
  });
  return rows;
}

export interface BundleRollupResult {
  bundles: number;
  resolved: number;
  problems: BundleProblem[];
  divergedFrom: string | null;
}

/**
 * Re-derive every confirmed bundle's cost timeline from its components.
 *
 * Base timelines deliberately exclude `BUNDLE_ROLLUP` rows. Feeding a previous
 * derivation back in would let a pack's cost compound on itself every time the
 * rollup ran, and the drift would look exactly like a real supplier increase.
 *
 * A bundle that fails to resolve has its derived rows withdrawn rather than
 * left in place. A stale derived cost is worse than an absent one: absent shows
 * up as missing COGS and gets fixed, stale silently keeps last week's number.
 */
export async function rollUpBundleCosts(
  shopId: string,
): Promise<BundleRollupResult> {
  const edges = await loadConfirmedEdges(shopId);

  // Every variant currently *wearing* a derived cost, not just every variant
  // that is currently a bundle. A mapping the merchant just deleted leaves a
  // pack whose cost was derived from a relationship that no longer exists, and
  // it is no longer in `edges` to be re-derived — so without this it would
  // keep that number, and its BUNDLE_ROLLUP source, for ever.
  const derivedHolders = await prisma.variantCost.findMany({
    where: { shopId, source: CostSource.BUNDLE_ROLLUP },
    select: { variantId: true },
    distinct: ["variantId"],
  });

  if (edges.length === 0 && derivedHolders.length === 0) {
    return { bundles: 0, resolved: 0, problems: [], divergedFrom: null };
  }

  const referenced = [
    ...new Set(
      edges.flatMap((edge) => [edge.bundleVariantId, edge.componentVariantId]),
    ),
  ];

  const rows = await prisma.variantCost.findMany({
    where: {
      shopId,
      variantId: { in: referenced },
      source: { not: CostSource.BUNDLE_ROLLUP },
    },
    select: {
      variantId: true,
      unitCost: true,
      effectiveAt: true,
      source: true,
    },
    orderBy: [{ variantId: "asc" }, { effectiveAt: "asc" }],
  });

  const baseTimelines = new Map<string, CostVersion[]>();
  for (const row of rows) {
    const version: CostVersion = {
      unitCostMicros: toMicros(row.unitCost),
      effectiveAt: row.effectiveAt,
      source: row.source,
    };
    const existing = baseTimelines.get(row.variantId);
    if (existing) existing.push(version);
    else baseTimelines.set(row.variantId, [version]);
  }

  const { timelines, problems } = resolveBundleCostTimelines(
    edges,
    baseTimelines,
  );

  const bundleVariantIds = [
    ...new Set([
      ...edges.map((edge) => edge.bundleVariantId),
      ...derivedHolders.map((row) => row.variantId),
    ]),
  ];

  let earliestDivergence: Date | null = null;
  const changed: string[] = [];

  for (const bundleVariantId of bundleVariantIds) {
    const derived = timelines.get(bundleVariantId) ?? [];
    const result = await replaceDerivedCostTimeline(
      shopId,
      bundleVariantId,
      derived,
    );
    if (!result.divergedFrom) continue;

    changed.push(bundleVariantId);
    if (
      !earliestDivergence ||
      result.divergedFrom.getTime() < earliestDivergence.getTime()
    ) {
      earliestDivergence = result.divergedFrom;
    }
  }

  if (earliestDivergence) {
    invalidateAnalyticsCache();
    // Scoped to the packs whose derived cost actually moved. Their components
    // are untouched by this rollup and must not have their own history
    // rewritten as a side effect of a pack being re-derived.
    await enqueueRestatement({
      shopId,
      from: earliestDivergence,
      variantIds: changed,
      reason: "Bundle component costs re-derived",
    });
  }

  return {
    // Bundles the merchant has actually mapped, not the sweep's working set —
    // a withdrawn pack is being cleaned up, not counted as a bundle.
    bundles: new Set(edges.map((edge) => edge.bundleVariantId)).size,
    resolved: timelines.size,
    problems,
    divergedFrom: earliestDivergence ? earliestDivergence.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Merchant actions
// ---------------------------------------------------------------------------

export interface UpsertBundleComponentInput {
  shopId: string;
  bundleVariantId: string;
  componentVariantId: string;
  quantity: number;
}

/**
 * Draw or adjust one edge by hand.
 *
 * Merchant-drawn edges are confirmed on creation — the act of drawing one *is*
 * the confirmation, and asking someone to agree with what they just typed is
 * theatre.
 */
export async function upsertBundleComponent(
  input: UpsertBundleComponentInput,
): Promise<void> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new Error("A bundle component quantity must be a whole number of at least 1");
  }
  if (input.bundleVariantId === input.componentVariantId) {
    throw new Error("A bundle cannot contain itself");
  }

  const variants = await prisma.variant.findMany({
    where: {
      shopId: input.shopId,
      id: { in: [input.bundleVariantId, input.componentVariantId] },
    },
    select: { id: true },
  });
  if (variants.length !== 2) {
    throw new Error("Both variants must belong to this shop");
  }

  await prisma.bundleComponent.upsert({
    where: {
      bundleVariantId_componentVariantId: {
        bundleVariantId: input.bundleVariantId,
        componentVariantId: input.componentVariantId,
      },
    },
    create: {
      shopId: input.shopId,
      bundleVariantId: input.bundleVariantId,
      componentVariantId: input.componentVariantId,
      quantity: input.quantity,
      source: BundleSource.MANUAL,
      confirmedAt: new Date(),
    },
    update: {
      quantity: input.quantity,
      source: BundleSource.MANUAL,
      confirmedAt: new Date(),
    },
  });

  await enqueueBundleRollup(input.shopId);
}

/** Accept a proposed mapping as written. */
export async function confirmBundleComponent(
  shopId: string,
  id: string,
): Promise<void> {
  const updated = await prisma.bundleComponent.updateMany({
    where: { id, shopId },
    data: { confirmedAt: new Date() },
  });
  if (updated.count === 0) throw new Error("That bundle mapping no longer exists");

  await enqueueBundleRollup(shopId);
}

/**
 * Remove an edge.
 *
 * The rollup that follows is what withdraws the derived cost this edge was
 * holding up — deleting the mapping alone would leave the pack wearing a cost
 * derived from a relationship that no longer exists.
 */
export async function removeBundleComponent(
  shopId: string,
  id: string,
): Promise<void> {
  const deleted = await prisma.bundleComponent.deleteMany({
    where: { id, shopId },
  });
  if (deleted.count === 0) return;

  await enqueueBundleRollup(shopId);
}

// ---------------------------------------------------------------------------
// Queue integration
// ---------------------------------------------------------------------------

const emptyPayload = z.object({}).passthrough();

export async function enqueueBundleRollup(shopId: string): Promise<void> {
  await enqueueRecalcJob({
    shopId,
    kind: RecalcJobKind.BUNDLE_ROLLUP,
    dedupeKey: `bundle-rollup:${shopId}`,
    payload: {},
  });
}

export async function enqueueBundleDetection(shopId: string): Promise<void> {
  await enqueueRecalcJob({
    shopId,
    kind: RecalcJobKind.BUNDLE_DETECTION,
    dedupeKey: `bundle-detect:${shopId}`,
    payload: {},
  });
}

export async function runBundleRollupJob(
  job: RecalcJob,
): Promise<Prisma.InputJsonValue> {
  emptyPayload.parse(job.payload ?? {});
  const result = await rollUpBundleCosts(job.shopId);
  return result as unknown as Prisma.InputJsonValue;
}

export async function runBundleDetectionJob(
  job: RecalcJob,
): Promise<Prisma.InputJsonValue> {
  emptyPayload.parse(job.payload ?? {});
  const result = await detectBundlesForShop(job.shopId);
  return result as unknown as Prisma.InputJsonValue;
}
