import { SyncStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shop = {
  id: "shop_1",
  syncStatus: SyncStatus.PENDING as SyncStatus,
  syncStartedAt: null as Date | null,
  syncRunToken: null as string | null,
  syncLeaseExpiresAt: null as Date | null,
  syncCursor: null as string | null,
  syncedOrders: 0,
  syncStage: null as string | null,
};

function sameDate(left: Date | null | undefined, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

const updateMany = vi.fn(
  async ({
    where,
    data,
  }: {
    where: {
      id: string;
      syncStatus: SyncStatus;
      syncStartedAt?: Date | null;
      syncRunToken?: string | null;
      syncLeaseExpiresAt?: Date | null;
    };
    data: Record<string, unknown>;
  }) => {
    if (
      where.id !== shop.id ||
      where.syncStatus !== shop.syncStatus ||
      ("syncStartedAt" in where &&
        !sameDate(where.syncStartedAt, shop.syncStartedAt)) ||
      ("syncRunToken" in where && where.syncRunToken !== shop.syncRunToken) ||
      ("syncLeaseExpiresAt" in where &&
        !sameDate(where.syncLeaseExpiresAt, shop.syncLeaseExpiresAt))
    ) {
      return { count: 0 };
    }

    Object.assign(shop, data);
    return { count: 1 };
  },
);

const prismaMock = {
  shop: {
    // Return a snapshot. Two concurrent callers can observe the same PENDING
    // row, which is the exact race the updateMany compare-and-set must settle.
    findUniqueOrThrow: vi.fn(async () => ({ ...shop })),
    updateMany,
  },
};

vi.mock("~/db.server", () => ({ default: prismaMock }));

const {
  BackfillLeaseLostError,
  backfillIsStale,
  claimBackfill,
  completeBackfill,
  failBackfill,
  startBackfillHeartbeat,
  updateBackfillProgress,
} = await import("./backfill-claim.server");

const NOW = new Date("2026-08-10T16:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  shop.syncStatus = SyncStatus.PENDING;
  shop.syncStartedAt = null;
  shop.syncRunToken = null;
  shop.syncLeaseExpiresAt = null;
  shop.syncCursor = null;
  shop.syncedOrders = 0;
  shop.syncStage = null;
});

describe("atomic historical-import claim", () => {
  it("reclaims a stale RUNNING row and preserves its order cursor", async () => {
    shop.syncStatus = SyncStatus.RUNNING;
    shop.syncStartedAt = new Date("2026-08-10T14:00:00.000Z");
    shop.syncLeaseExpiresAt = new Date("2026-08-10T15:59:59.999Z");
    shop.syncCursor = "cursor_page_480";
    shop.syncedOrders = 12_000;

    const result = await claimBackfill(shop.id, NOW);

    expect(result).toMatchObject({
      claimed: true,
      resume: { cursor: "cursor_page_480", importedOrders: 12_000 },
    });
    expect(shop).toMatchObject({
      syncStatus: SyncStatus.RUNNING,
      syncStartedAt: NOW,
      syncRunToken: expect.any(String),
      syncLeaseExpiresAt: new Date("2026-08-10T16:05:00.000Z"),
      syncCursor: "cursor_page_480",
      syncedOrders: 12_000,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStage: "Resuming order history",
          syncCursor: "cursor_page_480",
        }),
      }),
    );
  });

  it("rejects a healthy lease even when the import started over an hour ago", async () => {
    shop.syncStatus = SyncStatus.RUNNING;
    shop.syncStartedAt = new Date("2026-08-10T12:30:00.000Z");
    shop.syncRunToken = "healthy-owner";
    shop.syncLeaseExpiresAt = new Date("2026-08-10T16:03:00.000Z");
    shop.syncCursor = "cursor_page_3";

    await expect(claimBackfill(shop.id, NOW)).resolves.toEqual({
      claimed: false,
      reason: "active",
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(shop.syncCursor).toBe("cursor_page_3");
  });

  it("allows one winner when two processes race the same candidate", async () => {
    const [first, second] = await Promise.all([
      claimBackfill(shop.id, NOW),
      claimBackfill(shop.id, NOW),
    ]);

    expect([first, second].filter((result) => result.claimed)).toHaveLength(1);
    expect([first, second].filter((result) => !result.claimed)).toEqual([
      { claimed: false, reason: "active" },
    ]);
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("fences every old-owner write after an expired lease is reclaimed", async () => {
    shop.syncStatus = SyncStatus.FAILED;
    shop.syncCursor = "cursor_page_9";
    shop.syncedOrders = 225;
    const first = await claimBackfill(shop.id, NOW);
    if (!first.claimed) throw new Error("test: first claim lost");

    const replacement = await claimBackfill(
      shop.id,
      new Date("2026-08-10T16:06:00.000Z"),
    );
    if (!replacement.claimed) throw new Error("test: replacement claim lost");

    await expect(
      updateBackfillProgress(shop.id, first.owner, {
        syncedOrders: 999,
        syncCursor: "old-owner-cursor",
      }),
    ).rejects.toBeInstanceOf(BackfillLeaseLostError);
    await expect(
      completeBackfill(shop.id, first.owner, {
        syncCursor: null,
        syncStage: null,
      }),
    ).rejects.toBeInstanceOf(BackfillLeaseLostError);
    await expect(
      failBackfill(shop.id, first.owner, {
        syncStage: null,
        syncError: "old owner failed",
      }),
    ).resolves.toBe(false);

    expect(shop).toMatchObject({
      syncStatus: SyncStatus.RUNNING,
      syncRunToken: replacement.owner.token,
      syncCursor: "cursor_page_9",
      syncedOrders: 225,
      syncStage: "Resuming order history",
    });
  });
});

describe("renewable heartbeat", () => {
  it("keeps a healthy task unclaimable beyond one hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const claimed = await claimBackfill(shop.id);
      if (!claimed.claimed) throw new Error("test: claim lost");
      const heartbeat = startBackfillHeartbeat(shop.id, claimed.owner);

      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      expect(shop.syncLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      await expect(claimBackfill(shop.id, new Date())).resolves.toEqual({
        claimed: false,
        reason: "active",
      });

      await heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stale classification", () => {
  it("uses the one-hour boundary and treats a missing start as abandoned", () => {
    expect(
      backfillIsStale(
        {
          syncStatus: SyncStatus.RUNNING,
          syncStartedAt: new Date("2026-08-10T14:59:59.999Z"),
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      backfillIsStale(
        {
          syncStatus: SyncStatus.RUNNING,
          syncStartedAt: new Date("2026-08-10T15:00:00.000Z"),
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      backfillIsStale(
        { syncStatus: SyncStatus.RUNNING, syncStartedAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it("uses the renewable expiry instead of the original start time", () => {
    expect(
      backfillIsStale(
        {
          syncStatus: SyncStatus.RUNNING,
          syncStartedAt: new Date("2026-08-10T12:00:00.000Z"),
          syncLeaseExpiresAt: new Date("2026-08-10T16:00:00.001Z"),
        },
        NOW,
      ),
    ).toBe(false);
    expect(
      backfillIsStale(
        {
          syncStatus: SyncStatus.RUNNING,
          syncStartedAt: new Date("2026-08-10T15:59:00.000Z"),
          syncLeaseExpiresAt: NOW,
        },
        NOW,
      ),
    ).toBe(true);
  });
});
