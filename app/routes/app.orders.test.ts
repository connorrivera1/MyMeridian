import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import {
  OrdersView,
  ProfitBreakdownDrawer,
  paginateOrders,
} from "./app.orders";

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

    const page1 = paginateOrders(all, {
      sort: "recent",
      channelFilter: null,
      page: 1,
    });
    const page2 = paginateOrders(all, {
      sort: "recent",
      channelFilter: null,
      page: 2,
    });
    const page3 = paginateOrders(all, {
      sort: "recent",
      channelFilter: null,
      page: 3,
    });

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

    const best = paginateOrders(rows, {
      sort: "best",
      channelFilter: null,
      page: 1,
    });
    expect(best.rows.map((o) => o.netProfitCents)).toEqual([4, 3, 2, 1, 0]);

    const worst = paginateOrders(rows, {
      sort: "worst",
      channelFilter: null,
      page: 1,
    });
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

function orderViewData(mode: "connected" | "unavailable") {
  return {
    rangeLabel: "30 days",
    preset: "30d" as const,
    sort: "recent" as const,
    channelFilter: null,
    currency: "USD",
    timezone: "America/Los_Angeles",
    adSpendCoverage: {
      mode,
      syncedSourceCount: mode === "connected" ? 1 : 0,
    },
    channels: ["DIRECT" as const],
    summary: {
      orderCount: 1,
      profitPerOrderCents: 4_000,
      profitPerOrderChange: 0.1,
      aovCents: 10_000,
      aovChange: 0.05,
      marginPct: 0.4,
      lossMakingCount: 0,
      lossMakingShare: 0,
      lossTotalCents: 0,
      missingCogsOrders: 0,
      modeledCostOrders: 0,
    },
    daily: [{ label: "Aug 10", value: 4_000 }],
    spark: [3_500, 4_000],
    total: 1,
    page: 1,
    pageCount: 1,
    previousCursor: null,
    nextCursor: null,
    orders: [
      {
        orderId: "order_1",
        orderNumber: 1001,
        processedAt: new Date("2026-08-10T12:00:00Z"),
        channel: "DIRECT" as const,
        isFirstOrder: false,
        netRevenueCents: 10_000,
        cogsCents: 3_000,
        shippingCostCents: 500,
        feesCents: 723,
        adCostCents: 777,
        overheadCents: 1_000,
        netProfitCents: 4_000,
        marginPct: 0.4,
        units: 1,
        hasMissingCogs: false,
        usesModeledCosts: false,
        usesEstimatedCosts: false,
      },
    ],
    // The order field draws every order in the range; one is enough to prove
    // the view renders it, and the fixture stays readable.
    field: { numbers: [1001], profits: [4_000] },
    focusedOrder: null,
  };
}

function renderOrders(mode: "connected" | "unavailable") {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ["/app/orders?range=30d"] },
      createElement(OrdersView, { data: orderViewData(mode) }),
    ),
  );
}

describe("Orders ad-spend honesty", () => {
  it("uses one accessible channel dropdown with an All option", () => {
    const html = renderOrders("connected");

    expect(html).toContain('id="orders-channel-filter"');
    expect(html).toContain("All channels");
    expect(html).toContain("Direct");
  });

  it("renders unavailable live-store Ads cells as a dash and qualifies profit and margin", () => {
    const html = renderOrders("unavailable");

    expect(html).toContain("Profit per order before paid marketing");
    expect(html).toContain("Margin before paid marketing");
    expect(html).toContain("Daily profit before paid marketing");
    expect(html).toContain("Profit and margin are before paid marketing");
    expect(html).toMatch(
      /<th class="right">Ads<\/th>[\s\S]*<td class="right muted">—<\/td>/,
    );
    expect(html).not.toContain("-$7.77");
  });

  it("labels synced live-store figures as after available costs", () => {
    const html = renderOrders("connected");

    expect(html).toContain("Profit per order after available costs");
    expect(html).toContain("Margin after available costs");
    expect(html).toContain("Recorded ads");
    expect(html).toContain("-$7.77");
    expect(html).toContain("unconnected paid-marketing spend are excluded");
  });

  it("separates missing COGS from reviewed cost models", () => {
    const data = orderViewData("connected");
    data.summary.missingCogsOrders = 1;
    data.summary.modeledCostOrders = 1;
    data.orders[0]!.hasMissingCogs = true;
    data.orders[0]!.usesModeledCosts = true;
    data.orders[0]!.usesEstimatedCosts = true;

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/app/orders?range=30d"] },
        createElement(OrdersView, { data }),
      ),
    );

    expect(html).toContain("missing Shopify COGS");
    expect(html).toContain("acknowledgement but does not make them measured");
    expect(html).toContain(
      'title="Shopify COGS is missing; configured cost models are used"',
    );
  });

  it("renders order instants in the merchant timezone, not the browser timezone", () => {
    const data = orderViewData("connected");
    data.orders[0]!.processedAt = new Date("2026-08-11T03:30:00.000Z");

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/app/orders?range=30d"] },
        createElement(OrdersView, { data }),
      ),
    );

    expect(html).toContain("Aug 10");
    expect(html).not.toContain("Aug 11");
  });
});

