import { describe, expect, it } from "vitest";

import { paginateOrders } from "./app.orders";

/**
 * `paginateOrders` is the sort/filter/page slice the Orders table loader
 * applies to a period's worth of orders. Before this test the table had a
 * hardcoded `slice(0, PAGE_SIZE)` and no `page` param at all — a store with
 * more than 60 orders in its window had no way to see order 61 onward. This
 * covers the slice math and, especially, the out-of-range clamp: a stale
 * bookmark or a hand-edited `?page=` must land on a real page, not a blank
 * table or a thrown error.
 */

interface Row {
  id: string;
  channel: string;
  netProfitCents: number;
  processedAt: Date;
}

function orders(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `order_${i}`,
    channel: i % 2 === 0 ? "DIRECT" : "GOOGLE",
    netProfitCents: i,
    processedAt: new Date(2026, 0, 1 + i),
  }));
}

describe("paginateOrders", () => {
  it("returns everything on one page when the set fits", () => {
    const result = paginateOrders(orders(10), {
      sort: "recent",
      channelFilter: null,
      page: 1,
    });

    expect(result.total).toBe(10);
    expect(result.pageCount).toBe(1);
    expect(result.page).toBe(1);
    expect(result.rows).toHaveLength(10);
  });

  it("splits a set larger than PAGE_SIZE (60) across pages", () => {
    const all = orders(130);

    const page1 = paginateOrders(all, { sort: "recent", channelFilter: null, page: 1 });
    const page2 = paginateOrders(all, { sort: "recent", channelFilter: null, page: 2 });
    const page3 = paginateOrders(all, { sort: "recent", channelFilter: null, page: 3 });

    expect(page1.pageCount).toBe(3);
    expect(page1.rows).toHaveLength(60);
    expect(page2.rows).toHaveLength(60);
    expect(page3.rows).toHaveLength(10);

    // No overlap and nothing dropped between pages.
    const seen = new Set(
      [...page1.rows, ...page2.rows, ...page3.rows].map((o) => o.id),
    );
    expect(seen.size).toBe(130);
  });

  it("clamps a page number past the end to the last real page", () => {
    const result = paginateOrders(orders(130), {
      sort: "recent",
      channelFilter: null,
      page: 999,
    });

    expect(result.page).toBe(3);
    expect(result.rows).toHaveLength(10);
  });

  it("clamps a page number below 1 up to page 1", () => {
    const result = paginateOrders(orders(10), {
      sort: "recent",
      channelFilter: null,
      page: 0,
    });

    expect(result.page).toBe(1);
  });

  it("clamps a non-numeric page to page 1 instead of producing NaN slices", () => {
    const result = paginateOrders(orders(10), {
      sort: "recent",
      channelFilter: null,
      page: Number("not-a-number"),
    });

    expect(result.page).toBe(1);
    expect(result.rows).toHaveLength(10);
  });

  it("re-clamps against the narrower set once a channel filter is applied", () => {
    // Only order_0 is TIKTOK; filtering drops the set to 1 row, so a page
    // that was valid against the unfiltered 10 must fall back to 1.
    const all = orders(10);
    all[0]!.channel = "TIKTOK";

    const result = paginateOrders(all, {
      sort: "recent",
      channelFilter: "TIKTOK",
      page: 2,
    });

    expect(result.total).toBe(1);
    expect(result.pageCount).toBe(1);
    expect(result.page).toBe(1);
    expect(result.rows.every((o) => o.channel === "TIKTOK")).toBe(true);
  });

  it("sorts by most recent first", () => {
    const result = paginateOrders(orders(5), {
      sort: "recent",
      channelFilter: null,
      page: 1,
    });

    const dates = result.rows.map((o) => o.processedAt.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it("sorts by most and least profitable", () => {
    const rows = orders(5);

    const best = paginateOrders(rows, { sort: "best", channelFilter: null, page: 1 });
    expect(best.rows.map((o) => o.netProfitCents)).toEqual([4, 3, 2, 1, 0]);

    const worst = paginateOrders(rows, { sort: "worst", channelFilter: null, page: 1 });
    expect(worst.rows.map((o) => o.netProfitCents)).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns an empty page rather than throwing on zero matching orders", () => {
    const result = paginateOrders(orders(10), {
      sort: "recent",
      channelFilter: "TIKTOK",
      page: 1,
    });

    expect(result.total).toBe(0);
    expect(result.pageCount).toBe(1);
    expect(result.page).toBe(1);
    expect(result.rows).toHaveLength(0);
  });
});
