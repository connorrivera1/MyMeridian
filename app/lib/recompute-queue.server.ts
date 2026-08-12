import { RecalcJobKind, type Prisma, type RecalcJob } from "@prisma/client";

import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { enqueueRecalcJob, wakeRecalcWorker } from "~/lib/recalc-queue.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";

export async function enqueueShopRecompute(
  shopId: string,
  reason: string,
): Promise<{ jobId: string }> {
  const job = await enqueueRecalcJob({
    shopId,
    kind: RecalcJobKind.FULL_RECOMPUTE,
    payload: { reason },
    dedupeKey: `full-recompute:${shopId}`,
  });
  wakeRecalcWorker();
  return { jobId: job.id };
}

export async function runFullRecomputeJob(
  job: RecalcJob,
): Promise<Prisma.InputJsonValue> {
  const result = await recomputeShopProfitability(job.shopId);
  invalidateAnalyticsCache();
  return {
    ordersUpdated: result.ordersUpdated,
    customersUpdated: result.customersUpdated,
    netProfitCents: result.netProfitCents,
    unattributedAdSpendCents: result.unattributedAdSpendCents,
    durationMs: result.durationMs,
  };
}
