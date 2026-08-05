import type { Shop } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

/**
 * `resolveRange` decides which orders every screen in the app is allowed to
 * see, so getting it wrong is not a cosmetic problem — it silently deletes
 * trading from the merchant's view.
 *
 * The regression these cover: the window used to end at `shop.lastSyncedAt`,
 * which is written once when the install backfill finishes and never again.
 * Every order that arrived afterwards by webhook has
 * `processedAt > lastSyncedAt`, and `loadEngineOrders` filters on
 * `processedAt <= range.to` — so a live store's dashboard froze on install day
 * and no order placed after it ever appeared.
 */

vi.mock("~/db.server", () => ({ default: {} }));

const { resolveRange } = await import("./analytics.server");

const DAY_MS = 86_400_000;

function shopWithLastSync(lastSyncedAt: Date | null): Shop {
  return { id: "shop_1", lastSyncedAt } as Shop;
}

describe("resolveRange", () => {
  it("ends the window at now for a live store, not at the last backfill", () => {
    const staleSync = new Date(Date.now() - 30 * DAY_MS);
    const range = resolveRange(shopWithLastSync(staleSync), "7d");

    expect(range.to.getTime()).toBeGreaterThan(staleSync.getTime());
    expect(Math.abs(range.to.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("includes an order that arrived by webhook after the last backfill", () => {
    const backfilledAt = new Date(Date.now() - 10 * DAY_MS);
    const webhookOrderAt = new Date(Date.now() - 1 * DAY_MS);

    const range = resolveRange(shopWithLastSync(backfilledAt), "7d");

    // This is exactly the predicate loadEngineOrders applies.
    const visible =
      webhookOrderAt >= range.from && webhookOrderAt <= range.to;

    expect(visible).toBe(true);
  });

  it("spans the requested number of days", () => {
    const range = resolveRange(shopWithLastSync(null), "30d");
    const spanDays = (range.to.getTime() - range.from.getTime()) / DAY_MS;

    expect(spanDays).toBeCloseTo(30, 5);
  });

  it("anchors to the seeded data only when a caller opts in", () => {
    // The demo store's data ends at a fixed point in the past; anchoring it to
    // now would show an empty window. Nothing else may use this.
    const seededTo = new Date(Date.now() - 30 * DAY_MS);
    const range = resolveRange(shopWithLastSync(seededTo), "7d", {
      anchorToData: true,
    });

    expect(range.to.getTime()).toBe(seededTo.getTime());
  });

  it("falls back to now when a store has never synced, even anchored", () => {
    const range = resolveRange(shopWithLastSync(null), "7d", {
      anchorToData: true,
    });

    expect(Math.abs(range.to.getTime() - Date.now())).toBeLessThan(5_000);
  });
});
