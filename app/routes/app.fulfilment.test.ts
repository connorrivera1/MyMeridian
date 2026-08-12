import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadDashboard = vi.fn();
const loadCapacityDays = vi.fn();
const planAllows = vi.fn((_plan: unknown, _feature: unknown) => true);

vi.mock("~/lib/route-data.server", () => ({
  loadDashboard: (...args: unknown[]) => loadDashboard(...args),
}));
vi.mock("~/data/queries.server", () => ({
  loadCapacityDays: (...args: unknown[]) => loadCapacityDays(...args),
}));
vi.mock("~/lib/plan.server", () => ({
  planAllows: (plan: unknown, feature: unknown) => planAllows(plan, feature),
  planFor: () => ({ name: "Growth", price: 129 }),
}));

const { FulfilmentView, loader } = await import("./app.fulfilment");

function dashboard(hasData = true) {
  return {
    shop: {
      id: "shop_1",
      fulfillmentSlaDays: 2,
    },
    plan: { planId: "growth", status: "active" },
    analytics: {
      range: {
        from: new Date("2026-07-01T00:00:00.000Z"),
        to: new Date("2026-08-11T23:59:59.999Z"),
      },
      capacity: {
        hasData,
        currentBacklog: 18,
        throughputPerDay: 7.4,
        effectiveCapacityPerDay: 8,
        utilisationPct: 0.925,
        daysToClearBacklog: 2.4,
        demandTrendPct: 0.12,
        throughputStdDev: 1.2,
        alerts: [
          {
            id: "late_1",
            severity: "critical",
            title: "Shipping promise at risk",
            detail: "Backlog is projected beyond the two-day promise.",
            daysUntil: 1,
          },
        ],
        forecast: [
          {
            date: new Date("2026-08-12T00:00:00.000Z"),
            projectedInbound: 10,
            projectedBacklog: 20,
            overCapacity: true,
            projectedShipDelayDays: 2.5,
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  planAllows.mockReturnValue(true);
  loadDashboard.mockResolvedValue(dashboard());
  loadCapacityDays.mockResolvedValue([
    {
      date: new Date("2026-08-11T00:00:00.000Z"),
      backlogEnd: 18,
      ordersFulfilled: 7,
      ordersReceived: 9,
    },
  ]);
});

describe("Fulfilment", () => {
  it("returns the conversion-focused upgrade state before reading capacity history", async () => {
    planAllows.mockReturnValue(false);

    const data = await loader({
      request: new Request("https://example.com/app/fulfilment"),
    } as never);

    expect(data).toEqual({ locked: { name: "Growth", price: 129 } });
    expect(loadCapacityDays).not.toHaveBeenCalled();

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(FulfilmentView, { data }),
      ),
    );
    expect(html).toContain("Fulfilment capacity is part of Growth");
    expect(html).toContain("See plans — Growth is $129/month");
  });

  it("renders an honest empty state until fulfilment history exists", async () => {
    loadDashboard.mockResolvedValue(dashboard(false));
    const data = await loader({
      request: new Request("https://example.com/app/fulfilment"),
    } as never);

    const html = renderToStaticMarkup(
      createElement(FulfilmentView, { data }),
    );

    expect(html).toContain("No fulfilment history yet");
    expect(html).not.toContain("Orders waiting");
  });

  it("renders measured capacity, alerts, and a forecast status", async () => {
    const data = await loader({
      request: new Request("https://example.com/app/fulfilment"),
    } as never);

    expect(loadCapacityDays).toHaveBeenCalledWith("shop_1", {
      from: new Date("2026-06-27T23:59:59.999Z"),
      to: new Date("2026-08-11T23:59:59.999Z"),
    });

    const html = renderToStaticMarkup(
      createElement(FulfilmentView, { data }),
    );

    expect(html).toContain("Orders waiting");
    expect(html).toContain("2.4 days to clear");
    expect(html).toContain("Shipping promise at risk");
    expect(html).toContain("Wed, Aug 12");
    expect(html).toContain("Past promise");
  });
});
