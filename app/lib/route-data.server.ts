import {
  loadShopAnalytics,
  resolveRange,
  type ShopAnalytics,
} from "~/data/analytics.server";
import type { DateRange } from "~/data/queries.server";
import { ratio } from "~/engine/money";
import { requireShopContext } from "~/lib/auth.server";
import { resolvePlan } from "~/lib/plan.server";
import { parseRangePreset, RANGE_PRESETS } from "~/lib/ranges";
import { capabilitiesForShop } from "~/lib/scopes";

/**
 * Everything a dashboard route needs, including the preceding window of the
 * same length.
 *
 * A profit figure with nothing to compare it against is trivia. Every headline
 * in the product carries a change against the previous equivalent period, so
 * that comparison is loaded once here rather than by each route.
 */
export async function loadDashboard(request: Request) {
  const ctx = await requireShopContext(request);
  const { shop, isDemo } = ctx;

  // Cheap after the layout loader has already run in the same navigation — the
  // stored row is fresh, so this does not make a second Billing API call.
  const plan = await resolvePlan(ctx);

  const preset = parseRangePreset(new URL(request.url).searchParams.get("range"));
  const range = resolveRange(shop, preset, { anchorToData: isDemo });

  const spanMs = range.to.getTime() - range.from.getTime();
  const previousRange: DateRange = {
    from: new Date(range.from.getTime() - spanMs),
    to: new Date(range.from.getTime() - 1),
  };

  const [analytics, previous] = await Promise.all([
    loadShopAnalytics(shop, range),
    loadShopAnalytics(shop, previousRange),
  ]);

  return {
    shop,
    isDemo,
    plan,
    preset,
    rangeLabel: RANGE_PRESETS[preset].label,
    range,
    analytics,
    previous,
    /** What this store actually authorised. Screens branch on it. */
    capabilities: capabilitiesForShop(shop, process.env.SCOPES),
  };
}

/** Fractional change between two figures, guarding division by zero. */
export function change(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return ratio(current - prior, Math.abs(prior));
}

export type Dashboard = Awaited<ReturnType<typeof loadDashboard>>;
export type { ShopAnalytics };
