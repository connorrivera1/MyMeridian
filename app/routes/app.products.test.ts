import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProductsView } from "./app.products";

function productViewData(mode: "connected" | "unavailable") {
  return {
    rangeLabel: "30 days",
    currency: "USD",
    hasCustomerData: false,
    adSpendCoverage: {
      mode,
      syncedSourceCount: mode === "connected" ? 1 : 0,
    },
    counts: { profitable: 1, thin: 0, bleeding: 0, uncosted: 0 },
    bleedingTotalCents: 0,
    products: [
      {
        productId: "product_1",
        title: "Field Jacket",
        classification: "PROFITABLE" as
          | "PROFITABLE"
          | "THIN_MARGIN"
          | "BLEEDING"
          | "MISSING_COGS",
        units: 2,
        ordersContaining: 1,
        netRevenueCents: 20_000,
        cogsCents: 6_000,
        allocatedCostsCents: 2_300,
        allocatedAdCostCents: 777,
        contributionProfitCents: 10_923,
        marginPct: 0.54615,
        profitPerUnitCents: 5_462,
        attachRatePct: 0.5,
        hasMissingCogs: false,
        usesModeledCosts: true,
      },
    ],
  };
}

function renderProducts(mode: "connected" | "unavailable") {
  return renderToStaticMarkup(
    createElement(ProductsView, { data: productViewData(mode) }),
  );
}

describe("Products ad-spend honesty", () => {
  it("renders unavailable live-store Ads cells as a dash without claiming exact figures", () => {
    const html = renderProducts("unavailable");

    expect(html).toContain(
      "Product contribution and margin are before paid marketing",
    );
    expect(html).toContain(
      "Contribution profit before paid marketing by product",
    );
    expect(html).toContain(
      "contribution, margin and per-unit profit exclude that unavailable cost",
    );
    expect(html).toMatch(
      /<th class="right">Ads<\/th>[\s\S]*<td class="right muted">—<\/td>/,
    );
    expect(html).not.toContain("-$8");
    expect(html.toLowerCase()).not.toContain("exact");
  });

  it("labels synced live-store figures as available and Ads cells as recorded", () => {
    const html = renderProducts("connected");

    expect(html).toContain(
      "Product contribution and margin are after available costs",
    );
    expect(html).toContain(
      "Contribution profit after available costs by product",
    );
    expect(html).toContain("Recorded ads");
    expect(html).toContain("-$8");
    expect(html).toContain(
      "Reviewing those assumptions records acknowledgement",
    );
    expect(html).toContain("unconnected paid-marketing spend remains outside");
  });

  it("withholds a profitability verdict when sold units have no COGS", () => {
    const data = productViewData("connected");
    data.products[0]!.classification = "MISSING_COGS";
    data.products[0]!.hasMissingCogs = true;
    data.counts.profitable = 0;
    data.counts.uncosted = 1;

    const html = renderToStaticMarkup(createElement(ProductsView, { data }));

    expect(html).toContain(
      "labelled Needs COGS instead of profitable or bleeding",
    );
    expect(html).toContain("Needs COGS");
    expect(html).toContain("missing COGS · modeled costs");
  });
});
