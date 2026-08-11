import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadDashboard = vi.fn();
vi.mock("~/lib/route-data.server", () => ({
  loadDashboard: (...args: unknown[]) => loadDashboard(...args),
  change: (current: number, prior: number) =>
    prior === 0 ? null : (current - prior) / Math.abs(prior),
}));

vi.mock("~/lib/plan.server", () => ({
  planAllows: () => false,
}));

const { OverviewView, loader } = await import("./app.overview");

function period(overrides: Record<string, unknown> = {}) {
  return {
    orders: [],
    orderCount: 10,
    units: 12,
    grossRevenueCents: 120_000,
    discountCents: 0,
    refundCents: 0,
    shippingRevenueCents: 0,
    netRevenueCents: 120_000,
    cogsCents: 40_000,
    shippingCostCents: 10_000,
    paymentFeeCents: 3_000,
    pickPackCents: 2_000,
    attributedAdCostCents: 0,
    unattributedAdCostCents: 0,
    totalAdCostCents: 0,
    overheadCents: 5_000,
    contributionProfitCents: 65_000,
    netProfitCents: 60_000,
    contributionMarginPct: 0.5417,
    netMarginPct: 0.5,
    averageOrderValueCents: 12_000,
    profitPerOrderCents: 6_000,
    ...overrides,
  };
}

function dashboard(
  overrides: {
    isDemo?: boolean;
    adCostCents?: number;
    adSpendCoverage?: {
      mode: "connected" | "unavailable";
      syncedSourceCount: number;
    };
    products?: Array<{
      productId: string;
      title: string;
      contributionProfitCents: number;
      marginPct: number | null;
      units: number;
      classification: string;
      hasMissingCogs: boolean;
    }>;
  } = {},
) {
  const adCostCents = overrides.adCostCents ?? 0;
  const current = period({
    attributedAdCostCents: adCostCents,
    totalAdCostCents: adCostCents,
    contributionProfitCents: 65_000 - adCostCents,
    netProfitCents: 60_000 - adCostCents,
  });

  return {
    shop: {
      id: "shop_1",
      name: "Example Goods",
      currency: "USD",
      timezone: "UTC",
    },
    isDemo: overrides.isDemo ?? false,
    analytics: {
      range: {
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-02T23:59:59Z"),
      },
      period: current,
      products: overrides.products ?? [],
      channels: [],
      capacity: { alerts: [] },
    },
    previous: { period: period() },
    adSpendCoverage: overrides.adSpendCoverage ?? {
      mode: "unavailable" as const,
      syncedSourceCount: 0,
    },
    rangeLabel: "30 days",
    preset: "30d",
    capabilities: { inventoryCost: true },
    plan: {
      planId: "starter",
      status: "active",
      trialEndsAt: null,
      isDemo: overrides.isDemo ?? false,
    },
  };
}

async function renderOverview() {
  const data = await loader({
    request: new Request("https://example.com/app?range=30d"),
  } as never);

  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(OverviewView, { data })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  loadDashboard.mockResolvedValue(dashboard());
});

describe("Overview ad-spend honesty", () => {
  it("uses the coverage supplied by the shared dashboard loader", async () => {
    const result = await loader({
      request: new Request("https://example.com/app?range=30d"),
    } as never);

    expect(result.adSpendCoverage).toEqual({
      mode: "unavailable",
      syncedSourceCount: 0,
    });
    expect(result.timezone).toBe("UTC");
  });

  it("qualifies live-store profit and renders unavailable ad spend as a dash", async () => {
    const html = await renderOverview();

    expect(html).toContain("Paid-marketing spend is not measured");
    expect(html).toContain("profit before paid marketing");
    expect(html).toContain(
      "Ad spend is shown as a dash rather than a false zero",
    );
    expect(html).toMatch(
      /tile-label">Ad spend<\/span><\/div><div class="tile-value">—<\/div>/,
    );
    expect(html).not.toContain("net profit kept");
    expect(html).toContain(
      "New-customer counts, CAC, lifetime value and payback are unavailable",
    );
    expect(html).not.toContain("A channel is judged on the customers");
  });

  it("keeps the warning when a live source is synced and labels spend as recorded", async () => {
    loadDashboard.mockResolvedValue(
      dashboard({
        adCostCents: 5_000,
        adSpendCoverage: { mode: "connected", syncedSourceCount: 1 },
      }),
    );

    const html = await renderOverview();

    expect(html).toContain("Unconnected paid-marketing spend is excluded");
    expect(html).toContain("1 paid marketing source has completed a sync");
    expect(html).toContain("profit after available costs");
    expect(html).toContain("Recorded ad spend");
    expect(html).toContain("$50");
  });

  it("detects partial missing COGS and says review does not make models measured", async () => {
    loadDashboard.mockResolvedValue(
      dashboard({
        adSpendCoverage: { mode: "connected", syncedSourceCount: 1 },
      }),
    );
    const current = period({
      orderCount: 2,
      orders: [
        {
          hasMissingCogs: true,
          usesModeledCosts: true,
          usesEstimatedCosts: true,
        },
        {
          hasMissingCogs: false,
          usesModeledCosts: true,
          usesEstimatedCosts: true,
        },
      ],
    });
    loadDashboard.mockResolvedValue({
      ...dashboard({
        adSpendCoverage: { mode: "connected", syncedSourceCount: 1 },
      }),
      analytics: {
        ...dashboard().analytics,
        period: current,
      },
    });

    const html = await renderOverview();

    expect(html).toContain("1 of 2 order is missing at least one COGS input");
    expect(html).toContain("Review does not turn a model into measured");
    expect(html).toContain("remain marked amber");
  });

  it("withholds carrying and losing verdicts from products with missing COGS", async () => {
    loadDashboard.mockResolvedValue(
      dashboard({
        products: [
          {
            productId: "missing",
            title: "Unknown-cost item",
            contributionProfitCents: 50_000,
            marginPct: 0.9,
            units: 4,
            classification: "PROFITABLE",
            hasMissingCogs: true,
          },
          {
            productId: "known",
            title: "Known-cost item",
            contributionProfitCents: 10_000,
            marginPct: 0.25,
            units: 2,
            classification: "PROFITABLE",
            hasMissingCogs: false,
          },
        ],
      }),
    );

    const result = await loader({
      request: new Request("https://example.com/app?range=30d"),
    } as never);

    expect(result.winners.map((product) => product.productId)).toEqual([
      "known",
    ]);
    expect(result.losers).toEqual([]);
  });
});
