import {
  loadPeriodProfit,
  loadShopAnalytics,
  resolveRange,
  type ShopAnalytics,
} from "~/data/analytics.server";
import type { DateRange } from "~/data/queries.server";
import { ratio } from "~/engine/money";
import { assessProfitConfidence } from "~/engine/profit-confidence";
import { loadAdSpendCoverage } from "~/lib/ad-spend-coverage.server";
import { withShopContext, type ShopContext } from "~/lib/auth.server";
import { requireActivePlan } from "~/lib/plan.server";
import { parseRangePreset, RANGE_PRESETS } from "~/lib/ranges";
import { capabilitiesForShop } from "~/lib/scopes";
import prisma from "~/db.server";

/**
 * Everything a dashboard route needs, including the preceding window of the
 * same length.
 *
 * A profit figure with nothing to compare it against is trivia. Every headline
 * in the product carries a change against the previous equivalent period, so
 * that comparison is loaded once here rather than by each route.
 */
export async function loadDashboard(request: Request) {
  return withShopContext(request, (ctx) =>
    loadDashboardForContext(request, ctx),
  );
}

export async function loadDashboardForContext(
  request: Request,
  ctx: ShopContext,
) {
  const { shop, isDemo } = ctx;

  // Cheap after the layout loader has already run in the same navigation — the
  // stored row is fresh, so this does not make a second Billing API call.
  const plan = await requireActivePlan(ctx, request);

  const preset = parseRangePreset(
    new URL(request.url).searchParams.get("range"),
  );
  const range = resolveRange(shop, preset, { anchorToData: isDemo });

  const spanMs = range.to.getTime() - range.from.getTime();
  const previousRange: DateRange = {
    from: new Date(range.from.getTime() - spanMs),
    to: new Date(range.from.getTime() - 1),
  };

  // Only the preceding window's roll-up is ever read — see `change()` below and
  // every `previous.period.*` reference in the routes. Building a second full
  // `ShopAnalytics` for it doubled the work on every page load, including a
  // duplicate 365-day cohort scan, for figures nothing looked at.
  // The two analytics builds each hydrate their whole order window. Starting
  // them together can put nearly twice the guarded per-window peak on the heap
  // and exceed the 1 GB production VM. Spend coverage is a small aggregate and
  // can overlap safely; the previous-period build starts only after the current
  // build has released its raw EngineOrder scratch data.
  const adSpendCoveragePromise = loadAdSpendCoverage(shop.id, isDemo);
  const analytics = await loadShopAnalytics(shop, range);
  const [previousPeriod, adSpendCoverage, dismissals] = await Promise.all([
    loadPeriodProfit(shop, previousRange),
    adSpendCoveragePromise,
    prisma.actionDismissal.findMany({
      where: { shopId: shop.id },
      select: { key: true },
    }),
  ]);
  const profitConfidence = assessProfitConfidence({
    orders: analytics.period.orders,
    rules: analytics.rules,
    adSpend: adSpendCoverage,
  });

  return {
    shop,
    isDemo,
    plan,
    preset,
    rangeLabel: RANGE_PRESETS[preset].label,
    range,
    analytics,
    previous: { period: previousPeriod },
    /** Whether paid-marketing spend is actually measurable for this store. */
    adSpendCoverage,
    /** Deterministic provenance summary; never turns unavailable cost into zero. */
    profitConfidence,
    dismissedActionKeys: dismissals.map((item) => item.key),
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
