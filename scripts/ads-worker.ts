/**
 * Standalone ad-ingestion worker process.
 *
 *   npx tsx scripts/ads-worker.ts
 *
 * The same queues, workers and scheduler also start inside the web process
 * when MERIDIAN_REDIS_URL is set (see app/entry.server.tsx), so this script
 * exists for deployments that want polling isolated from request serving —
 * a Fly `processes.worker` entry, a second machine, or local debugging.
 * Running both is safe: BullMQ leases jobs atomically and the scheduler
 * upsert is idempotent, so two processes share the work rather than repeat it.
 */
import { startAdIngestion, stopAdIngestion } from "../app/queue/ads-queue.server";

const handle = await startAdIngestion();
if (!handle) {
  console.error(
    "ads-worker: refusing to idle — set MERIDIAN_REDIS_URL (and unset " +
      "MERIDIAN_ADS_WORKER_DISABLED) so there is work to run.",
  );
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`ads-worker: ${signal} — draining active jobs…`);
  await stopAdIngestion();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.info("ads-worker: running. Ctrl-C to stop.");
