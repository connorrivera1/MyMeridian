import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadDashboard = vi.fn();
vi.mock("~/lib/route-data.server", () => ({
  loadDashboard: (...args: unknown[]) => loadDashboard(...args),
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
});

describe("Acquisition", () => {
  it("keeps order-derived channel revenue and profit visible with the requested scopes", async () => {
    const html = await render();

    expect(html).toContain("Revenue and profit by channel");
    expect(html).toContain("Net revenue");
    expect(html).toContain("Contribution profit");
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

    expect(html).toContain("Paid acquisition detail");
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
    expect(html).toContain("missing COGS · modeled costs");
    expect(html).toContain("Needs COGS");
    expect(html).not.toContain(">Profitable</span>");
  });
});
