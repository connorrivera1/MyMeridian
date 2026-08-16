import { RecalcJobKind, type Prisma, type RecalcJob } from "@prisma/client";

import prisma from "~/db.server";
import { resumePointFor } from "~/lib/backfill-claim.server";
import { runBackfill } from "~/lib/backfill.server";
import {
  enqueueExclusiveRecalcJob,
  wakeRecalcWorker,
} from "~/lib/recalc-queue.server";
import { unauthenticated } from "~/shopify.server";

const backfillDedupeKey = (shopId: string) => `historical-backfill:${shopId}`;

export type BackfillRequestResult =
  | { started: true; resumed: boolean; jobId: string }
  | { started: false; reason: "active"; jobId: string };

/**
 * Persist a historical import before returning to OAuth, a webhook, or a form.
 * The worker is merely nudged after the insert; PostgreSQL remains the source
 * of truth if this process dies before that nudge runs.
 */
export async function requestBackfill(
  shopId: string,
): Promise<BackfillRequestResult> {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const resumed = resumePointFor(shop) !== null;
  const queued = await enqueueExclusiveRecalcJob({
    shopId,
    kind: RecalcJobKind.HISTORICAL_BACKFILL,
    payload: { shopId },
    dedupeKey: backfillDedupeKey(shopId),
  });

  if (!queued.created) {
    return { started: false, reason: "active", jobId: queued.job.id };
  }

  // Make the queued state merchant-visible without destroying a failed run's
  // resume cursor. The worker's fenced claim remains authoritative.
  await prisma.shop.updateMany({
    where: {
      id: shopId,
      syncStatus: { notIn: ["RUNNING", "FAILED"] },
    },
    data: {
      syncStatus: "PENDING",
      syncStage: "Historical import queued",
      syncError: null,
    },
  });

  wakeRecalcWorker();
  return { started: true, resumed, jobId: queued.job.id };
}

/** Re-acquire a fresh offline Shopify client inside the durable worker. */
export async function runHistoricalBackfillJob(
  job: RecalcJob,
): Promise<Prisma.InputJsonValue> {
  const shop = await prisma.shop.findUnique({
    where: { id: job.shopId },
    select: { id: true, domain: true, uninstalledAt: true },
  });
  if (!shop || shop.uninstalledAt) {
    return { skipped: "shop_uninstalled" };
  }
  if (!unauthenticated) {
    throw new Error("Shopify offline authentication is not configured.");
  }

  const { admin } = await unauthenticated.admin(shop.domain);
  const result = await runBackfill(shop.id, admin);
  return {
    products: result.products,
    orders: result.orders,
    usedJourneyAttribution: result.usedJourneyAttribution,
    reachedOrderCap: result.reachedOrderCap,
    durationMs: result.durationMs,
  };
}
