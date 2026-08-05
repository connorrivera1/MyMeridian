/**
 * Fulfilment capacity.
 *
 * The point of this screen is to warn the merchant *before* the warehouse falls
 * behind, so everything here is built on observed throughput rather than a
 * capacity number someone typed in during onboarding and never revisited.
 */

export type AlertSeverity = "CRITICAL" | "WARNING" | "INFO";

export interface CapacityDayInput {
  date: Date;
  ordersReceived: number;
  ordersFulfilled: number;
  backlogEnd: number;
  maxDailyCapacity: number;
  staffedHours: number;
}

export interface CapacityAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** Days from today until this becomes a problem. Null if already one. */
  daysUntil: number | null;
}

export interface ForecastDay {
  date: Date;
  projectedInbound: number;
  projectedFulfilled: number;
  projectedBacklog: number;
  projectedShipDelayDays: number;
  overCapacity: boolean;
}

export interface CapacityAnalysis {
  currentBacklog: number;
  throughputPerDay: number;
  throughputStdDev: number;
  effectiveCapacityPerDay: number;
  utilisationPct: number | null;
  daysToClearBacklog: number | null;
  /** Average days between an order arriving and shipping, at current pace. */
  currentShipDelayDays: number | null;
  demandTrendPct: number | null;
  weekdayFactors: number[];
  forecast: ForecastDay[];
  alerts: CapacityAlert[];
  hasData: boolean;
}

const TRAILING_WINDOW = 14;
const TREND_WINDOW = 28;
const FORECAST_DAYS = 14;
const DAY_MS = 86_400_000;

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Multiplicative day-of-week factors for inbound demand.
 *
 * Ecommerce demand is strongly weekly — a flat daily average will happily
 * predict a quiet Sunday and miss the Monday spike that actually breaks the
 * warehouse.
 */
export function weekdayDemandFactors(days: readonly CapacityDayInput[]): number[] {
  const factors = new Array(7).fill(1);
  if (days.length < 14) return factors;

  const overall = mean(days.map((d) => d.ordersReceived));
  if (overall <= 0) return factors;

  for (let weekday = 0; weekday < 7; weekday++) {
    const matching = days.filter((d) => d.date.getDay() === weekday);
    if (matching.length === 0) continue;
    factors[weekday] = mean(matching.map((d) => d.ordersReceived)) / overall;
  }

  return factors;
}

export function analyseCapacity(
  input: readonly CapacityDayInput[],
  options: { slaDays: number; today?: Date },
): CapacityAnalysis {
  const days = [...input].sort((a, b) => a.date.getTime() - b.date.getTime());

  if (days.length === 0) {
    return {
      currentBacklog: 0,
      throughputPerDay: 0,
      throughputStdDev: 0,
      effectiveCapacityPerDay: 0,
      utilisationPct: null,
      daysToClearBacklog: null,
      currentShipDelayDays: null,
      demandTrendPct: null,
      weekdayFactors: new Array(7).fill(1),
      forecast: [],
      alerts: [],
      hasData: false,
    };
  }

  const latest = days[days.length - 1]!;
  const today = options.today ?? latest.date;

  const trailing = days.slice(-TRAILING_WINDOW);
  const throughputPerDay = mean(trailing.map((d) => d.ordersFulfilled));
  const throughputStdDev = stdDev(trailing.map((d) => d.ordersFulfilled));

  const statedCapacity = mean(trailing.map((d) => d.maxDailyCapacity));
  // Trust whichever is larger: the stated ceiling, or what the team has
  // actually demonstrated it can ship. Stated capacity is often stale.
  const observedPeak = Math.max(...trailing.map((d) => d.ordersFulfilled));
  const effectiveCapacityPerDay = Math.max(statedCapacity, observedPeak);

  const currentBacklog = latest.backlogEnd;
  const daysToClearBacklog =
    throughputPerDay > 0 ? currentBacklog / throughputPerDay : null;

  const recentDemand = mean(
    days.slice(-TREND_WINDOW).map((d) => d.ordersReceived),
  );
  const priorDemand = mean(
    days.slice(-TREND_WINDOW * 2, -TREND_WINDOW).map((d) => d.ordersReceived),
  );
  const demandTrendPct =
    priorDemand > 0 ? recentDemand / priorDemand - 1 : null;

  const weekdayFactors = weekdayDemandFactors(days);

  // --- forward simulation -------------------------------------------------
  const forecast: ForecastDay[] = [];
  let backlog = currentBacklog;

  const dailyTrend = demandTrendPct !== null ? demandTrendPct / TREND_WINDOW : 0;

  for (let i = 1; i <= FORECAST_DAYS; i++) {
    const date = new Date(today.getTime() + i * DAY_MS);
    const factor = weekdayFactors[date.getDay()] ?? 1;

    const projectedInbound = Math.max(
      0,
      Math.round(recentDemand * factor * (1 + dailyTrend * i)),
    );

    const available = backlog + projectedInbound;
    const projectedFulfilled = Math.min(
      available,
      Math.round(effectiveCapacityPerDay),
    );

    backlog = available - projectedFulfilled;

    forecast.push({
      date,
      projectedInbound,
      projectedFulfilled,
      projectedBacklog: backlog,
      projectedShipDelayDays:
        projectedFulfilled > 0
          ? Number((backlog / projectedFulfilled).toFixed(2))
          : backlog > 0
            ? Infinity
            : 0,
      overCapacity: available > effectiveCapacityPerDay,
    });
  }

  const alerts = buildAlerts({
    slaDays: options.slaDays,
    currentBacklog,
    daysToClearBacklog,
    throughputPerDay,
    effectiveCapacityPerDay,
    demandTrendPct,
    forecast,
    trailing,
  });

  return {
    currentBacklog,
    throughputPerDay,
    throughputStdDev,
    effectiveCapacityPerDay,
    utilisationPct:
      effectiveCapacityPerDay > 0
        ? throughputPerDay / effectiveCapacityPerDay
        : null,
    daysToClearBacklog,
    currentShipDelayDays: daysToClearBacklog,
    demandTrendPct,
    weekdayFactors,
    forecast,
    alerts,
    hasData: true,
  };
}

