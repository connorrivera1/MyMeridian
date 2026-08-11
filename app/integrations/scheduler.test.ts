import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAdConnectorHealthSweep = vi.fn();
const runCarrierReconciliationSweep = vi.fn();

vi.mock("./ad-health.server", () => ({
  runAdConnectorHealthSweep: (...args: unknown[]) => runAdConnectorHealthSweep(...args),
}));
vi.mock("./shipping.server", () => ({
  runCarrierReconciliationSweep: (...args: unknown[]) => runCarrierReconciliationSweep(...args),
}));

const {
  integrationSchedulerSettled,
  startIntegrationScheduler,
  stopIntegrationScheduler,
} = await import("./scheduler.server");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-11T12:00:00Z"));
  vi.clearAllMocks();
  runAdConnectorHealthSweep.mockResolvedValue(0);
  runCarrierReconciliationSweep.mockResolvedValue(0);
  stopIntegrationScheduler();
});

afterEach(() => {
  stopIntegrationScheduler();
  vi.useRealTimers();
});

describe("autonomous integration scheduler", () => {
  it("checks ad health and carrier costs at startup and on schedule", async () => {
    startIntegrationScheduler(60_000);
    await integrationSchedulerSettled();
    expect(runAdConnectorHealthSweep).toHaveBeenCalledTimes(1);
    expect(runCarrierReconciliationSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    await integrationSchedulerSettled();
    expect(runAdConnectorHealthSweep).toHaveBeenCalledTimes(3);
    expect(runCarrierReconciliationSweep).toHaveBeenCalledTimes(3);
  });

  it("never overlaps a slow sweep", async () => {
    let finish!: () => void;
    runAdConnectorHealthSweep.mockImplementationOnce(
      () => new Promise<number>((resolve) => (finish = () => resolve(1))),
    );
    startIntegrationScheduler(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runAdConnectorHealthSweep).toHaveBeenCalledTimes(1);
    finish();
    await integrationSchedulerSettled();
    await vi.advanceTimersByTimeAsync(1_000);
    await integrationSchedulerSettled();
    expect(runAdConnectorHealthSweep).toHaveBeenCalledTimes(2);
  });
});
