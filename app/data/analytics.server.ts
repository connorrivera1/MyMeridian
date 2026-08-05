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

export function resolveRange(shop: Shop, preset: RangePreset): DateRange {
  const days = RANGE_PRESETS[preset].days;

  // Anchor to the newest data rather than wall-clock now, so a demo store (or a
  // store mid-backfill) shows a populated window instead of an empty one.
  const to = shop.lastSyncedAt ?? new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  return { from, to };
}

// A short-lived cache keyed on the shop's last recompute. Several routes and
// components ask for the same window inside one navigation; recomputing six
// months of orders each time is pure waste. Any recompute invalidates it.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: ShopAnalytics }>();

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

export function invalidateAnalyticsCache() {
  cache.clear();
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
