import { describe, expect, it } from "vitest";

import { analyseCapacity, weekdayDemandFactors, type CapacityDayInput } from "./capacity";

const DAY_MS = 86_400_000;

function buildDays(
  count: number,
  fn: (index: number, date: Date) => Partial<CapacityDayInput>,
  startDate = new Date("2026-01-05T00:00:00Z"), // a Monday
): CapacityDayInput[] {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(startDate.getTime() + i * DAY_MS);
    return {
      date,
      ordersReceived: 100,
      ordersFulfilled: 100,
      backlogEnd: 0,
      maxDailyCapacity: 140,
      staffedHours: 40,
      ...fn(i, date),
    };
  });
}

describe("analyseCapacity", () => {
  it("reports no data rather than inventing numbers for a new store", () => {
    const result = analyseCapacity([], { slaDays: 2 });

    expect(result.hasData).toBe(false);
    expect(result.alerts).toHaveLength(0);
    expect(result.daysToClearBacklog).toBeNull();
  });

  it("stays quiet when the warehouse is comfortably keeping up", () => {
    const days = buildDays(60, () => ({
      ordersReceived: 100,
      ordersFulfilled: 100,
      backlogEnd: 20,
      maxDailyCapacity: 200,
    }));

    const result = analyseCapacity(days, { slaDays: 2 });

    expect(result.throughputPerDay).toBeCloseTo(100, 5);
    expect(result.daysToClearBacklog).toBeCloseTo(0.2, 5);
    expect(result.utilisationPct).toBeCloseTo(0.5, 5);
    expect(result.alerts.filter((a) => a.severity === "CRITICAL")).toHaveLength(0);
  });

  it("raises a critical alert when the backlog already breaks the promise", () => {
    const days = buildDays(60, (i) => ({
      ordersReceived: 100,
      ordersFulfilled: 100,
      backlogEnd: i >= 55 ? 500 : 50,
      maxDailyCapacity: 200,
    }));

    const result = analyseCapacity(days, { slaDays: 2 });

    expect(result.currentBacklog).toBe(500);
    expect(result.daysToClearBacklog).toBeCloseTo(5, 5);

    const critical = result.alerts.find((a) => a.id === "backlog-over-sla");
    expect(critical).toBeDefined();
    expect(critical!.severity).toBe("CRITICAL");
    expect(critical!.detail).toContain("500");
  });

  it("warns while there is still room to react, not only once it is too late", () => {
    // Demand steadily above what the team can ship.
    const days = buildDays(60, (i) => ({
      ordersReceived: 150,
      ordersFulfilled: 120,
      backlogEnd: Math.round(i * 2),
      maxDailyCapacity: 120,
    }));

    const result = analyseCapacity(days, { slaDays: 2 });

    const forwardLooking = result.alerts.filter(
      (a) => a.daysUntil !== null && a.daysUntil > 0,
    );

    expect(forwardLooking.length).toBeGreaterThan(0);
    expect(result.forecast).toHaveLength(14);
    // Backlog should be projected to grow, not stay flat.
    expect(result.forecast.at(-1)!.projectedBacklog).toBeGreaterThan(
      result.currentBacklog,
    );
  });

  it("flags sustained high utilisation as having no slack", () => {
    const days = buildDays(60, () => ({
      ordersReceived: 110,
      ordersFulfilled: 110,
      backlogEnd: 30,
      maxDailyCapacity: 120,
    }));

    const result = analyseCapacity(days, { slaDays: 5 });

    expect(result.utilisationPct).toBeCloseTo(110 / 120, 3);
    expect(result.alerts.some((a) => a.id === "utilisation-high")).toBe(true);
  });

  it("trusts demonstrated throughput over a stale stated capacity", () => {
    const days = buildDays(30, () => ({
      ordersFulfilled: 300,
      maxDailyCapacity: 100, // stated ceiling nobody updated
    }));

    const result = analyseCapacity(days, { slaDays: 2 });

    expect(result.effectiveCapacityPerDay).toBe(300);
  });

  it("detects a demand trend against prior weeks", () => {
    const days = buildDays(56, (i) => ({
      ordersReceived: i < 28 ? 100 : 150,
      ordersFulfilled: 140,
      backlogEnd: 10,
      maxDailyCapacity: 200,
    }));

    const result = analyseCapacity(days, { slaDays: 2 });

    expect(result.demandTrendPct).toBeCloseTo(0.5, 2);
  });

  it("orders alerts by severity", () => {
    const days = buildDays(60, () => ({
      ordersReceived: 200,
      ordersFulfilled: 100,
      backlogEnd: 800,
      maxDailyCapacity: 100,
    }));

    const result = analyseCapacity(days, { slaDays: 2 });
    const severities = result.alerts.map((a) => a.severity);

    expect(severities[0]).toBe("CRITICAL");
    expect(severities).toEqual([...severities].sort());
  });
});

describe("weekdayDemandFactors", () => {
  it("returns a flat profile when there is too little history", () => {
    expect(weekdayDemandFactors(buildDays(7, () => ({})))).toEqual(
      new Array(7).fill(1),
    );
  });

  it("learns a Monday spike", () => {
    const days = buildDays(56, (_, date) => ({
      ordersReceived: date.getDay() === 1 ? 200 : 100,
    }));

    const factors = weekdayDemandFactors(days);

    expect(factors[1]).toBeGreaterThan(1.4);
    expect(factors[3]).toBeLessThan(1);
  });
});
