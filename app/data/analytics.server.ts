import type { Shop } from "@prisma/client";

import prisma from "~/db.server";
import {
  buildJourneysFromRows,
  computeCampaignPerformance,
  computeChannelPerformance,
  type CampaignPerformance,
  type ChannelPerformance,
} from "~/engine/acquisition";
import { analyseCapacity, type CapacityAnalysis } from "~/engine/capacity";
import { computeProfitForPeriod, type PeriodProfit } from "~/engine/profit";
import {
  computeProductProfitability,
  type ProductProfit,
} from "~/engine/products";
import type { CostRuleSet } from "~/engine/types";
import { withAnalyticsAdmission } from "~/lib/analytics-admission.server";
import { RANGE_PRESETS, type RangePreset } from "~/lib/ranges";
import { capabilitiesForShop } from "~/lib/scopes";

import {
  loadAdSpend,
  loadCapacityDays,
  loadCohortRows,
  loadCostRules,
  loadEngineOrders,
  loadProductMeta,
  type DateRange,
} from "./queries.server";

/** How far back cohort value is measured, independent of the reporting window. */
const COHORT_LOOKBACK_DAYS = 365;
const LIVE_RANGE_BUCKET_MS = 60_000;

/**
 * One assembled analytical picture of a store, shared by every dashboard route.
 *
 * Building this once per request rather than per route keeps the five surfaces
 * consistent with each other — there is nothing worse than an overview whose
 * profit figure disagrees with the product page's.
 */
export interface ShopAnalytics {
  shop: Shop;
  range: DateRange;
  rules: CostRuleSet;
  period: PeriodProfit;
  products: ProductProfit[];
  channels: ChannelPerformance[];
  campaigns: CampaignPerformance[];
  capacity: CapacityAnalysis;
  computedInMs: number;
}

export function resolveRange(
  shop: Shop,
  preset: RangePreset,
  { anchorToData = false }: { anchorToData?: boolean } = {},
): DateRange {
  const days = RANGE_PRESETS[preset].days;

  // "Last 30 days" has to mean the last 30 days. Anchoring the window to
  // `lastSyncedAt` instead of now froze a live store's dashboard at whatever
  // moment its backfill finished: every order that arrived afterwards by
  // webhook has processedAt > lastSyncedAt, so `loadEngineOrders` filtered it
  // straight back out and the merchant watched a dashboard that never advanced.
  //
  // The seeded demo store is the one case that genuinely wants the old
  // behaviour — its data ends at a fixed point in the past, so anchoring to now
  // would eventually show an empty window. Callers opt into that explicitly.
  const anchored = anchorToData ? shop.lastSyncedAt : null;
  // Cache entries live for one minute. Giving every live request a distinct
  // millisecond endpoint defeated both the cache and in-flight coalescing even
  // though the resulting financial window was materially identical. Aligning
  // live windows to that same minute keeps "last 30 days" current while making
  // repeated and simultaneous requests share one bounded build.
  const to =
    anchored ??
    new Date(
      Math.floor(Date.now() / LIVE_RANGE_BUCKET_MS) * LIVE_RANGE_BUCKET_MS,
    );
  const from = new Date(to.getTime() - days * 86_400_000);

  return { from, to };
}

// A short-lived cache keyed on the shop's last recompute. Several routes and
// components ask for the same window inside one navigation; recomputing six
// months of orders each time is pure waste. Any recompute invalidates it.
const CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  at: number;
  /** Per-order rows retained by this entry. See CACHE_ORDER_BUDGET. */
  weight: number;
  value: T;
}

const cache = new Map<string, CacheEntry<ShopAnalytics>>();
const shopBuildsInFlight = new Map<string, Promise<ShopAnalytics>>();
const periodBuildsInFlight = new Map<string, Promise<PeriodProfitSummary>>();
let cacheGeneration = 0;

// Comparison windows are cached separately: they are built by the lean path
// below and must never be mistaken for a full build of the same window.
export type PeriodProfitSummary = Omit<PeriodProfit, "orders">;

const periodCache = new Map<string, CacheEntry<PeriodProfitSummary>>();
const PERIOD_CACHE_ENTRY_LIMIT = 64;

