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
  /** The shop-local calendar day, `YYYY-MM-DD`. Buckets are keyed on this. */
  key: string;
  /**
   * Midday of that local day, as an instant.
   *
   * Midday rather than midnight deliberately: consumers format this into a day
   * label, and a midnight instant lands on the wrong side of the date line for
   * any renderer whose zone differs from the shop's by an hour. Midday has
   * twelve hours of slack, and it exists on every calendar day — local midnight
   * does not, in zones that spring forward at 00:00.
   */
  date: Date;
  netRevenueCents: Cents;
  netProfitCents: Cents;
  contributionProfitCents: Cents;
  adCostCents: Cents;
  orders: number;
}

/** A zone's UTC offset, in milliseconds, at a given instant. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // `hour` formats midnight as 24 under hour12:false in some ICU versions.
  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour") % 24,
    field("minute"),
    field("second"),
  );

  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant of midday, shop-local, on the calendar day containing `at`. */
function middayOfLocalDay(at: Date, timeZone: string): Date {
  const [year, month, day] = dayKey(at, timeZone).split("-").map(Number);
  const naiveMidday = Date.UTC(year!, month! - 1, day!, 12);

  // Two passes: the first offset is read at the wrong instant if a transition
  // falls between it and the answer. The second is read within hours of the
  // target, which no transition rule separates from it.
  const first = naiveMidday - offsetMs(new Date(naiveMidday), timeZone);
  return new Date(naiveMidday - offsetMs(new Date(first), timeZone));
}

export function dailySeries(
  orders: readonly OrderProfit[],
  range: { from: Date; to: Date },
  timeZone: string,
): DailyPoint[] {
  const byDay = new Map<string, DailyPoint>();

  // The window is walked one *calendar* day at a time, not in fixed 24-hour
  // strides from `range.from`.
  //
  // A stride skips or repeats a day whenever the shop's zone changes offset
  // inside the window, because the stamps drift an hour against the local clock
  // and the drift eventually carries one across midnight. Measured on
  // `America/New_York` with the 30-day default: a dashboard loaded in the hour
  // after local midnight on 2026-03-20 produced a series with no bucket for
  // 2026-03-08 at all — every order placed on the day the clocks went forward
  // hit the `!bucket` branch below and was dropped from the chart, while the
  // headline totals beside it still counted them. The chart and the KPI row
  // disagreed by a day's trade, once a year, silently.
  //
  // Anchoring each step on local midday makes the stride immune: a transition
  // moves the stamp by an hour or two and midday has twelve hours of slack, so
  // adding 24 hours always lands on the next calendar day.
  const endKey = dayKey(range.to, timeZone);
  let cursor = middayOfLocalDay(range.from, timeZone);

  // The window is bounded by a range preset (180 days at most), and the guard is
  // a backstop against a zone that could somehow stall the walk.
  for (let i = 0; i < 1000; i++) {
    const key = dayKey(cursor, timeZone);
    if (key > endKey) break;

    byDay.set(key, {
      key,
      date: cursor,
      netRevenueCents: 0,
      netProfitCents: 0,
      contributionProfitCents: 0,
      adCostCents: 0,
      orders: 0,
    });

    cursor = middayOfLocalDay(new Date(cursor.getTime() + 86_400_000), timeZone);
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

  return [...byDay.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Collapse a long series so a chart shows weeks rather than 180 hairlines. */
export function bucketWeekly(points: readonly DailyPoint[]): DailyPoint[] {
  if (points.length <= 45) return [...points];

  const out: DailyPoint[] = [];
  for (let i = 0; i < points.length; i += 7) {
    const week = points.slice(i, i + 7);
    const first = week[0]!;

    out.push({
      key: first.key,
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
