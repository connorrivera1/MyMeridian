import { Prisma } from "@prisma/client";

import prisma from "~/db.server";

/**
 * Daily FX rates for foreign-currency *costs* — ad accounts billing in a
 * different currency than the store, carrier invoices in the carrier's home
 * currency. Order money never comes through here: multi-currency orders
 * convert at the per-order rate Shopify itself settled them at.
 *
 * Rates are cached in `ExchangeRate` because the numbers they produce are
 * financial records: a recompute next month must convert last month's spend at
 * last month's stored rate, not at whatever the API answers next month.
 */

/** Reject conversions rather than silently using a badly stale rate. */
const MAX_STALE_DAYS = 7;

const FX_API_BASE = "https://api.frankfurter.app";
const FETCH_TIMEOUT_MS = 10_000;

export class FxRateUnavailableError extends Error {
  /** Transient by nature: the API may answer on the next attempt. */
  readonly retryable = true;

  constructor(day: string, base: string, quote: string, cause?: unknown) {
    super(
      `No ${base}→${quote} rate for ${day}: not cached and the rate service ` +
        `did not supply one${cause ? ` (${String(cause)})` : ""}.`,
    );
    this.name = "FxRateUnavailableError";
  }
}

/** Calendar day in UTC, matching how `ExchangeRate.day` is stored. */
export function fxDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayDistance(from: Date, to: Date): number {
  return Math.abs(to.getTime() - from.getTime()) / 86_400_000;
}

type Fetcher = typeof fetch;

async function fetchRateFromApi(
  day: string,
  base: string,
  quote: string,
  fetcher: Fetcher,
): Promise<number | null> {
  if (process.env.MERIDIAN_FX_DISABLED === "true") return null;

  let response: Response;
  try {
    response = await fetcher(`${FX_API_BASE}/${day}?from=${base}&to=${quote}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  try {
    const body = (await response.json()) as {
      rates?: Record<string, number>;
    };
    const rate = body.rates?.[quote];
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0
      ? rate
      : null;
  } catch {
    return null;
  }
}

/**
 * 1 unit of `base` = returned units of `quote`, for the given day.
 *
 * Resolution order: exact cached day, then the nearest cached rate within
 * `MAX_STALE_DAYS` (markets close on weekends; Friday's rate *is* Saturday's
 * rate), then one API fetch which is cached on success. Anything else throws
 * `FxRateUnavailableError` — writing spend converted at a guessed rate would
 * corrupt profit quietly, which is worse than a visible retry.
 */
export async function fxRate(
  day: Date,
  baseCurrency: string,
  quoteCurrency: string,
  fetcher: Fetcher = fetch,
): Promise<number> {
  const base = baseCurrency.toUpperCase();
  const quote = quoteCurrency.toUpperCase();
  if (base === quote) return 1;

  const dayKey = fxDayKey(day);
  const dayDate = new Date(`${dayKey}T00:00:00.000Z`);

  const exact = await prisma.exchangeRate.findUnique({
    where: { day_base_quote: { day: dayDate, base, quote } },
  });
  if (exact) return Number(exact.rate);

  const nearest = await prisma.exchangeRate.findFirst({
    where: { base, quote, day: { lte: dayDate } },
    orderBy: { day: "desc" },
  });
  if (nearest && dayDistance(nearest.day, dayDate) <= MAX_STALE_DAYS) {
    return Number(nearest.rate);
  }

  const fetched = await fetchRateFromApi(dayKey, base, quote, fetcher);
  if (fetched === null) {
    throw new FxRateUnavailableError(dayKey, base, quote);
  }

  await prisma.exchangeRate.upsert({
    where: { day_base_quote: { day: dayDate, base, quote } },
    create: {
      day: dayDate,
      base,
      quote,
      rate: new Prisma.Decimal(fetched.toFixed(10)),
    },
    // Someone else fetched concurrently; either value came from the same API.
    update: {},
  });

  return fetched;
}

/** Convert integer cents between currencies, rounding once at the end. */
export function convertCents(amountCents: number, rate: number): number {
  return Math.round(amountCents * rate);
}
