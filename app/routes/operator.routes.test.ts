import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

let loaderData: unknown;
let actionData: unknown = undefined;

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Form: (props: React.FormHTMLAttributes<HTMLFormElement>) =>
    createElement("form", props),
  useLoaderData: () => loaderData,
  useActionData: () => actionData,
}));
vi.mock("~/db.server", () => ({ default: {} }));

const operatorLogin = await import("./operator.login");
const operatorOverview = await import("./operator.index");
const operatorStore = await import("./operator.stores.$shopId");

function render(component: React.ComponentType) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(component),
    ),
  );
}

describe("operator route UI", () => {
  it("requires all three authentication factors on the isolated login page", () => {
    loaderData = { configured: true };
    actionData = undefined;
    const html = render(operatorLogin.default);
    expect(html).toContain("Meridian Operator Access");
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('name="totp"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain("Merchant Shopify and MyMeridian sessions are never accepted");
  });

  it("renders the complete business, lifecycle, reliability and support surface", () => {
    loaderData = {
      search: "",
      overview: {
        generatedAt: new Date("2026-08-11T20:00:00Z"),
        revenue: {
          activePayingStores: 12,
          trials: 3,
          mrrCents: 129_900,
          arrCents: 1_558_800,
          planDistribution: { starter: 6, growth: 4, scale: 2 },
          completedTrials: 10,
          convertedTrials: 7,
          trialConversionRate: 0.7,
        },
        lifecycle: {
          installTotal: 20,
          installs30d: 8,
          uninstallTotal: 2,
          uninstalls30d: 1,
          churnedStores30d: 1,
          churnRate30d: 1 / 13,
        },
        waitlist: {
          total: 42,
          signups30d: 13,
          storeUrlCoverage: 0.5,
          foundingEligible: 40,
          daily: [{ day: "2026-08-11", signups: 3 }],
          sources: [{ source: "youtube", signups: 7 }],
        },
        connectors: [
          { provider: "GOOGLE_ADS", connectedStores: 4, adoptionRate: 1 / 3 },
        ],
        failures: {
          failedImports: 1,
          webhookFailures: 2,
          recalcFailures: 3,
          notificationFailures: 4,
          adSyncFailures: 5,
        },
        system: {
          status: "degraded",
          database: "reachable",
          databaseLatencyMs: 4,
          webhookBacklog: 2,
          recalcBacklog: 3,
          notificationBacklog: 4,
          adSyncBacklog: 5,
        },
        alerts: [
          {
            id: "webhook:1",
            kind: "webhook",
            severity: "critical",
            shopId: "shop_1",
            shopDomain: "example.myshopify.com",
            summary: "Webhook processing failed after 2 attempts",
            occurredAt: new Date("2026-08-11T19:00:00Z"),
          },
        ],
      },
      stores: [
        {
          id: "shop_1",
          domain: "example.myshopify.com",
          installedAt: new Date("2026-08-01"),
          uninstalledAt: null,
          lastSyncedAt: new Date("2026-08-11"),
          syncStatus: "COMPLETE",
          subscription: { plan: "growth", status: "active", trialEndsAt: null },
        },
      ],
    };
    const html = render(operatorOverview.default);
    for (const label of [
      "Active Paying Stores",
      "Active Trials",
      "MRR",
      "ARR",
      "Trial Conversion",
      "30-Day Churn",
      "All Installs",
      "All Uninstalls",
      "Pre-Launch Waitlist",
      "Founding Merchant Eligible",
      "Failed Imports",
      "Webhook Failures",
      "Background-Job Failures",
      "Connector Adoption",
      "Recent Operational Alerts",
      "Store Support",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("example.myshopify.com");
    expect(html).toContain("Google Ads");
  });

  it("renders store support status without leaking selected private values", () => {
    const privateMarker = "SHOULD-NOT-RENDER";
    loaderData = {
      store: {
        id: "shop_1",
        domain: "example.myshopify.com",
        installedAt: new Date("2026-08-01"),
        uninstalledAt: null,
        lastSyncedAt: new Date("2026-08-11"),
        lastComputedAt: new Date("2026-08-11"),
        syncStatus: "COMPLETE",
        syncStartedAt: new Date("2026-08-11"),
        syncCompletedAt: new Date("2026-08-11"),
        syncStage: "complete",
        syncedOrders: 100,
        syncedProducts: 20,
        hasAllOrdersScope: true,
        earliestOrderAt: new Date("2025-01-01"),
        grantedScopes: "read_orders,read_products",
        subscription: {
          plan: "growth",
          interval: "annual",
          status: "active",
          trialEndsAt: null,
          currentPeriodEnd: new Date("2027-08-01"),
          createdAt: new Date("2026-08-01"),
          updatedAt: new Date("2026-08-11"),
        },
        connectors: [
          {
            provider: "GOOGLE_ADS",
            status: "CONNECTED",
            healthStatus: "HEALTHY",
            lastSyncedAt: new Date("2026-08-11"),
            lastHealthCheckedAt: new Date("2026-08-11"),
            lastHealthyAt: new Date("2026-08-11"),
            consecutiveFailures: 0,
          },
        ],
        dataCompleteness: {
          status: "complete",
          historyCoverage: "all_orders",
          totalOrders: 100,
          computedOrders: 100,
          missingCogsOrders: 0,
          totalVariants: 20,
          missingCostVariants: 0,
        },
        jobHealth: {
          failedWebhooks: 0,
          pendingWebhooks: 0,
          failedRecalcJobs: 0,
          pendingRecalcJobs: 0,
          failedNotifications: 0,
          pendingNotifications: 0,
          failedAdSyncWindows: 0,
          pendingAdSyncWindows: 0,
        },
      },
      privateMarker,
    };
    const html = render(operatorStore.default);
    expect(html).toContain("PII-Minimized Support View");
    expect(html).toContain("This view is read-only");
    expect(html).toContain("Granted Shopify Scopes");
    expect(html).toContain("Connector Status");
    expect(html).toContain("Job Health");
    expect(html).toContain("Data Completeness");
    expect(html).not.toContain(privateMarker);
  });
});