describe("ProfitBreakdownDrawer", () => {
  it("shows the complete revenue and cost formula without merging refunds or fees", () => {
    type DrawerProps = Parameters<typeof ProfitBreakdownDrawer>[0];
    const order: DrawerProps["order"] = {
      orderNumber: 1001,
      processedAt: new Date("2026-08-11T03:30:00.000Z"),
      channel: "DIRECT",
      units: 2,
      grossRevenueCents: 10_000,
      discountCents: 1_000,
      refundCents: 2_000,
      shippingRevenueCents: 500,
      netRevenueCents: 7_500,
      cogsCents: 2_300,
      shippingCostCents: 500,
      paymentFeeCents: 321,
      pickPackCents: 175,
      adCostCents: 700,
      overheadCents: 400,
      contributionProfitCents: 3_504,
      netProfitCents: 3_104,
      marginPct: 0.4139,
      hasMissingCogs: true,
      usesModeledCosts: true,
    };

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/app/orders?range=30d&order=1001"] },
        createElement(ProfitBreakdownDrawer, {
          order,
          currency: "USD",
          adSpendMeasured: true,
          profitBasis: "after available costs",
          timeZone: "America/Los_Angeles",
          closeTo: "?range=30d",
        }),
      ),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Transparent math");
    expect(html).toContain("Revenue kept");
    expect(html).toContain("Merchandise subtotal");
    expect(html).toContain("Discounts");
    expect(html).toContain("Refunds (excluding tax)");
    expect(html).toContain("Payment processing");
    expect(html).toContain("Pick &amp; pack");
    expect(html).toContain("Attributed ad spend");
    expect(html).toContain("Allocated overhead");
    expect(html).toContain("Cost confidence");
    expect(html).toContain("Aug 10, 2026");
    expect(html).toContain("Close profit breakdown");
  });

  it("does not pretend unsynced paid marketing is zero", () => {
    type DrawerProps = Parameters<typeof ProfitBreakdownDrawer>[0];
    const order: DrawerProps["order"] = {
      orderNumber: 1001,
      processedAt: new Date("2026-08-10T12:00:00.000Z"),
      channel: "DIRECT",
      units: 1,
      grossRevenueCents: 10_000,
      discountCents: 0,
      refundCents: 0,
      shippingRevenueCents: 0,
      netRevenueCents: 10_000,
      cogsCents: 2_000,
      shippingCostCents: 500,
      paymentFeeCents: 320,
      pickPackCents: 175,
      adCostCents: 700,
      overheadCents: 0,
      contributionProfitCents: 7_005,
      netProfitCents: 7_005,
      marginPct: 0.7005,
      hasMissingCogs: false,
      usesModeledCosts: false,
    };

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/app/orders?range=30d&order=1001"] },
        createElement(ProfitBreakdownDrawer, {
          order,
          currency: "USD",
          adSpendMeasured: false,
          profitBasis: "before paid marketing",
          timeZone: "America/Los_Angeles",
          closeTo: "?range=30d",
        }),
      ),
    );

    expect(html).toContain("Paid marketing");
    expect(html).toContain("not included — no synced source");
    expect(html).not.toContain("Attributed ad spend");
  });
});
