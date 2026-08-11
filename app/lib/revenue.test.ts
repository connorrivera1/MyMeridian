import { describe, expect, it } from "vitest";

import { summariseMovement, summariseRevenue } from "./revenue";

const NOW = new Date("2026-08-10T12:00:00.000Z");

const sub = (
  plan: string,
  interval: string,
  status = "active",
  trialEndsAt: Date | null = null,
) => ({ plan, interval, status, trialEndsAt });

describe("summariseRevenue", () => {
  it("computes MRR with annual subscribers amortised, not counted at face value", () => {
    const summary = summariseRevenue(
      [sub("starter", "monthly"), sub("growth", "annual")],
      NOW,
    );

    // 49.00 + 1290/12 = 49.00 + 107.50.
    expect(summary.mrrCents).toBe(4900 + Math.round(129000 / 12));
    expect(summary.arrCents).toBe(summary.mrrCents * 12);
    expect(summary.activeSubscribers).toBe(2);
  });

  it("counts a live trial as a subscriber-to-be, never as revenue", () => {
    const inTrial = sub("scale", "annual", "active", new Date("2026-08-20"));
    const summary = summariseRevenue([inTrial], NOW);

    expect(summary.trialing).toBe(1);
    expect(summary.activeSubscribers).toBe(0);
    // Revenue that has not been charged is a forecast, not a figure.
    expect(summary.mrrCents).toBe(0);
  });

  it("bills an expired trial like any other subscriber", () => {
    const trialOver = sub("starter", "monthly", "active", new Date("2026-08-01"));
    expect(summariseRevenue([trialOver], NOW).mrrCents).toBe(4900);
  });

  it("ignores ended, unknown-plan and none rows", () => {
    const summary = summariseRevenue(
      [
        sub("growth", "monthly", "cancelled"),
        sub("none", "monthly"),
        sub("enterprise", "monthly"),
      ],
      NOW,
    );
    expect(summary.mrrCents).toBe(0);
    expect(summary.activeSubscribers).toBe(0);
  });

  it("splits the per-plan breakdown by interval", () => {
    const summary = summariseRevenue(
      [sub("growth", "monthly"), sub("growth", "annual"), sub("scale", "monthly")],
      NOW,
    );
    expect(summary.byPlan.growth).toEqual({
      monthly: 1,
      annual: 1,
      mrrCents: 12900 + Math.round(129000 / 12),
    });
    expect(summary.byPlan.scale.monthly).toBe(1);
    expect(summary.byPlan.starter).toEqual({ monthly: 0, annual: 0, mrrCents: 0 });
  });
});

describe("summariseMovement", () => {
  const ev = (status: string, daysAgo: number) => ({
    plan: "growth",
    interval: "monthly",
    status,
    occurredAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
  });

  it("counts starts and ends inside the window only", () => {
    const movement = summariseMovement(
      [ev("active", 5), ev("cancelled", 10), ev("active", 45)],
      8,
      30,
      NOW,
    );
    expect(movement.started).toBe(1);
    expect(movement.ended).toBe(1);
  });

  it("reports churn against actives plus the departed, and survives zero", () => {
    expect(summariseMovement([ev("cancelled", 3)], 9, 30, NOW).churnRatePct).toBe(10);
    expect(summariseMovement([], 0, 30, NOW).churnRatePct).toBeNull();
  });
});
