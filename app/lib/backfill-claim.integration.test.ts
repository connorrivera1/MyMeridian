import { SyncStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Compare-and-set contention is ultimately a PostgreSQL guarantee. */
const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("backfill claim, against a real Postgres", () => {
  let prisma: any;
  let claimBackfill: (shopId: string, now?: Date) => Promise<any>;
  let renewBackfillLease: (
    shopId: string,
    owner: { token: string },
    now?: Date,
  ) => Promise<void>;
  let updateBackfillProgress: (
    shopId: string,
    owner: { token: string },
    data: Record<string, unknown>,
  ) => Promise<void>;
  let completeBackfill: (
    shopId: string,
    owner: { token: string },
    data: Record<string, unknown>,
  ) => Promise<void>;
  let failBackfill: (
    shopId: string,
    owner: { token: string },
    data: Record<string, unknown>,
  ) => Promise<boolean>;
  let shopId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    ({
      claimBackfill,
      renewBackfillLease,
      updateBackfillProgress,
      completeBackfill,
      failBackfill,
    } = await import("./backfill-claim.server"));

    const shop = await prisma.shop.create({
      data: {
        domain: `backfill-claim-${Date.now()}.myshopify.com`,
        name: "Backfill Claim Test",
        timezone: "UTC",
      },
    });
    shopId = shop.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  it("commits exactly one winner when two processes claim concurrently", async () => {
    const now = new Date("2026-08-10T16:00:00.000Z");
    const results = await Promise.all([
      claimBackfill(shopId, now),
      claimBackfill(shopId, now),
    ]);

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)).toEqual([
      { claimed: false, reason: "active" },
    ]);
  });

  it("reclaims a stale run without losing its durable cursor", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        syncStatus: SyncStatus.RUNNING,
        syncStartedAt: new Date("2026-08-10T12:00:00.000Z"),
        syncRunToken: "dead-owner",
        syncLeaseExpiresAt: new Date("2026-08-10T15:59:59.999Z"),
        syncCursor: "cursor_page_480",
        syncedOrders: 12_000,
      },
    });

    const result = await claimBackfill(
      shopId,
      new Date("2026-08-10T16:00:00.000Z"),
    );
    expect(result).toMatchObject({
      claimed: true,
      resume: { cursor: "cursor_page_480", importedOrders: 12_000 },
    });

    const stored = await prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
    });
    expect(stored).toMatchObject({
      syncStatus: SyncStatus.RUNNING,
      syncRunToken: result.owner.token,
      syncCursor: "cursor_page_480",
      syncedOrders: 12_000,
      syncStage: "Resuming order history",
    });
  });

  it("keeps a heartbeat-renewed run unclaimable beyond one hour", async () => {
    const startedAt = new Date("2026-08-10T16:00:00.000Z");
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        syncStatus: SyncStatus.PENDING,
        syncStartedAt: null,
        syncRunToken: null,
        syncLeaseExpiresAt: null,
        syncCursor: null,
        syncedOrders: 0,
      },
    });
    const owner = await claimBackfill(shopId, startedAt);
    if (!owner.claimed) throw new Error("test: initial claim lost");

    for (let minutes = 4; minutes <= 60; minutes += 4) {
      await renewBackfillLease(
        shopId,
        owner.owner,
        new Date(startedAt.getTime() + minutes * 60_000),
      );
    }

    await expect(
      claimBackfill(shopId, new Date(startedAt.getTime() + 61 * 60_000)),
    ).resolves.toEqual({ claimed: false, reason: "active" });
  });

  it("fences progress and every terminal write from the replaced owner", async () => {
    const startedAt = new Date("2026-08-10T18:00:00.000Z");
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        syncStatus: SyncStatus.FAILED,
        syncStartedAt: null,
        syncRunToken: null,
        syncLeaseExpiresAt: null,
        syncCursor: "cursor_before_takeover",
        syncedOrders: 500,
        syncStage: null,
      },
    });
    const oldOwner = await claimBackfill(shopId, startedAt);
    if (!oldOwner.claimed) throw new Error("test: old owner claim lost");
    const newOwner = await claimBackfill(
      shopId,
      new Date(startedAt.getTime() + 6 * 60_000),
    );
    if (!newOwner.claimed) throw new Error("test: takeover claim lost");

    await expect(
      updateBackfillProgress(shopId, oldOwner.owner, {
        syncedOrders: 999,
        syncCursor: "old_owner_cursor",
      }),
    ).rejects.toThrow(/ownership was lost/i);
    await expect(
      completeBackfill(shopId, oldOwner.owner, {
        syncStage: null,
        syncCursor: null,
      }),
    ).rejects.toThrow(/ownership was lost/i);
    await expect(
      failBackfill(shopId, oldOwner.owner, {
        syncStage: null,
        syncError: "old owner failure",
      }),
    ).resolves.toBe(false);

    const stored = await prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
    });
    expect(stored).toMatchObject({
      syncStatus: SyncStatus.RUNNING,
      syncRunToken: newOwner.owner.token,
      syncCursor: "cursor_before_takeover",
      syncedOrders: 500,
      syncStage: "Resuming order history",
      syncError: null,
    });
  });
});
