import { describe, expect, it } from "vitest";

import {
  nextWeeklyOccurrence,
  renderAnomalyAlert,
  renderWeeklySummary,
} from "./merchant-notifications.server";

describe("merchant notifications", () => {
  it("finds the next requested weekday without returning the past", () => {
    const mondayNoon = new Date("2026-08-10T12:00:00.000Z");
    expect(nextWeeklyOccurrence(1, mondayNoon).toISOString()).toBe(
      "2026-08-10T13:00:00.000Z",
    );
    expect(
      nextWeeklyOccurrence(1, new Date("2026-08-10T14:00:00.000Z")).toISOString(),
    ).toBe("2026-08-17T13:00:00.000Z");
  });

  it("renders qualified weekly figures and missing-cost disclosure", () => {
    const rendered = renderWeeklySummary({
      shopName: "A & B",
      currency: "USD",
      periodStart: "2026-08-03T00:00:00.000Z",
      periodEnd: "2026-08-10T00:00:00.000Z",
      current: { orders: 12, revenue: 1000, contribution: 400, netProfit: 250, refunds: 20, shippingCost: 80 },
      previous: { orders: 10, revenue: 800, contribution: 300, netProfit: 200, refunds: 10, shippingCost: 70 },
      missingCostLines: 3,
    });
    expect(rendered.text).toContain("Net profit: $250 (+25.0%)");
    expect(rendered.text).toContain("3 sold line item(s)");
    expect(rendered.html).toContain("A &amp; B");
  });

  it("escapes anomaly findings in HTML", () => {
    const rendered = renderAnomalyAlert({
      shopName: "Store <One>",
      currency: "USD",
      detectedAt: "2026-08-11T00:00:00.000Z",
      findings: ["Margin < 5% & falling"],
    });
    expect(rendered.html).toContain("Store &lt;One&gt;");
    expect(rendered.html).toContain("Margin &lt; 5% &amp; falling");
  });
});
