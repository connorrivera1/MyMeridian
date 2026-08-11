import { RecalcJobKind } from "@prisma/client";

import { runBundleDetectionJob, runBundleRollupJob } from "~/lib/bundles.server";
import { registerRecalcHandler } from "~/lib/recalc-queue.server";
import { runCostRestatementJob } from "~/lib/restatement.server";

/**
 * Bind every job kind to its worker.
 *
 * One explicit place rather than a side effect at the bottom of each module:
 * a bundler is entitled to drop an import whose only purpose is a side effect,
 * and the failure mode of that — jobs queueing forever with "No recalculation
 * handler" — would only show up in production, on the merchant's correction.
 *
 * `registerRecalcHandler` overwrites, so calling this twice is harmless.
 */
export function registerRecalcHandlers(): void {
  registerRecalcHandler(RecalcJobKind.COST_RESTATEMENT, runCostRestatementJob);
  registerRecalcHandler(RecalcJobKind.BUNDLE_ROLLUP, runBundleRollupJob);
  registerRecalcHandler(RecalcJobKind.BUNDLE_DETECTION, runBundleDetectionJob);
}
