import { RecalcJobKind, RecalcJobStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  wake: vi.fn(),
  recompute: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("~/lib/recalc-queue.server", () => ({
  enqueueRecalcJob: mocks.enqueue,
  wakeRecalcWorker: mocks.wake,
}));
vi.mock("~/lib/recompute.server", () => ({
  recomputeShopProfitability: mocks.recompute,
}));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: mocks.invalidate,
}));

import {
  enqueueShopRecompute,
  runFullRecomputeJob,
} from "./recompute-queue.server";

const job = {
  id: "job_1",
  shopId: "shop_1",
  kind: RecalcJobKind.FULL_RECOMPUTE,
  status: RecalcJobStatus.QUEUED,
  dedupeKey: "full-recompute:shop_1",
  payload: { reason: "cost_rule_changed" },
  result: null,
  attempts: 0,
  availableAt: new Date(),
  leaseToken: null,
  leaseExpiresAt: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  createdAt: new Date(),
};

describe("durable full-store recompute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueue.mockResolvedValue(job);
    mocks.recompute.mockResolvedValue({
      ordersUpdated: 123,
      customersUpdated: 45,
      netProfitCents: 678_900,
      unattributedAdSpendCents: 321,
      durationMs: 4_500,
    });
  });

  it("persists and deduplicates work before waking the worker", async () => {
    await expect(
      enqueueShopRecompute("shop_1", "cost_rule_changed"),
    ).resolves.toEqual({ jobId: "job_1" });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      shopId: "shop_1",
      kind: RecalcJobKind.FULL_RECOMPUTE,
      payload: { reason: "cost_rule_changed" },
      dedupeKey: "full-recompute:shop_1",
    });
    expect(mocks.wake).toHaveBeenCalledOnce();
  });

  it("publishes bounded result metadata and invalidates warm analytics", async () => {
    await expect(runFullRecomputeJob(job)).resolves.toEqual({
      ordersUpdated: 123,
      customersUpdated: 45,
      netProfitCents: 678_900,
      unattributedAdSpendCents: 321,
      durationMs: 4_500,
    });
    expect(mocks.recompute).toHaveBeenCalledWith("shop_1");
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });
});
