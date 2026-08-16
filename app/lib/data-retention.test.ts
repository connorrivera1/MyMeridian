import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const purgeExpiredDataRequests = vi.fn();
const purgeFinishedRecalcJobs = vi.fn();
const purgeExpiredSecurityAuditEvents = vi.fn();
const purgeExpiredConnectorOAuthStates = vi.fn();
const purgeOldMerchantNotifications = vi.fn();
const purgeExpiredOperatorSecurityData = vi.fn();
const purgeExpiredRateLimitBuckets = vi.fn();
const purgeExpiredMfaChallenges = vi.fn();
const purgeOldWaitlistEmailDeliveries = vi.fn();

vi.mock("~/lib/data-request.server", () => ({
  purgeExpiredDataRequests: (...args: unknown[]) =>
    purgeExpiredDataRequests(...args),
}));
vi.mock("~/lib/recalc-queue.server", () => ({
  purgeFinishedRecalcJobs: (...args: unknown[]) =>
    purgeFinishedRecalcJobs(...args),
}));
vi.mock("~/lib/security-audit.server", () => ({
  purgeExpiredSecurityAuditEvents: (...args: unknown[]) =>
    purgeExpiredSecurityAuditEvents(...args),
}));
vi.mock("~/lib/connector-oauth.server", () => ({
  purgeExpiredConnectorOAuthStates: (...args: unknown[]) =>
    purgeExpiredConnectorOAuthStates(...args),
}));
vi.mock("~/lib/merchant-notifications.server", () => ({
  purgeOldMerchantNotifications: (...args: unknown[]) =>
    purgeOldMerchantNotifications(...args),
}));
vi.mock("~/lib/operator-auth.server", () => ({
  purgeExpiredOperatorSecurityData: (...args: unknown[]) =>
    purgeExpiredOperatorSecurityData(...args),
}));
vi.mock("~/lib/rate-limit.server", () => ({
  purgeExpiredRateLimitBuckets: (...args: unknown[]) =>
    purgeExpiredRateLimitBuckets(...args),
}));
vi.mock("~/lib/mfa.server", () => ({
  purgeExpiredMfaChallenges: (...args: unknown[]) =>
    purgeExpiredMfaChallenges(...args),
}));
vi.mock("~/lib/waitlist.server", () => ({
  purgeOldWaitlistEmailDeliveries: (...args: unknown[]) =>
    purgeOldWaitlistEmailDeliveries(...args),
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
  purgeFinishedRecalcJobs.mockResolvedValue(0);
  purgeExpiredSecurityAuditEvents.mockResolvedValue(0);
  purgeExpiredConnectorOAuthStates.mockResolvedValue(0);
  purgeOldMerchantNotifications.mockResolvedValue(0);
  purgeExpiredOperatorSecurityData.mockResolvedValue({
    sessions: 0,
    auditEvents: 0,
  });
  purgeExpiredRateLimitBuckets.mockResolvedValue(0);
  purgeExpiredMfaChallenges.mockResolvedValue(0);
  purgeOldWaitlistEmailDeliveries.mockResolvedValue(0);
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
      "[%s] %s",
      "privacy expired customer data export purge",
      "Operation failed (Error).",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await dataRetentionSettled();

    expect(purgeExpiredDataRequests).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe("recalculation job retention", () => {
  it("sweeps spent job receipts alongside expired exports", async () => {
    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();

    expect(purgeFinishedRecalcJobs).toHaveBeenCalledTimes(1);
  });

  it("keeps sweeping jobs even when a privacy purge fails", async () => {
    purgeExpiredDataRequests.mockRejectedValue(new Error("postgres down"));

    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();

    expect(purgeFinishedRecalcJobs).toHaveBeenCalledTimes(1);
  });

  it("does not let a failing job sweep stop the next privacy purge", async () => {
    purgeFinishedRecalcJobs.mockRejectedValue(new Error("postgres down"));

    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();
    await vi.advanceTimersByTimeAsync(60_000);
    await dataRetentionSettled();

    expect(purgeExpiredDataRequests).toHaveBeenCalledTimes(2);
  });
});

describe("operator security retention", () => {
  it("purges expired operator sessions and audit evidence on every sweep", async () => {
    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();
    expect(purgeExpiredOperatorSecurityData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await dataRetentionSettled();
    expect(purgeExpiredOperatorSecurityData).toHaveBeenCalledTimes(2);
  });

  it("does not let an operator purge failure stop other retention work", async () => {
    purgeExpiredOperatorSecurityData.mockRejectedValue(
      new Error("operator retention unavailable"),
    );
    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();
    expect(purgeExpiredConnectorOAuthStates).toHaveBeenCalledTimes(1);
    expect(purgeOldMerchantNotifications).toHaveBeenCalledTimes(1);
  });
});

describe("rate-limit retention", () => {
  it("purges expired privacy-safe request fingerprints", async () => {
    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();
    expect(purgeExpiredRateLimitBuckets).toHaveBeenCalledTimes(1);
  });
});

describe("MFA challenge retention", () => {
  it("purges expired one-time challenges", async () => {
    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();
    expect(purgeExpiredMfaChallenges).toHaveBeenCalledTimes(1);
  });
});

describe("waitlist delivery retention", () => {
  it("purges old sent and terminal email receipts without touching signups", async () => {
    startDataRetentionScheduler(60_000);
    await dataRetentionSettled();
    expect(purgeOldWaitlistEmailDeliveries).toHaveBeenCalledTimes(1);
  });
});
