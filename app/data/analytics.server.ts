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
import type { CostRuleSet, EngineOrder } from "~/engine/types";
import { RANGE_PRESETS, type RangePreset } from "~/lib/ranges";

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
  orders: EngineOrder[];
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
  const to = (anchorToData ? shop.lastSyncedAt : null) ?? new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  return { from, to };
}

// A short-lived cache keyed on the shop's last recompute. Several routes and
// components ask for the same window inside one navigation; recomputing six
// months of orders each time is pure waste. Any recompute invalidates it.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: ShopAnalytics }>();

// Comparison windows are cached separately: they are built by the lean path
// below and must never be mistaken for a full build of the same window.
const periodCache = new Map<string, { at: number; value: PeriodProfit }>();

function cacheKey(shopId: string, range: DateRange, stamp: number) {
  return `${shopId}|${range.from.getTime()}|${range.to.getTime()}|${stamp}`;
}

export async function loadShopAnalytics(
  shop: Shop,
  range: DateRange,
): Promise<ShopAnalytics> {
  const stamp = shop.lastComputedAt?.getTime() ?? 0;
  const key = cacheKey(shop.id, range, stamp);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const startedAt = Date.now();

  const cohortRange: DateRange = {
    from: new Date(range.to.getTime() - COHORT_LOOKBACK_DAYS * 86_400_000),
    to: range.to,
  };

  const [orders, spend, rules, productMeta, capacityDays, cohortRows] =
    await Promise.all([
      loadEngineOrders(shop.id, range),
      loadAdSpend(shop.id, range),
      loadCostRules(shop.id),
      loadProductMeta(shop.id),
      loadCapacityDays(shop.id, range),
      loadCohortRows(shop.id, cohortRange),
    ]);

  const cohortJourneys = buildJourneysFromRows(cohortRows);

  const period = computeProfitForPeriod(
    orders,
    spend,
    rules,
    shop.timezone,
    range,
  );

  const value: ShopAnalytics = {
    shop,
    range,
    rules,
    orders,
    period,
    products: computeProductProfitability(orders, period.orders, productMeta),
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

  // Bound the cache — a busy multi-shop instance should not accumulate windows.
  if (cache.size > 64) cache.clear();
  cache.set(key, { at: Date.now(), value });

  return value;
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
): Promise<PeriodProfit> {
  const stamp = shop.lastComputedAt?.getTime() ?? 0;
  const key = cacheKey(shop.id, range, stamp);

  // A full build for this window already holds this exact roll-up. Reuse it
  // rather than recomputing, so paging back through ranges stays cheap.
  const full = cache.get(key);
  if (full && Date.now() - full.at < CACHE_TTL_MS) return full.value.period;

  const hit = periodCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const [orders, spend, rules] = await Promise.all([
    loadEngineOrders(shop.id, range),
    loadAdSpend(shop.id, range),
    loadCostRules(shop.id),
  ]);

  const value = computeProfitForPeriod(orders, spend, rules, shop.timezone, range);

  if (periodCache.size > 64) periodCache.clear();
  periodCache.set(key, { at: Date.now(), value });

  return value;
}

export function invalidateAnalyticsCache() {
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
