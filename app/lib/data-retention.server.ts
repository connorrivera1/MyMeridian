import { purgeExpiredDataRequests } from "~/lib/data-request.server";
import { purgeFinishedRecalcJobs } from "~/lib/recalc-queue.server";
import { purgeExpiredSecurityAuditEvents } from "~/lib/security-audit.server";
import { purgeExpiredConnectorOAuthStates } from "~/lib/connector-oauth.server";
import { purgeOldMerchantNotifications } from "~/lib/merchant-notifications.server";

/**
 * The retention boundary is measured in days, but an hourly sweep keeps the
 * deletion delay bounded without putting meaningful load on Postgres. A sweep
 * also runs at process start, so a stopped or redeployed machine catches up
 * before the first merchant visits the app.
 */
export const DATA_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

interface DataRetentionState {
  timer?: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
}

declare global {
  // Vite can evaluate server modules again during HMR. Keeping the state on
  // globalThis prevents each evaluation from adding another hourly timer.
  // eslint-disable-next-line no-var
  var __meridianDataRetention: DataRetentionState | undefined;
}

const state = (globalThis.__meridianDataRetention ??= {});

function beginSweep(): void {
  // Do not overlap deletes if Postgres is slow or temporarily unavailable.
  if (state.inFlight) return;

  const work = purgeExpiredDataRequests()
    .then((count) => {
      if (count > 0) {
        console.info(`[privacy] purged ${count} expired customer data export(s)`);
      }
    })
    .catch((error: unknown) => {
      // A transient database failure must not become an unhandled rejection or
      // stop future sweeps. The next interval retries the same deterministic
      // expiresAt predicate.
      console.error("[privacy] expired customer data export purge failed", error);
    })
    // Chained rather than combined: a failure to prune spent job receipts must
    // never be able to stop a privacy deletion, and the privacy deletion is the
    // one with a legal deadline, so it goes first and its failure is caught
    // before this runs at all.
    .then(() => purgeFinishedRecalcJobs())
    .then((count) => {
      if (count > 0) {
        console.info(`[recalc] purged ${count} finished recalculation job(s)`);
      }
    })
    .catch((error: unknown) => {
      console.error("[recalc] finished job purge failed", error);
    })
    .then(() => purgeExpiredSecurityAuditEvents())
    .then((count) => {
      if (count > 0) console.info(`[security] purged ${count} expired access event(s)`);
    })
    .catch((error: unknown) => {
      console.error("[security] access-event purge failed", error);
    })
    .then(async () => {
      const [oauth, notifications] = await Promise.all([
        purgeExpiredConnectorOAuthStates(),
        purgeOldMerchantNotifications(),
      ]);
      if (oauth > 0 || notifications > 0) {
        console.info(`[retention] purged ${oauth} OAuth state(s) and ${notifications} notification receipt(s)`);
      }
    })
    .catch((error: unknown) => {
      console.error("[retention] connector/notification purge failed", error);
    })
    .finally(() => {
      if (state.inFlight === work) state.inFlight = undefined;
    });

  state.inFlight = work;
}

/** Start one process-lifetime retention worker and run its startup sweep. */
export function startDataRetentionScheduler(
  intervalMs = DATA_RETENTION_SWEEP_INTERVAL_MS,
): void {
  if (state.timer) return;

  beginSweep();
  state.timer = setInterval(beginSweep, intervalMs);
  // Retention work must not be the only thing keeping a shutting-down process
  // alive. Fly's always-on machine owns the lifecycle; this timer follows it.
  state.timer.unref();
}

/** Wait for the current sweep; used by shutdown hooks and deterministic tests. */
export async function dataRetentionSettled(): Promise<void> {
  await state.inFlight;
}

/** Test/dev cleanup. Production leaves the process-lifetime worker running. */
export function stopDataRetentionScheduler(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = undefined;
}