function trimPeriodCache(keep: string) {
  const now = Date.now();
  for (const [key, entry] of periodCache) {
    if (key !== keep && now - entry.at >= CACHE_TTL_MS) periodCache.delete(key);
  }

  if (periodCache.size <= PERIOD_CACHE_ENTRY_LIMIT) return;

  const oldest = [...periodCache.entries()].sort(
    ([, left], [, right]) => left.at - right.at,
  );
  for (const [key] of oldest) {
    if (periodCache.size <= PERIOD_CACHE_ENTRY_LIMIT) return;
    if (key !== keep) periodCache.delete(key);
  }
}

/**
 * How many per-order profit rows the two caches may retain between them.
 *
 * The previous bound counted windows — `if (cache.size > 64) cache.clear()` —
 * which is a bound on how many entries there are and none at all on what they
 * weigh. An entry weighs whatever the merchant's window holds: measured on the
 * seeded store, one 180-day `ShopAnalytics` retains 14.5MB, of which the
 * `EngineOrder[]` above was 8.3MB. Sixty-four of those is ~930MB, and
 * `fly.toml` gives this app a 1024MB VM. The bound could be reached by sixteen
 * shops idly paging through the four range presets, on a store of twelve
 * thousand orders — enough for retained windows to matter in production.
 *
 * Counting rows rather than bytes because rows are what actually varies:
 * `PeriodProfit.orders` is a flat array of fixed-shape records, ~520 bytes
 * each, so this budget is roughly 60MB — a few percent of the VM.
 *
 * Overridable, because the right number is a function of the VM this happens to
 * be running on and that is not knowable from here.
 */
const DEFAULT_CACHE_ORDER_BUDGET = 120_000;

