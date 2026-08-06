import { describe, expect, it } from "vitest";

import { bucketWeekly, dailySeries, type DailyPoint } from "./series";
import type { OrderProfit } from "~/engine/types";

/**
 * The daily chart series.
 *
 * `dailySeries` used to build its buckets by adding a fixed 86,400,000ms to
 * `range.from` and reading the *local calendar day* off each stamp. Those two
 * things disagree whenever the shop's zone changes offset inside the window:
 * the stamps drift an hour against the local clock, and once the drift carries
 * one across midnight a real calendar day gets no bucket at all. Orders on that
 * day then hit the `!bucket` branch and vanished from the chart while the
 * headline totals beside it still counted them.
 *
 * The window is bounded by a range preset, so this needed no exotic input to
 * fire — the default 30 days, an `America/New_York` shop, and a dashboard
 * loaded in the hour after local midnight on 2026-03-20 was enough to lose
 * 2026-03-08.
 */

const NY = "America/New_York";

function order(processedAt: string, overrides: Partial<OrderProfit> = {}): OrderProfit {
  return {
    orderId: `order_${processedAt}`,
    orderNumber: 1,
    processedAt: new Date(processedAt),
    customerId: "cust_1",
    channel: "DIRECT",
    campaignId: null,
    isFirstOrder: false,
    grossRevenueCents: 10_000,
    discountCents: 0,
    refundCents: 0,
    netRevenueCents: 10_000,
    cogsCents: 4_000,
    shippingChargedCents: 0,
    shippingCostCents: 0,
    paymentFeeCents: 0,
    pickPackCents: 0,
    adCostCents: 0,
    overheadCents: 0,
    contributionProfitCents: 6_000,
    netProfitCents: 6_000,
    units: 1,
    ...overrides,
  } as OrderProfit;
}

/** Every calendar day the window genuinely spans, walked hour by hour. */
function calendarDaysIn(range: { from: Date; to: Date }, timeZone: string): string[] {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const days = new Set<string>();
  for (let t = range.from.getTime(); t <= range.to.getTime(); t += 3_600_000) {
    days.add(format.format(new Date(t)));
  }
  return [...days].sort();
}

describe("dailySeries covers every calendar day in the window", () => {
  it("keeps the spring-forward day that the fixed-stride walk dropped", () => {
    // 2026-03-20T04:00:00Z is local midnight in New York, and 30 days back
    // reaches over the 2026-03-08 transition. This is the exact anchor that
    // produced a series with no 2026-03-08 bucket.
    const to = new Date("2026-03-20T04:00:00.000Z");
    const from = new Date(to.getTime() - 30 * 86_400_000);

    const keys = dailySeries([], { from, to }, NY).map((p) => p.key);

    expect(keys).toContain("2026-03-08");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("emits exactly the calendar days the window spans, for every hour anchor", () => {
    // Both 2026 transitions, and every hour of day as the window's endpoint —
    // the defect only fired for the anchors that put the stride within an hour
    // of midnight, which is why it survived being looked at.
    for (const day of ["2026-03-20", "2026-11-12"]) {
      for (let hour = 0; hour < 24; hour++) {
        const to = new Date(`${day}T00:00:00.000Z`);
        to.setUTCHours(hour);
        const from = new Date(to.getTime() - 30 * 86_400_000);

        const keys = dailySeries([], { from, to }, NY).map((p) => p.key);

        expect(keys, `${day} @ ${hour}Z`).toEqual(calendarDaysIn({ from, to }, NY));
      }
    }
  });

  it("drops no order placed inside the window", () => {
    const to = new Date("2026-03-20T04:00:00.000Z");
    const from = new Date(to.getTime() - 30 * 86_400_000);

    // Noon local on the day the clocks go forward.
    const onTheTransition = order("2026-03-08T16:00:00.000Z");
    const series = dailySeries([onTheTransition], { from, to }, NY);

    const total = series.reduce((sum, p) => sum + p.netProfitCents, 0);
    expect(total).toBe(6_000);

    const bucket = series.find((p) => p.key === "2026-03-08")!;
    expect(bucket.orders).toBe(1);
    expect(bucket.netProfitCents).toBe(6_000);
  });

  it("buckets an order by the shop's calendar day, not the server's", () => {
    // 03:00Z on the 5th is still the evening of the 4th in New York.
    const late = order("2026-05-05T03:00:00.000Z");
    const series = dailySeries(
      [late],
      { from: new Date("2026-05-01T12:00:00.000Z"), to: new Date("2026-05-10T12:00:00.000Z") },
      NY,
    );

    expect(series.find((p) => p.key === "2026-05-04")!.orders).toBe(1);
    expect(series.find((p) => p.key === "2026-05-05")!.orders).toBe(0);
  });

  it("gives each bucket a date that renders as its own day in the shop's zone", () => {
    const to = new Date("2026-03-20T04:00:00.000Z");
    const from = new Date(to.getTime() - 30 * 86_400_000);

    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: NY,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    for (const point of dailySeries([], { from, to }, NY)) {
      expect(format.format(point.date)).toBe(point.key);
    }
  });

  it("emits quiet days as zeroes rather than skipping them", () => {
    const series = dailySeries(
      [order("2026-05-03T16:00:00.000Z")],
      { from: new Date("2026-05-01T16:00:00.000Z"), to: new Date("2026-05-05T16:00:00.000Z") },
      NY,
    );

    expect(series.map((p) => p.key)).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
      "2026-05-05",
    ]);
    expect(series.map((p) => p.orders)).toEqual([0, 0, 1, 0, 0]);
  });

  it("handles a southern-hemisphere zone, where the transitions are the other way round", () => {
    // Sydney goes back on 2026-04-05 and forward on 2026-10-04.
    const tz = "Australia/Sydney";
    for (const day of ["2026-04-15", "2026-10-14"]) {
      const to = new Date(`${day}T00:00:00.000Z`);
      const from = new Date(to.getTime() - 30 * 86_400_000);

      const keys = dailySeries([], { from, to }, tz).map((p) => p.key);
      expect(keys, day).toEqual(calendarDaysIn({ from, to }, tz));
    }
  });
});

describe("bucketWeekly", () => {
  function series(days: number): DailyPoint[] {
    const from = new Date("2026-05-01T16:00:00.000Z");
    return dailySeries(
      [],
      { from, to: new Date(from.getTime() + (days - 1) * 86_400_000) },
      NY,
    );
  }

  it("leaves a short series alone", () => {
    const daily = series(45);
    expect(daily).toHaveLength(45);
    expect(bucketWeekly(daily)).toHaveLength(45);
  });

  it("collapses a long series into weeks and keeps every day's total", () => {
    const daily = series(70).map((point, i) => ({ ...point, netProfitCents: i + 1, orders: 1 }));
    const weekly = bucketWeekly(daily);

    expect(weekly).toHaveLength(10);
    expect(weekly[0]!.key).toBe(daily[0]!.key);
    expect(weekly.reduce((s, p) => s + p.netProfitCents, 0)).toBe(
      daily.reduce((s, p) => s + p.netProfitCents, 0),
    );
    expect(weekly.reduce((s, p) => s + p.orders, 0)).toBe(70);
  });

  it("does not lose a trailing partial week", () => {
    const daily = series(52).map((point) => ({ ...point, orders: 1 }));
    const weekly = bucketWeekly(daily);

    // 52 days is seven full weeks and three days.
    expect(weekly).toHaveLength(8);
    expect(weekly.at(-1)!.orders).toBe(3);
  });
});
