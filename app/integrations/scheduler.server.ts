import { runAdConnectorHealthSweep } from "./ad-health.server";
import { runCarrierReconciliationSweep } from "./shipping.server";

export const INTEGRATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface IntegrationSchedulerState {
  timer?: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __meridianIntegrationScheduler: IntegrationSchedulerState | undefined;
}

const state = (globalThis.__meridianIntegrationScheduler ??= {});

function beginSweep() {
  if (state.inFlight) return;
  const now = new Date();
  const work = Promise.allSettled([
    runAdConnectorHealthSweep(now),
    runCarrierReconciliationSweep(now),
  ])
    .then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[integrations] autonomous sweep failed", result.reason);
        }
      }
    })
    .finally(() => {
      if (state.inFlight === work) state.inFlight = undefined;
    });
  state.inFlight = work;
}

/** One process-lifetime worker; startup catch-up means no merchant visit is required. */
export function startIntegrationScheduler(
  intervalMs = INTEGRATION_SWEEP_INTERVAL_MS,
) {
  if (state.timer) return;
  beginSweep();
  state.timer = setInterval(beginSweep, intervalMs);
  state.timer.unref();
}

export async function integrationSchedulerSettled() {
  await state.inFlight;
}

export function stopIntegrationScheduler() {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = undefined;
}