function cacheOrderBudget(): number {
  const configured = Number(process.env.MERIDIAN_ANALYTICS_CACHE_ORDERS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CACHE_ORDER_BUDGET;
}

function cacheKey(shopId: string, range: DateRange, stamp: number) {
  return `${shopId}|${range.from.getTime()}|${range.to.getTime()}|${stamp}`;
}

/**
 * Evict oldest-first, across both caches, until the retained rows fit.
 *
 * `keep` is the entry just written. It is never evicted: the request that built
 * it has already paid for it, and dropping it would mean a store whose single
 * window exceeds the whole budget rebuilds on every page load — the caches
 * would cost their maintenance and return nothing. Memory is then bounded by
 * one window, which is the peak that building it required anyway.
 */
function trimCaches(keep: string) {
  const entries = [
    ...[...cache.entries()].map(([key, entry]) => ({
      store: cache,
      key,
      entry,
    })),
    ...[...periodCache.entries()].map(([key, entry]) => ({
      store: periodCache,
      key,
      entry,
    })),
  ].sort((a, b) => a.entry.at - b.entry.at);

  const budget = cacheOrderBudget();
  let retained = entries.reduce((sum, e) => sum + e.entry.weight, 0);

  for (const { store, key, entry } of entries) {
    if (retained <= budget) return;
    if (key === keep) continue;
    store.delete(key);
    retained -= entry.weight;
  }
}

export async function loadShopAnalytics(
  shop: Shop,
  range: DateRange,
): Promise<ShopAnalytics> {
  const stamp = shop.lastComputedAt?.getTime() ?? 0;
  const key = cacheKey(shop.id, range, stamp);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const flightKey = `${key}|${cacheGeneration}`;
  const existingBuild = shopBuildsInFlight.get(flightKey);
  if (existingBuild) return existingBuild;

  const generation = cacheGeneration;
  const build = withAnalyticsAdmission(async () => {
    // A request ahead of this one may have filled the cache while this build
    // waited for admission.
    const queuedHit = cache.get(key);
    if (queuedHit && Date.now() - queuedHit.at < CACHE_TTL_MS) {
      return queuedHit.value;
    }

    // Admission serializes heavy builds, but an old full-window cache can
    // still retain tens of thousands of PeriodProfit rows while the next miss
    // hydrates its order graph. Drop those strong references before any loader
    // starts so the admitted build owns the heap headroom it was admitted for.
    cache.clear();

    const startedAt = Date.now();

    try {
      const cohortRange: DateRange = {
        from: new Date(range.to.getTime() - COHORT_LOOKBACK_DAYS * 86_400_000),
        to: range.to,
      };
      const includeCustomerCohorts = capabilitiesForShop(
        shop,
        process.env.SCOPES,
      ).customers;

      const [orders, spend, rules, productMeta, capacityDays, cohortRows] =
        await Promise.all([
          loadEngineOrders(shop.id, range),
          loadAdSpend(shop.id, range),
          loadCostRules(shop.id),
          loadProductMeta(shop.id),
          loadCapacityDays(shop.id, range),
          includeCustomerCohorts
            ? loadCohortRows(shop.id, cohortRange)
            : Promise.resolve([]),
        ]);

      const cohortJourneys = buildJourneysFromRows(cohortRows);

      const period = computeProfitForPeriod(
        orders,
        spend,
        rules,
        shop.timezone,
        range,
      );

      // `orders` — the hydrated engine input, line items and all — deliberately
      // does not go into the returned object. Every consumer reads `period.orders`,
      // the per-order profit rows; nothing outside this function has ever read the
      // raw input. Returning it meant the cache held the engine's scratch paper for
      // a minute after the answer was computed, at 57% of the entry's weight.
      const value: ShopAnalytics = {
        shop,
        range,
        rules,
        period,
        products: computeProductProfitability(
          orders,
          period.orders,
          productMeta,
        ),
        channels: computeChannelPerformance(orders, period.orders, spend, {
          periodStart: range.from,
          periodEnd: range.to,
          cohortJourneys,
          cohortEnd: cohortRange.to,
        }),
        campaigns: computeCampaignPerformance(orders, period.orders, spend),
        capacity: analyseCapacity(capacityDays, {
          slaDays: shop.fulfillmentSlaDays,
          today: range.to,
        }),
        computedInMs: Date.now() - startedAt,
      };

      // A webhook or recompute can invalidate while the engine is running. Do
      // not put that now-stale snapshot back after the invalidation.
      if (generation === cacheGeneration) {
        cache.set(key, { at: Date.now(), weight: period.orders.length, value });
        trimCaches(key);
      }

      return value;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "WindowTooLargeError") {
        throw error;
      }
      // Large windows read the exact profit ledger already materialized by the
      // recompute worker and aggregate product lines in SQL. This avoids
      // hydrating the full order + line-item graph that the guard refused.
      const { loadMaterializedShopAnalytics } = await import(
        "./materialized-analytics.server"
      );
      const value: ShopAnalytics = await loadMaterializedShopAnalytics(
        shop,
        range,
      );
      if (generation === cacheGeneration) {
        cache.set(key, {
          at: Date.now(),
          weight: value.period.orders.length,
          value,
        });
        trimCaches(key);
      }
      return value;
    }
  });

  shopBuildsInFlight.set(flightKey, build);
  try {
    return await build;
  } finally {
    if (shopBuildsInFlight.get(flightKey) === build) {
      shopBuildsInFlight.delete(flightKey);
    }
  }
}

/**
 * The period roll-up on its own, without the analysis layered on top of it.
 *
 * Every headline in the product carries a change against the preceding window
 * of the same length, and that comparison needs nothing but `PeriodProfit`
 * scalars — net profit, revenue, contribution, ad spend, order count, AOV.
 * Building a whole `ShopAnalytics` for it meant every page load also ran a
 * second 365-day cohort scan, a second capacity query, a second product-meta
 * query, and the product, channel, campaign and capacity engines, then read one
 * field off the result and discarded the rest.
 *
 * This is the same `computeProfitForPeriod` call over the same orders, so the
 * comparison figures are identical to what the full build produced — there is
 * no second definition of profit here, only less work around the one.
 */
