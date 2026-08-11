import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-shopify-api-secret";
process.env.SHOPIFY_APP_URL = "https://meridian-test.example.com";
process.env.SCOPES = "read_orders,read_products";

const { AdSpendCoverageBanner, isEntitlementExemptPath } =
  await import("./app.layout");

describe("subscription-exempt routes", () => {
  it("keeps billing and privacy handoff reachable without opening paid data", () => {
    expect(isEntitlementExemptPath("/app/plan")).toBe(true);
    expect(isEntitlementExemptPath("/app/privacy-requests")).toBe(true);
    expect(isEntitlementExemptPath("/app/privacy-requests/")).toBe(true);
    expect(
      isEntitlementExemptPath("/app/privacy-requests/request_1/download"),
    ).toBe(true);
    expect(isEntitlementExemptPath("/app/privacy-requests/request_1")).toBe(
      false,
    );
    expect(isEntitlementExemptPath("/app/settings")).toBe(false);
    expect(isEntitlementExemptPath("/app/orders")).toBe(false);
  });
});

describe("app-wide ad-spend qualification", () => {
  it("states that live-store profit is before unmeasured paid marketing", () => {
    const html = renderToStaticMarkup(
      createElement(AdSpendCoverageBanner, {
        coverage: { mode: "unavailable", syncedSourceCount: 0 },
      }),
    );

    expect(html).toContain("Profit is before paid marketing");
    expect(html).toContain("shown as a dash, never as zero");
  });

  it("qualifies partial connector coverage rather than implying completeness", () => {
    const html = renderToStaticMarkup(
      createElement(AdSpendCoverageBanner, {
        coverage: { mode: "connected", syncedSourceCount: 2 },
      }),
    );

    expect(html).toContain("recorded paid marketing only");
    expect(html).toContain("2 paid sources have completed a sync");
    expect(html).toContain("any other account or platform");
  });
});
