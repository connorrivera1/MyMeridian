import { randomUUID } from "node:crypto";

import { Prisma, SyncStatus, type Shop } from "@prisma/client";

import prisma from "~/db.server";

export const BACKFILL_STALE_AFTER_MS = 60 * 60 * 1000;
export const BACKFILL_LEASE_MS = 5 * 60 * 1000;
export const BACKFILL_HEARTBEAT_MS = 60 * 1000;

export interface BackfillOwner {
  token: string;
}

export class BackfillLeaseLostError extends Error {
  constructor(shopId: string) {
    super(`Historical import ownership was lost for shop ${shopId}.`);
    this.name = "BackfillLeaseLostError";
  }
}

function leaseExpiry(now: Date): Date {
  return new Date(now.getTime() + BACKFILL_LEASE_MS);
}

export interface OrderResumePoint {
  /** Shopify's `endCursor` from the last page this shop actually imported. */
  cursor: string;
  /** Orders already written by the interrupted run, so the cap stays a total. */
  importedOrders: number;
}

/**
 * Where an interrupted import should pick the order walk up again.
 *
 * Only an attempt that did not finish may be resumed. COMPLETE means the walk
 * ended and the next run is a genuine re-import; PENDING is set when scopes
 * change, and that run must start over because its GraphQL shape changed.
 */
export function resumePointFor(shop: {
  syncStatus: SyncStatus;
  syncCursor: string | null;
  syncedOrders: number;
}): OrderResumePoint | null {
  if (!shop.syncCursor) return null;
  if (
    shop.syncStatus !== SyncStatus.RUNNING &&
    shop.syncStatus !== SyncStatus.FAILED
  ) {
    return null;
  }

  return {
    cursor: shop.syncCursor,
    importedOrders: Math.max(0, shop.syncedOrders),
  };
}

export function backfillIsStale(
  shop: {
    syncStatus: SyncStatus;
    syncStartedAt: Date | null;
    syncLeaseExpiresAt?: Date | null;
  },
  now = new Date(),
): boolean {
  // A RUNNING import whose process died would otherwise show a spinner for
  // ever. New runs renew an explicit lease; the start-time fallback exists
  // only for a RUNNING row created before the lease migration was deployed.
  if (shop.syncStatus !== SyncStatus.RUNNING) return false;
  if (shop.syncLeaseExpiresAt) return shop.syncLeaseExpiresAt <= now;
  if (!shop.syncStartedAt) return true;
  return now.getTime() - shop.syncStartedAt.getTime() > BACKFILL_STALE_AFTER_MS;
}

export type BackfillClaim =
  | {
      claimed: true;
      /** Snapshot from before the claim; capabilities and resume use it. */
      shop: Shop;
      resume: OrderResumePoint | null;
      owner: BackfillOwner;
    }
  | { claimed: false; reason: "active" };

/**
 * Atomically claim one shop's historical import.
 *
 * The read decides whether this is a fresh run or a resume. The update is a
 * compare-and-set over both status and start timestamp: two browser tabs (or
 * two Fly machines) may read the same candidate, but only one can replace that
 * exact state with a new RUNNING lease. A stale RUNNING row keeps its cursor;
 * a genuinely new import clears any legacy cursor before work begins.
 */
