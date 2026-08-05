/**
 * Money primitives for the profit engine.
 *
 * Everything here is integer arithmetic. Floating point dollars accumulate
 * error across tens of thousands of line items, and a profit dashboard that is
 * off by $40 is worse than no dashboard — the merchant stops believing it and
 * goes back to a spreadsheet.
 *
 * Two scales are used:
 *   Cents  — 1e2, for prices, revenue, fees, anything a merchant sees.
 *   Micros — 1e4, for unit costs, which Shopify stores at 4dp. Multiplying a
 *            4dp cost by quantity and rounding once at the end is materially
 *            more accurate than rounding the cost to cents first.
 */

export type Cents = number;
export type Micros = number;

/** Anything Prisma or JSON hands us for a Decimal column. */
export type MoneyInput = string | number | null | undefined | { toString(): string };

function parseScaled(value: MoneyInput, scale: 2 | 4): number {
  if (value === null || value === undefined) return 0;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 10 ** scale);
  }

  const raw = String(value).trim();
  if (raw === "" || raw === "NaN") return 0;

  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;

  const [intPart = "0", fracRaw = ""] = body.split(".");
  // One digit beyond the target scale is enough to round half-up correctly.
  const frac = (fracRaw + "0".repeat(scale + 1)).slice(0, scale + 1);

  const whole = Number(intPart) * 10 ** scale;
  const kept = Number(frac.slice(0, scale));
  const next = Number(frac[scale] ?? "0");

  let scaled = whole + kept + (next >= 5 ? 1 : 0);
  if (!Number.isFinite(scaled)) return 0;
  if (negative) scaled = -scaled;

  return scaled;
}

export function toCents(value: MoneyInput): Cents {
  return parseScaled(value, 2);
}

export function toMicros(value: MoneyInput): Micros {
  return parseScaled(value, 4);
}

/** Unit cost (4dp) × quantity, rounded to cents exactly once. */
export function costOfUnits(unitCostMicros: Micros, quantity: number): Cents {
  return roundHalfAwayFromZero((unitCostMicros * quantity) / 100);
}

export function centsToDollars(cents: Cents): number {
  return cents / 100;
}

function roundHalfAwayFromZero(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** Apply a percentage rate (e.g. 0.029) to a cents amount. */
export function applyRate(cents: Cents, rate: number): Cents {
  if (!Number.isFinite(rate) || rate === 0) return 0;
  return roundHalfAwayFromZero(cents * rate);
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Split `total` across `weights` so the parts sum to exactly `total`.
 *
 * Used for amortising fixed monthly overhead across a month's orders. Naive
 * per-order division loses pennies, and those pennies are why a dashboard's
 * order-level profit never quite adds up to its P&L total.
 *
 * Largest-remainder method: floor everything, then hand the leftover pennies to
 * the entries with the biggest truncated fraction.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  const n = weights.length;
  if (n === 0) return [];

  const weightTotal = weights.reduce((a, b) => a + b, 0);

  // No meaningful weights: split as evenly as integers allow.
  if (weightTotal <= 0) {
    const base = Math.trunc(total / n);
    const out = new Array<number>(n).fill(base);
    let remainder = total - base * n;
    const step = remainder >= 0 ? 1 : -1;
    for (let i = 0; remainder !== 0; i = (i + 1) % n) {
      out[i] = (out[i] ?? 0) + step;
      remainder -= step;
    }
    return out;
  }

  const exact = weights.map((w) => (total * w) / weightTotal);
  const floored = exact.map((v) => Math.trunc(v));
  const allocated = floored.reduce((a, b) => a + b, 0);

  let remainder = total - allocated;
  const step = remainder >= 0 ? 1 : -1;

  const order = exact
    .map((value, index) => ({ index, frac: Math.abs(value - Math.trunc(value)) }))
    .sort((a, b) => b.frac - a.frac);

  const out = [...floored];
  for (let i = 0; remainder !== 0 && order.length > 0; i++) {
    const target = order[i % order.length]!.index;
    out[target] = (out[target] ?? 0) + step;
    remainder -= step;
  }

  return out;
}

export function formatMoney(
  cents: Cents,
  currency = "USD",
  options: { compact?: boolean; decimals?: boolean } = {},
): string {
  const { compact = false, decimals = true } = options;
  const value = centsToDollars(cents);

  if (compact && Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  }).format(value);
}

export function formatPercent(ratio: number, decimals = 1): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** Guarded division — returns null rather than Infinity/NaN for empty denominators. */
export function ratio(numerator: number, denominator: number): number | null {
  if (!denominator || !Number.isFinite(denominator)) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}
