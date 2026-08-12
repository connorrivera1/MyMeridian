import { RecalcJobKind, RecalcJobStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shopFind: vi.fn(),
  shopFindOrThrow: vi.fn(),
  shopUpdateMany: vi.fn(),
  enqueueExclusive: vi.fn(),
  wake: vi.fn(),
  runBackfill: vi.fn(),
  admin: { graphql: vi.fn() },
  unauthenticatedAdmin: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUnique: mocks.shopFind,
      findUniqueOrThrow: mocks.shopFindOrThrow,
      updateMany: mocks.shopUpdateMany,
    },
  },
}));

vi.mock("~/lib/recalc-queue.server", () => ({
  enqueueExclusiveRecalcJob: mocks.enqueueExclusive,
  wakeRecalcWorker: mocks.wake,
}));

vi.mock("~/lib/backfill.server", () => ({
  runBackfill: mocks.runBackfill,
}));

vi.mock("~/shopify.server", () => ({
  unauthenticated: { admin: mocks.unauthenticatedAdmin },
}));

import {
  requestBackfill,
  runHistoricalBackfillJob,
} from "./backfill-queue.server";

const job = {
  id: "job_1",
  shopId: "shop_1",
  kind: RecalcJobKind.HISTORICAL_BACKFILL,
  status: RecalcJobStatus.QUEUED,
  dedupeKey: "historical-backfill:shop_1",
  payload: { shopId: "shop_1" },
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

describe("durable historical backfills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shopFindOrThrow.mockResolvedValue({
      id: "shop_1",
      syncStatus: "FAILED",
      syncCursor: "cursor-10",
      syncedOrders: 250,
    });
    mocks.shopUpdateMany.mockResolvedValue({ count: 0 });
    mocks.enqueueExclusive.mockResolvedValue({ job, created: true });
    mocks.unauthenticatedAdmin.mockResolvedValue({ admin: mocks.admin });
    mocks.runBackfill.mockResolvedValue({
      products: 40,
      orders: 900,
      usedJourneyAttribution: true,
      reachedOrderCap: false,
      earliestOrderAt: new Date("2025-01-01T00:00:00Z"),
      durationMs: 12_000,
    });
  });

  it("persists the job before waking the worker and preserves resume state", async () => {
    await expect(requestBackfill("shop_1")).resolves.toEqual({
      started: true,
      resumed: true,
      jobId: "job_1",
    });

    expect(mocks.enqueueExclusive).toHaveBeenCalledWith({
      shopId: "shop_1",
      kind: RecalcJobKind.HISTORICAL_BACKFILL,
      payload: { shopId: "shop_1" },
      dedupeKey: "historical-backfill:shop_1",
    });
    expect(mocks.shopUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          syncStatus: { notIn: ["RUNNING", "FAILED"] },
        }),
      }),
    );
    expect(mocks.wake).toHaveBeenCalledOnce();
  });

  it("does not wake or queue another import when one already exists", async () => {
    mocks.enqueueExclusive.mockResolvedValue({ job, created: false });

    await expect(requestBackfill("shop_1")).resolves.toEqual({
      started: false,
      reason: "active",
      jobId: "job_1",
    });
    expect(mocks.shopUpdateMany).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("re-acquires the offline Shopify client inside the leased worker", async () => {
    mocks.shopFind.mockResolvedValue({
      id: "shop_1",
      domain: "store.myshopify.com",
      uninstalledAt: null,
    });

    await expect(runHistoricalBackfillJob(job)).resolves.toEqual({
      products: 40,
      orders: 900,
      usedJourneyAttribution: true,
      reachedOrderCap: false,
      durationMs: 12_000,
    });
    expect(mocks.unauthenticatedAdmin).toHaveBeenCalledWith(
      "store.myshopify.com",
    );
    expect(mocks.runBackfill).toHaveBeenCalledWith("shop_1", mocks.admin);
  });

  it("finishes harmlessly when the shop was uninstalled before execution", async () => {
    mocks.shopFind.mockResolvedValue({
      id: "shop_1",
      domain: "store.myshopify.com",
      uninstalledAt: new Date(),
    });

    await expect(runHistoricalBackfillJob(job)).resolves.toEqual({
      skipped: "shop_uninstalled",
    });
    expect(mocks.unauthenticatedAdmin).not.toHaveBeenCalled();
    expect(mocks.runBackfill).not.toHaveBeenCalled();
  });
});
