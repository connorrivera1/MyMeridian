import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadDashboard = vi.fn();
const loadShopCampaignsSource = vi.fn();
vi.mock("~/lib/route-data.server", () => ({
  loadDashboard: (...args: unknown[]) => loadDashboard(...args),
}));
vi.mock("~/lib/shop-campaigns-status.server", () => ({
  loadShopCampaignsSource: (...args: unknown[]) =>
    loadShopCampaignsSource(...args),
}));

const { AcquisitionView, loader } = await import("./app.acquisition");

function channel(overrides: Record<string, unknown> = {}) {
  return {
    channel: "DIRECT",
    spendCents: 0,
    orders: 12,
    newCustomers: 0,
    cacCents: null,
    firstOrderProfitPerCustomerCents: 0,
    ltv90Cents: 0,
    ltv90Measurable: false,
    ltvToCacRatio: null,
    paybackDays: null,
    measuredRoas: null,
    platformRoas: null,
    attributionGapPct: null,
    netRevenueCents: 125_000,
    contributionProfitCents: 43_000,
    hasMissingCogs: false,
    usesModeledCosts: false,
    verdict: "NO_SPEND",
    ltvCurve: [
      {
        day: 0,
        cumulativeProfitPerCustomerCents: 0,
        cohortSize: 0,
        measurable: false,
      },
    ],
    ...overrides,
  };
}

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    shop: { currency: "USD" },
    rangeLabel: "30 days",
    capabilities: { customers: false },
    plan: {
      planId: "starter",
      status: "active",
      trialEndsAt: null,
      isDemo: false,
    },
    analytics: {
      period: { netRevenueCents: 125_000 },
      channels: [channel()],
      campaigns: [],
    },
    ...overrides,
  };
}

async function render() {
  const data = await loader({
    request: new Request("https://example.com/app/acquisition"),
  } as never);

  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AcquisitionView, { data })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  loadDashboard.mockResolvedValue(dashboard());
  loadShopCampaignsSource.mockResolvedValue("unavailable");
});

describe("Acquisition", () => {
  it("keeps order-derived channel revenue and profit visible with the requested scopes", async () => {
    const html = await render();

    expect(html).toContain("Revenue and Profit by Channel");
    expect(html).toContain("Net Revenue");
    expect(html).toContain("Contribution Profit");
    expect(html).toContain("Direct");
    expect(html).toContain("$1,250");
    expect(html).toContain("$430");
    expect(html).toContain(
      "Customer-level acquisition metrics are unavailable",
    );
    expect(html).toContain("fall back to Direct");
    expect(html).toContain("No ad-spend source has completed a sync");
    expect(html).not.toContain("See plans");
  });

  it("shows customer and spend analysis without turning cohorts into a paid-plan gate", async () => {
    loadDashboard.mockResolvedValue(
      dashboard({
        capabilities: { customers: true },
        analytics: {
          period: { netRevenueCents: 125_000 },
          channels: [
            channel({
              channel: "FACEBOOK",
              spendCents: 20_000,
              newCustomers: 10,
              cacCents: 2_000,
              ltv90Cents: 6_000,
              ltv90Measurable: true,
              ltvToCacRatio: 3,
              paybackDays: 14,
              measuredRoas: 6.25,
              platformRoas: 7,
              attributionGapPct: 0.12,
              verdict: "PROFITABLE",
              ltvCurve: [
                {
                  day: 0,
                  cumulativeProfitPerCustomerCents: 1_000,
                  cohortSize: 10,
                  measurable: true,
                },
                {
                  day: 90,
                  cumulativeProfitPerCustomerCents: 6_000,
                  cohortSize: 10,
                  measurable: true,
                },
              ],
            }),
          ],
          campaigns: [],
        },
      }),
    );

    const html = await render();

    expect(html).toContain("Paid Acquisition Detail");
    expect(html).toContain("Payback — Facebook Ads");
    expect(html).not.toContain("part of Scale");
    expect(html).not.toContain("See plans");
  });

  it("qualifies modeled channel profit and withholds verdicts with missing COGS", async () => {
    loadDashboard.mockResolvedValue(
      dashboard({
        analytics: {
          period: { netRevenueCents: 125_000 },
          channels: [
            channel({
              hasMissingCogs: true,
              usesModeledCosts: true,
              verdict: "PROFITABLE",
            }),
          ],
          campaigns: [],
        },
      }),
    );

    const html = await render();

    expect(html).toContain("Channel profit contains non-measured cost inputs");
    expect(html).toContain("missing COGS · configured estimates");
    expect(html).toContain("Needs COGS");
    expect(html).not.toContain(">Profitable</span>");
  });

  it("shows Shop Campaigns as unavailable rather than a false zero", async () => {
    const html = await render();

    expect(html).toContain("Shop Campaigns");
    expect(html).toContain("This store has no Shop Campaigns source yet");
    expect(html).toContain("not use MyMeridian’s own Shopify App Store advertising");
  });

  it("keeps Shopify-reported Shop Campaign figures separate from order attribution", async () => {
    loadShopCampaignsSource.mockResolvedValue("measured");
    loadDashboard.mockResolvedValue(
      dashboard({
        capabilities: { customers: true },
        analytics: {
          period: { netRevenueCents: 125_000 },
          channels: [
            channel({
              channel: "SHOP_CAMPAIGNS",
              spendCents: 12_500,
              orders: 0,
              platformRevenueCents: 52_000,
              platformConversions: 9,
              platformRoas: 4.16,
            }),
          ],
          campaigns: [],
        },
      }),
    );

    const html = await render();

    expect(html).toContain("Measured by Shopify");
    expect(html).toContain("Shopify-Reported Sales");
    expect(html).toContain("Shopify-Reported Customers");
    expect(html).toContain("not Meridian new-customer count");
    expect(html).toContain("cannot double-count an order already attributed");
    expect(html).toContain("does not combine that aggregate spend with order-derived CAC");
    expect(html).not.toContain("Blended CAC");
  });

  it("shows approval and completed-zero states distinctly", async () => {
    loadShopCampaignsSource.mockResolvedValueOnce("needs_approval");
    const blocked = await render();
    expect(blocked).toContain("Shopify approval needed");
    expect(blocked).toContain("Shop Campaign spend is unavailable");

    loadShopCampaignsSource.mockResolvedValueOnce("zero");
    loadDashboard.mockResolvedValue(
      dashboard({
        analytics: {
          period: { netRevenueCents: 125_000 },
          channels: [
            channel({
              channel: "SHOP_CAMPAIGNS",
              platformRevenueCents: 0,
              platformConversions: 0,
            }),
          ],
          campaigns: [],
        },
      }),
    );
    const zero = await render();
    expect(zero).toContain("Measured zero");
    expect(zero).toContain("$0");
  });
});