export async function loadPeriodProfit(
  shop: Shop,
  range: DateRange,
): Promise<PeriodProfitSummary> {
  const stamp = shop.lastComputedAt?.getTime() ?? 0;
  const key = cacheKey(shop.id, range, stamp);

  // A full build for this window already holds this exact roll-up. Reuse it
  // rather than recomputing, so paging back through ranges stays cheap.
  const full = cache.get(key);
  if (full && Date.now() - full.at < CACHE_TTL_MS) {
    const { orders: _discardedOrders, ...summary } = full.value.period;
    return summary;
  }

  const hit = periodCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const flightKey = `${key}|${cacheGeneration}`;
  const existingBuild = periodBuildsInFlight.get(flightKey);
  if (existingBuild) return existingBuild;

  const generation = cacheGeneration;
  const build = withAnalyticsAdmission(async () => {
    // Re-check both caches after waiting: a full build ahead of this one may
    // already contain the exact period, or another request may have produced
    // the scalar comparison.
    const queuedFull = cache.get(key);
    if (queuedFull && Date.now() - queuedFull.at < CACHE_TTL_MS) {
      const { orders: _discardedOrders, ...summary } = queuedFull.value.period;
      return summary;
    }
    const queuedHit = periodCache.get(key);
    if (queuedHit && Date.now() - queuedHit.at < CACHE_TTL_MS) {
      return queuedHit.value;
    }

    // The lean comparison discards its result rows, but it still hydrates and
    // computes the complete order graph while running. A retained full window
    // must not coexist with that peak either.
    cache.clear();

    let value: PeriodProfit;
    try {
      const [orders, spend, rules] = await Promise.all([
        loadEngineOrders(shop.id, range),
        loadAdSpend(shop.id, range),
        loadCostRules(shop.id),
      ]);
      value = computeProfitForPeriod(
        orders,
        spend,
        rules,
        shop.timezone,
        range,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "WindowTooLargeError") {
        throw error;
      }
      const { loadMaterializedPeriodProfit } = await import(
        "./materialized-analytics.server"
      );
      value = await loadMaterializedPeriodProfit(shop.id, range);
    }
    const { orders: _discardedOrders, ...summary } = value;

    // Comparison routes read scalar deltas only. Keeping `value.orders` here
    // retained tens of thousands of per-order rows for a result whose callers
    // never inspect them, directly competing with the current-period cache on a
    // 1 GB instance.
    if (generation === cacheGeneration) {
      periodCache.set(key, { at: Date.now(), weight: 0, value: summary });
      trimPeriodCache(key);
    }

    return summary;
  });

  periodBuildsInFlight.set(flightKey, build);
  try {
    return await build;
  } finally {
    if (periodBuildsInFlight.get(flightKey) === build) {
      periodBuildsInFlight.delete(flightKey);
    }
  }
}

/**
 * The capacity analysis alone, with none of the profit engine behind it.
 *
 * `analyseCapacity` reads `CapacityDay` rows and two shop settings. It does not
 * look at an order, a line item, a cost rule or a cohort — so the alert count in
 * the sidebar badge, which is all the app shell wants, never needed any of that
 * work.
 *
 * It was getting it anyway. The layout loader called `loadShopAnalytics` on
 * every navigation, which hydrates every order and line item in the window into
 * Node and runs the profit, product, channel and campaign engines over them, to
 * read `.capacity.alerts.length` off the result. That made the most expensive
 * path in the product a property of the *shell* rather than of the one screen
 * that needs it: a store large enough to strain the analytics build strained it
 * on Settings, on Plan, on every page — including the Settings page that holds
 * the retry control it would need to recover.
 *
 * `CapacityDay` is one row per day, so a 365-day window is 365 small rows
 * against a hydrated order graph of tens of thousands. No cache: the query is
 * already cheaper than the bookkeeping would be.
 */
export async function loadCapacityAnalysis(
  shop: Shop,
  range: DateRange,
): Promise<CapacityAnalysis> {
  // A full build for this window has already done this exact work.
  const stamp = shop.lastComputedAt?.getTime() ?? 0;
  const full = cache.get(cacheKey(shop.id, range, stamp));
  if (full && Date.now() - full.at < CACHE_TTL_MS) return full.value.capacity;

  const capacityDays = await loadCapacityDays(shop.id, range);

  return analyseCapacity(capacityDays, {
    slaDays: shop.fulfillmentSlaDays,
    today: range.to,
  });
}

export function invalidateAnalyticsCache() {
  cacheGeneration += 1;
  cache.clear();
  periodCache.clear();
}

/** Products whose loss is genuinely buying better-than-average customers. */
export async function loadStrategicProductIds(
  shopId: string,
  range: DateRange,
): Promise<Set<string>> {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const analytics = await loadShopAnalytics(shop, range);

  return new Set(
    analytics.products
      .filter((p) => p.classification === "STRATEGIC_LOSS_LEADER")
      .map((p) => p.productId),
  );
}
