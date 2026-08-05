import { dayKey } from "~/engine/profit";
import type { Cents } from "~/engine/money";
import type { OrderProfit } from "~/engine/types";

/**
 * Bucket order-level results into a continuous daily series.
 *
 * Days with no orders are emitted as zeroes rather than skipped: a gap in a
 * time series reads as "no data", but a quiet Sunday genuinely earned nothing
 * and the chart should show that.
 */
export interface DailyPoint {
  date: Date;
  netRevenueCents: Cents;
  netProfitCents: Cents;
  contributionProfitCents: Cents;
  adCostCents: Cents;
  orders: number;
}

export function dailySeries(
  orders: readonly OrderProfit[],
  range: { from: Date; to: Date },
  timeZone: string,
): DailyPoint[] {
  const byDay = new Map<string, DailyPoint>();

  const dayCount =
    Math.floor((range.to.getTime() - range.from.getTime()) / 86_400_000) + 1;

  for (let i = 0; i < dayCount; i++) {
    const date = new Date(range.from.getTime() + i * 86_400_000);
    byDay.set(dayKey(date, timeZone), {
      date,
      netRevenueCents: 0,
      netProfitCents: 0,
      contributionProfitCents: 0,
      adCostCents: 0,
      orders: 0,
    });
  }

  for (const order of orders) {
    const bucket = byDay.get(dayKey(order.processedAt, timeZone));
    if (!bucket) continue;

    bucket.netRevenueCents += order.netRevenueCents;
    bucket.netProfitCents += order.netProfitCents;
    bucket.contributionProfitCents += order.contributionProfitCents;
    bucket.adCostCents += order.adCostCents;
    bucket.orders += 1;
  }

  return [...byDay.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
}

/** Collapse a long series so a chart shows weeks rather than 180 hairlines. */
export function bucketWeekly(points: readonly DailyPoint[]): DailyPoint[] {
  if (points.length <= 45) return [...points];

  const out: DailyPoint[] = [];
  for (let i = 0; i < points.length; i += 7) {
    const week = points.slice(i, i + 7);
    const first = week[0]!;

    out.push({
      date: first.date,
      netRevenueCents: week.reduce((s, p) => s + p.netRevenueCents, 0),
      netProfitCents: week.reduce((s, p) => s + p.netProfitCents, 0),
      contributionProfitCents: week.reduce(
        (s, p) => s + p.contributionProfitCents,
        0,
      ),
      adCostCents: week.reduce((s, p) => s + p.adCostCents, 0),
      orders: week.reduce((s, p) => s + p.orders, 0),
    });
  }
  return out;
}
