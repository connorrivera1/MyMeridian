/**
 * Date-range presets.
 *
 * Kept out of any `.server` module because the range switcher renders on the
 * client — importing these from analytics.server would drag Prisma into the
 * browser bundle.
 */

export type RangePreset = "7d" | "30d" | "90d" | "180d";

export const RANGE_PRESETS: Record<RangePreset, { label: string; days: number }> = {
  "7d": { label: "7 days", days: 7 },
  "30d": { label: "30 days", days: 30 },
  "90d": { label: "90 days", days: 90 },
  "180d": { label: "6 months", days: 180 },
};

export function parseRangePreset(value: string | null): RangePreset {
  return value && value in RANGE_PRESETS ? (value as RangePreset) : "30d";
}