function buildAlerts(args: {
  slaDays: number;
  currentBacklog: number;
  daysToClearBacklog: number | null;
  throughputPerDay: number;
  effectiveCapacityPerDay: number;
  demandTrendPct: number | null;
  forecast: readonly ForecastDay[];
  trailing: readonly CapacityDayInput[];
}): CapacityAlert[] {
  const alerts: CapacityAlert[] = [];

  // Already behind SLA.
  if (args.daysToClearBacklog !== null && args.daysToClearBacklog > args.slaDays) {
    alerts.push({
      id: "backlog-over-sla",
      severity: "CRITICAL",
      title: "Backlog exceeds your shipping promise",
      detail:
        `${args.currentBacklog.toLocaleString()} orders are waiting and the team ` +
        `is clearing ${Math.round(args.throughputPerDay).toLocaleString()} a day. ` +
        `That is ${args.daysToClearBacklog.toFixed(1)} days to clear against a ` +
        `${args.slaDays}-day promise. Orders placed today will ship late.`,
      daysUntil: null,
    });
  }

  // Projected to breach SLA within the forecast window.
  const breachDay = args.forecast.findIndex(
    (d) => d.projectedShipDelayDays > args.slaDays,
  );
  if (
    breachDay >= 0 &&
    !(args.daysToClearBacklog !== null && args.daysToClearBacklog > args.slaDays)
  ) {
    const day = args.forecast[breachDay]!;
    alerts.push({
      id: "sla-breach-projected",
      severity: "WARNING",
      title: "Projected to miss shipping promise",
      detail:
        `At the current pace, backlog reaches ${day.projectedBacklog.toLocaleString()} ` +
        `orders by ${day.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ` +
        `pushing ship time past ${args.slaDays} days. Adding capacity now costs ` +
        `less than the refunds and support tickets from shipping late.`,
      daysUntil: breachDay + 1,
    });
  }

  // Days where inbound alone exceeds what the warehouse can physically do.
  const overCapacityDays = args.forecast.filter((d) => d.overCapacity);
  if (overCapacityDays.length > 0) {
    const first = overCapacityDays[0]!;
    const index = args.forecast.indexOf(first);
    alerts.push({
      id: "capacity-exceeded",
      severity: overCapacityDays.length >= 5 ? "CRITICAL" : "WARNING",
      title: `${overCapacityDays.length} of the next 14 days exceed capacity`,
      detail:
        `Peak demand reaches ${Math.max(
          ...overCapacityDays.map((d) => d.projectedInbound),
        ).toLocaleString()} orders against a ceiling of ` +
        `${Math.round(args.effectiveCapacityPerDay).toLocaleString()} a day. ` +
        `The overflow rolls into the following day rather than disappearing.`,
      daysUntil: index >= 0 ? index + 1 : null,
    });
  }

  // Sustained high utilisation leaves no room to absorb a spike.
  const utilisation =
    args.effectiveCapacityPerDay > 0
      ? args.throughputPerDay / args.effectiveCapacityPerDay
      : 0;
  if (utilisation >= 0.85 && utilisation < 1) {
    alerts.push({
      id: "utilisation-high",
      severity: "WARNING",
      title: "Running at " + Math.round(utilisation * 100) + "% of capacity",
      detail:
        `There is almost no slack left. A promotion, a sick day or a carrier ` +
        `delay will turn straight into a backlog — there is no headroom to ` +
        `absorb it.`,
      daysUntil: null,
    });
  }

  // Demand growing faster than the warehouse can follow.
  if (args.demandTrendPct !== null && args.demandTrendPct > 0.2 && utilisation >= 0.7) {
    alerts.push({
      id: "demand-outpacing-capacity",
      severity: "INFO",
      title: `Demand up ${Math.round(args.demandTrendPct * 100)}% and capacity is tightening`,
      detail:
        `Order volume is growing faster than throughput. At this rate the ` +
        `warehouse becomes the constraint on growth before the ad account does.`,
      daysUntil: null,
    });
  }

  const severityRank: Record<AlertSeverity, number> = {
    CRITICAL: 0,
    WARNING: 1,
    INFO: 2,
  };
  return alerts.sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity],
  );
}
