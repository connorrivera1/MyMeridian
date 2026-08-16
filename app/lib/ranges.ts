/**
 * Date-range presets.
 *
 * Kept out of any `.server` module because the range switcher renders on the
 * client — importing these from analytics.server would drag Prisma into the
 * browser bundle.
 */

export type RangePreset = "7d" | "30d" | "90d" | "180d";

export const RANGE_PRESETS: Record<RangePreset, { label: string; days: number }> = {
  "7d": { label: "7 Days", days: 7 },
  "30d": { label: "30 Days", days: 30 },
  "90d": { label: "90 Days", days: 90 },
  "180d": { label: "6 Months", days: 180 },
};

export function parseRangePreset(value: string | null): RangePreset {
  return value && value in RANGE_PRESETS ? (value as RangePreset) : "30d";
}

/**
 * How much price history the elasticity fit uses.
 *
 * Deliberately independent of the selected reporting range: a week of demand
 * cannot identify an elasticity, so the model always looks back this far. It
 * lives here rather than in pricing.server.ts because the pricing screen states
 * it to the merchant, and a route component may not import a server module.
 */
export const PRICING_LOOKBACK_DAYS = 180;