export async function claimBackfill(
  shopId: string,
  now = new Date(),
): Promise<BackfillClaim> {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

  if (shop.syncStatus === SyncStatus.RUNNING && !backfillIsStale(shop, now)) {
    return { claimed: false, reason: "active" };
  }

  const resume = resumePointFor(shop);
  const owner = { token: randomUUID() };
  const claimed = await prisma.shop.updateMany({
    where: {
      id: shopId,
      syncStatus: shop.syncStatus,
      syncStartedAt: shop.syncStartedAt,
      syncRunToken: shop.syncRunToken,
      syncLeaseExpiresAt: shop.syncLeaseExpiresAt,
    },
    data: {
      syncStatus: SyncStatus.RUNNING,
      syncStartedAt: now,
      syncRunToken: owner.token,
      syncLeaseExpiresAt: leaseExpiry(now),
      syncCompletedAt: null,
      syncStage: resume ? "Resuming order history" : "Reading store settings",
      syncError: null,
      // Products are re-imported either way — the cursor only covers orders —
      // so product progress starts over while order progress carries forward.
      syncedOrders: resume?.importedOrders ?? 0,
      syncedProducts: 0,
      syncCursor: resume?.cursor ?? null,
    },
  });

  if (claimed.count !== 1) return { claimed: false, reason: "active" };

  return { claimed: true, shop, resume, owner };
}

async function writeForOwner(
  shopId: string,
  owner: BackfillOwner,
  data: Prisma.ShopUpdateManyMutationInput,
): Promise<void> {
  const updated = await prisma.shop.updateMany({
    where: {
      id: shopId,
      syncStatus: SyncStatus.RUNNING,
      syncRunToken: owner.token,
    },
    data,
  });

  if (updated.count !== 1) throw new BackfillLeaseLostError(shopId);
}

/** Renew ownership without changing merchant-visible progress. */
export async function renewBackfillLease(
  shopId: string,
  owner: BackfillOwner,
  now = new Date(),
): Promise<void> {
  await writeForOwner(shopId, owner, {
    syncLeaseExpiresAt: leaseExpiry(now),
  });
}

/** A fenced progress write also renews the lease. */
export async function updateBackfillProgress(
  shopId: string,
  owner: BackfillOwner,
  data: Prisma.ShopUpdateManyMutationInput,
  now = new Date(),
): Promise<void> {
  await writeForOwner(shopId, owner, {
    ...data,
    syncLeaseExpiresAt: leaseExpiry(now),
  });
}

/** Only the current owner may publish success or clear the resume cursor. */
export async function completeBackfill(
  shopId: string,
  owner: BackfillOwner,
  data: Prisma.ShopUpdateManyMutationInput,
): Promise<void> {
  await writeForOwner(shopId, owner, {
    ...data,
    syncStatus: SyncStatus.COMPLETE,
    syncRunToken: null,
    syncLeaseExpiresAt: null,
  });
}

/**
 * Record failure only while this worker still owns the run.
 *
 * Losing the lease is not the replacement run's failure, so a stale worker
 * silently loses this compare-and-set instead of changing the new owner's row.
 */
export async function failBackfill(
  shopId: string,
  owner: BackfillOwner,
  data: Prisma.ShopUpdateManyMutationInput,
): Promise<boolean> {
  const updated = await prisma.shop.updateMany({
    where: {
      id: shopId,
      syncStatus: SyncStatus.RUNNING,
      syncRunToken: owner.token,
    },
    data: {
      ...data,
      syncStatus: SyncStatus.FAILED,
      syncRunToken: null,
      syncLeaseExpiresAt: null,
    },
  });

  return updated.count === 1;
}

export interface BackfillHeartbeat {
  /** Stop the timer, wait for an in-flight renewal, and surface lease loss. */
  stop(): Promise<void>;
}

/**
 * Keep a detached import live even while one long SQL recompute is awaiting.
 * The interval spans the entire claimed task, rather than only GraphQL pages.
 */
export function startBackfillHeartbeat(
  shopId: string,
  owner: BackfillOwner,
): BackfillHeartbeat {
  let inFlight: Promise<void> | null = null;
  let lost: unknown = null;

  const beat = () => {
    if (inFlight || lost) return;
    inFlight = renewBackfillLease(shopId, owner)
      .catch((error) => {
        lost = error;
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(beat, BACKFILL_HEARTBEAT_MS);
  timer.unref?.();

  return {
    async stop() {
      clearInterval(timer);
      if (inFlight) await inFlight;
      if (lost) throw lost;
    },
  };
}
