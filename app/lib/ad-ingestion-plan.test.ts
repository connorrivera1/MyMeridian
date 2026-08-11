import { describe, expect, it } from "vitest";

import {
  addDays,
  contentHashFor,
  dayRange,
  ingestJobId,
  isoDay,
  planSyncDays,
  retryBackoffMs,
} from "./ad-ingestion-plan";

const BASE = {
  today: "2026-08-11",
  lookbackDays: 3,
  deepLookbackDays: 28,
  deepCadenceDays: 7,
  // A recent deep pass, so plans below are ordinary shallow cycles unless a
  // case says otherwise.
  lastDeepSyncAt: new Date("2026-08-10T00:00:00.000Z"),
};

function synced(...days: string[]): Set<string> {
  return new Set(days);
}

describe("planSyncDays", () => {
  it("plans the whole horizon for a never-synced connector", () => {
    const plan = planSyncDays({
      ...BASE,
      horizonStart: "2026-08-05",
      syncedDays: synced(),
    });
    expect(plan.days).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
    ]);
  });

  it("re-polls the lookback window even when it is already synced", () => {
    const plan = planSyncDays({
      ...BASE,
      horizonStart: "2026-08-05",
      syncedDays: synced(
        "2026-08-05",
        "2026-08-06",
        "2026-08-07",
        "2026-08-08",
        "2026-08-09",
        "2026-08-10",
        "2026-08-11",
      ),
    });
    // Everything is synced; only the restatement window comes back.
    expect(plan.days).toEqual(["2026-08-09", "2026-08-10", "2026-08-11"]);
  });

  it("finds a hole in the middle of an otherwise synced horizon", () => {
    // The drop-proofing property: a day lost to a killed worker, a flushed
    // Redis or a weekend outage is indistinguishable from any other unsynced
    // day, and every cycle re-derives it from the ledger.
    const plan = planSyncDays({
      ...BASE,
      horizonStart: "2026-08-01",
      syncedDays: synced(
        ...dayRange("2026-08-01", "2026-08-11").filter(
          (day) => day !== "2026-08-04",
        ),
      ),
    });
    expect(plan.days).toContain("2026-08-04");
    expect(plan.days.filter((d) => d < "2026-08-09")).toEqual(["2026-08-04"]);
  });

  it("widens to the deep lookback when the deep pass is due", () => {
    const plan = planSyncDays({
      ...BASE,
      horizonStart: "2026-06-01",
      syncedDays: synced(...dayRange("2026-06-01", "2026-08-11")),
      lastDeepSyncAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(plan.isDeepPass).toBe(true);
    // 28 days ending today.
    expect(plan.days[0]).toBe("2026-07-15");
    expect(plan.days).toHaveLength(28);
  });

  it("treats a connector that never had a deep pass as due one", () => {
    const plan = planSyncDays({
      ...BASE,
      horizonStart: "2026-08-10",
      syncedDays: synced("2026-08-10", "2026-08-11"),
      lastDeepSyncAt: null,
    });
    expect(plan.isDeepPass).toBe(true);
  });

  it("never plans beyond the horizon start, even on a deep pass", () => {
    const plan = planSyncDays({
      ...BASE,
      horizonStart: "2026-08-10",
      syncedDays: synced(),
      lastDeepSyncAt: null,
    });
    expect(plan.days).toEqual(["2026-08-10", "2026-08-11"]);
  });

  it("returns nothing for a horizon that starts tomorrow", () => {
    const plan = planSyncDays({
      ...BASE,
      horizonStart: "2026-08-12",
      syncedDays: synced(),
    });
    expect(plan.days).toEqual([]);
  });

  it("emits days oldest-first exactly once each", () => {
    const plan = planSyncDays({
      ...BASE,
      horizonStart: "2026-08-08",
      syncedDays: synced("2026-08-09"),
    });
    // 08 (gap), 09 (lookback), 10 (gap ∪ lookback — once), 11 (gap ∪ lookback).
    expect(plan.days).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
    ]);
  });
});

describe("day arithmetic", () => {
  it("round-trips ISO days across month boundaries", () => {
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isoDay(new Date("2026-08-11T23:59:59.000Z"))).toBe("2026-08-11");
  });

  it("builds inclusive ranges and tolerates reversed input", () => {
    expect(dayRange("2026-08-09", "2026-08-11")).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
    ]);
    expect(dayRange("2026-08-11", "2026-08-09")).toEqual([]);
  });
});

describe("contentHashFor", () => {
  const rows = [
    { campaignId: "a", spend: "10.00", clicks: 5 },
    { campaignId: "b", spend: "3.50", clicks: 1 },
  ];

  it("is stable across row order and key order", () => {
    const reordered = [
      { clicks: 1, spend: "3.50", campaignId: "b" },
      { spend: "10.00", clicks: 5, campaignId: "a" },
    ];
    expect(contentHashFor(rows)).toBe(contentHashFor(reordered));
  });

  it("changes when any value changes", () => {
    const restated = [
      { campaignId: "a", spend: "10.01", clicks: 5 },
      { campaignId: "b", spend: "3.50", clicks: 1 },
    ];
    expect(contentHashFor(rows)).not.toBe(contentHashFor(restated));
  });
});

describe("retry backoff", () => {
  it("keeps ids deterministic for queue-level deduplication", () => {
    expect(ingestJobId("conn_1", "2026-08-11")).toBe(
      "ingest:conn_1:2026-08-11",
    );
  });

  it("jitters inside an exponential envelope with a hard cap", () => {
    // Fixed "random" pins the jitter for assertion.
    expect(retryBackoffMs(1, () => 0)).toBe(15_000);
    expect(retryBackoffMs(1, () => 1)).toBe(30_000);
    expect(retryBackoffMs(4, () => 0)).toBe(120_000);
    // Far attempts saturate at the 30-minute cap, never overflow.
    expect(retryBackoffMs(30, () => 1)).toBe(30 * 60_000);
  });
});
