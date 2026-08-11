import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const purgeExpiredDataRequests = vi.fn();

vi.mock("~/lib/data-request.server", () => ({
  purgeExpiredDataRequests: (...args: unknown[]) => purgeExpiredDataRequests(...args),
}));

const {
  dataRetentionSettled,
  startDataRetentionScheduler,
  stopDataRetentionScheduler,
} = await import("./data-retention.server");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  purgeExpiredDataRequests.mockResolvedValue(0);
  stopDataRetentionScheduler();
});

afterEach(() => {
  stopDataRetentionScheduler();
  vi.useRealTimers();
});

describe("data retention scheduler", () => {
  it("purges at process startup and on every interval without a Settings request", async () => {
    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();

    expect(purgeExpiredDataRequests).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    await dataRetentionSettled();

    expect(purgeExpiredDataRequests).toHaveBeenCalledTimes(3);
  });

  it("starts only one worker when the server module is evaluated repeatedly", async () => {
    startDataRetentionScheduler(60_000);
    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();

    await vi.advanceTimersByTimeAsync(60_000);
    await dataRetentionSettled();

    expect(purgeExpiredDataRequests).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a slow purge", async () => {
    let finish!: (count: number) => void;
    purgeExpiredDataRequests
      .mockImplementationOnce(
        () => new Promise<number>((resolve) => (finish = resolve)),
      )
      .mockResolvedValue(0);

    startDataRetentionScheduler(1_000);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(purgeExpiredDataRequests).toHaveBeenCalledTimes(1);

    finish(0);
    await dataRetentionSettled();
    await vi.advanceTimersByTimeAsync(1_000);
    await dataRetentionSettled();

    expect(purgeExpiredDataRequests).toHaveBeenCalledTimes(2);
  });

  it("logs a failure and retries on the next interval", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    purgeExpiredDataRequests
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(0);

    startDataRetentionScheduler(1_000);
    await dataRetentionSettled();
    expect(error).toHaveBeenCalledWith(
      "[privacy] expired customer data export purge failed",
      expect.any(Error),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await dataRetentionSettled();

    expect(purgeExpiredDataRequests).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
