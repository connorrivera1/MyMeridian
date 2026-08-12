import prisma from "~/db.server";
import { PLANS, type PlanId } from "~/lib/plans";
import { formatOperatorProvider } from "~/lib/operator-display";

const DAY_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_STATUS = "active";
const CHURN_STATUSES = new Set(["CANCELLED", "DECLINED", "EXPIRED", "FROZEN"]);

export function latestChurnedShopIds(
  events: Array<{ shopId: string; status: string }>,
): Set<string> {
  const latestStatusByShop = new Map<string, string>();
  for (const event of events) {
    if (!latestStatusByShop.has(event.shopId)) {
      latestStatusByShop.set(event.shopId, event.status.toUpperCase());
    }
  }
  return new Set(
    [...latestStatusByShop]
      .filter(([, status]) => CHURN_STATUSES.has(status))
      .map(([shopId]) => shopId),
  );
}

interface SubscriptionProjection {
  plan: string;
  interval: string;
  status: string;
  trialEndsAt: Date | null;
  shop: { uninstalledAt: Date | null; isDemo: boolean };
}

export function subscriptionRevenueCents(
  subscription: Pick<SubscriptionProjection, "plan" | "interval">,
): { mrrCents: number; arrCents: number } | null {
  if (!(subscription.plan in PLANS)) return null;
  const plan = PLANS[subscription.plan as PlanId];
  if (subscription.interval.toLowerCase() === "annual") {
    return {
      mrrCents: (plan.annualPrice * 100) / 12,
      arrCents: plan.annualPrice * 100,
    };
  }
  return { mrrCents: plan.price * 100, arrCents: plan.price * 1_200 };
}

export function summarizeSubscriptions(
  subscriptions: SubscriptionProjection[],
  now = new Date(),
) {
  const planDistribution = Object.fromEntries(
    Object.keys(PLANS).map((plan) => [plan, 0]),
  ) as Record<PlanId, number>;
  let activePayingStores = 0;
  let trials = 0;
  let mrr = 0;
  let arr = 0;
  let completedTrials = 0;
  let convertedTrials = 0;

  for (const row of subscriptions) {
    if (row.shop.isDemo || row.shop.uninstalledAt) continue;
    const recognized = row.plan in PLANS;
    const active = row.status.toLowerCase() === ACTIVE_STATUS && recognized;
    const trialing = active && Boolean(row.trialEndsAt && row.trialEndsAt > now);

    if (trialing) trials += 1;
    if (row.trialEndsAt && row.trialEndsAt <= now) {
      completedTrials += 1;
      if (active) convertedTrials += 1;
    }
    if (!active || trialing) continue;

    activePayingStores += 1;
    planDistribution[row.plan as PlanId] += 1;
    const revenue = subscriptionRevenueCents(row);
    if (revenue) {
      mrr += revenue.mrrCents;
      arr += revenue.arrCents;
    }
  }

  return {
    activePayingStores,
    trials,
    mrrCents: Math.round(mrr),
    arrCents: Math.round(arr),
    planDistribution,
    completedTrials,
    convertedTrials,
    trialConversionRate:
      completedTrials === 0 ? null : convertedTrials / completedTrials,
  };
}

export interface OperationalAlert {
  id: string;
  kind:
    | "import"
    | "webhook"
    | "recalculation"
    | "notification"
    | "ad_sync"
    | "connector";
  severity: "warning" | "critical";
  shopId: string;
  shopDomain: string;
  summary: string;
  occurredAt: Date;
}

export async function loadOperatorOverview(now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const dbStartedAt = performance.now();
  await prisma.$queryRaw`SELECT 1`;
  const databaseLatencyMs = Math.max(0, Math.round(performance.now() - dbStartedAt));

  const [
    subscriptions,
    installTotal,
    installs30d,
    uninstallTotal,
    uninstalls30d,
    installedStoreCount,
    subscriptionEvents,
    connectors,
    failedImports,
    webhookFailureCount,
    webhookBacklog,
    recalcFailures,
    recalcBacklog,
    notificationFailures,
    notificationBacklog,
    adSyncFailures,
    adSyncBacklog,
    importAlerts,
    webhookAlerts,
    recalcAlerts,
    notificationAlerts,
    adSyncAlerts,
    connectorAlerts,
  ] = await Promise.all([
    prisma.subscription.findMany({
      select: {
        plan: true,
        interval: true,
        status: true,
        trialEndsAt: true,
        shop: { select: { uninstalledAt: true, isDemo: true } },
      },
    }),
    prisma.shop.count({ where: { isDemo: false } }),
    prisma.shop.count({ where: { isDemo: false, installedAt: { gte: since } } }),
    prisma.shop.count({ where: { isDemo: false, uninstalledAt: { not: null } } }),
    prisma.shop.count({ where: { isDemo: false, uninstalledAt: { gte: since } } }),
    prisma.shop.count({ where: { isDemo: false, uninstalledAt: null } }),
    prisma.subscriptionEvent.findMany({
      where: { occurredAt: { gte: since } },
      select: { shopId: true, status: true, occurredAt: true },
      orderBy: { occurredAt: "desc" },
    }),
    prisma.connector.groupBy({
      by: ["provider"],
      where: {
        status: "CONNECTED",
        shop: { isDemo: false, uninstalledAt: null },
      },
      _count: { _all: true },
    }),
    prisma.shop.count({
      where: { isDemo: false, uninstalledAt: null, syncStatus: "FAILED" },
    }),
    prisma.webhookEvent.count({
      where: { processedAt: null, error: { not: null } },
    }),
    prisma.webhookEvent.count({ where: { processedAt: null } }),
    prisma.recalcJob.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
    prisma.recalcJob.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    prisma.merchantNotification.count({
      where: { status: "FAILED", createdAt: { gte: since } },
    }),
    prisma.merchantNotification.count({
      where: { status: { in: ["PENDING", "SENDING"] } },
    }),
    prisma.adSyncWindow.count({
      where: { status: "FAILED", updatedAt: { gte: since } },
    }),
    prisma.adSyncWindow.count({ where: { status: "PENDING" } }),
    prisma.shop.findMany({
      where: { isDemo: false, uninstalledAt: null, syncStatus: "FAILED" },
      select: { id: true, domain: true, syncStartedAt: true, installedAt: true },
      orderBy: { syncStartedAt: "desc" },
      take: 10,
    }),
    prisma.webhookEvent.findMany({
      where: { processedAt: null, error: { not: null } },
      select: {
        id: true,
        shopId: true,
        attempts: true,
        receivedAt: true,
        shop: { select: { domain: true } },
      },
      orderBy: { receivedAt: "desc" },
      take: 10,
    }),
    prisma.recalcJob.findMany({
      where: { status: "FAILED", createdAt: { gte: since } },
      select: {
        id: true,
        shopId: true,
        attempts: true,
        createdAt: true,
        shop: { select: { domain: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.merchantNotification.findMany({
      where: { status: "FAILED", createdAt: { gte: since } },
      select: {
        id: true,
        shopId: true,
        attempts: true,
        createdAt: true,
        shop: { select: { domain: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.adSyncWindow.findMany({
      where: { status: "FAILED", updatedAt: { gte: since } },
      select: {
        id: true,
        shopId: true,
        attempts: true,
        updatedAt: true,
        shop: { select: { domain: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
    }),
    prisma.connectorHealthEvent.findMany({
      where: {
        createdAt: { gte: since },
        status: { in: ["DEGRADED", "UNHEALTHY"] },
        connector: { healthStatus: { in: ["DEGRADED", "UNHEALTHY"] } },
      },
      select: {
        id: true,
        shopId: true,
        provider: true,
        status: true,
        createdAt: true,
        shop: { select: { domain: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const revenue = summarizeSubscriptions(subscriptions, now);
  // The query is newest-first, so only the latest transition for each shop
  // decides churn. A cancellation followed by reactivation in the same month
  // is not still churned.
  const churnedShopIds = latestChurnedShopIds(subscriptionEvents);
  const churnDenominator = revenue.activePayingStores + churnedShopIds.size;
  const connectorAdoption = connectors.map((row) => ({
    provider: row.provider,
    connectedStores: row._count._all,
    adoptionRate:
      installedStoreCount === 0 ? null : row._count._all / installedStoreCount,
  }));

  const alerts: OperationalAlert[] = [
    ...importAlerts.map((row) => ({
      id: `import:${row.id}`,
      kind: "import" as const,
      severity: "critical" as const,
      shopId: row.id,
      shopDomain: row.domain,
      summary: "Historical import failed",
      occurredAt: row.syncStartedAt ?? row.installedAt,
    })),
    ...webhookAlerts.map((row) => ({
      id: `webhook:${row.id}`,
      kind: "webhook" as const,
      severity: "critical" as const,
      shopId: row.shopId,
      shopDomain: row.shop.domain,
      summary: `Webhook processing failed after ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`,
      occurredAt: row.receivedAt,
    })),
    ...recalcAlerts.map((row) => ({
      id: `recalc:${row.id}`,
      kind: "recalculation" as const,
      severity: "critical" as const,
      shopId: row.shopId,
      shopDomain: row.shop.domain,
      summary: `Background recalculation failed after ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`,
      occurredAt: row.createdAt,
    })),
    ...notificationAlerts.map((row) => ({
      id: `notification:${row.id}`,
      kind: "notification" as const,
      severity: "warning" as const,
      shopId: row.shopId,
      shopDomain: row.shop.domain,
      summary: `Merchant notification failed after ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`,
      occurredAt: row.createdAt,
    })),
    ...adSyncAlerts.map((row) => ({
      id: `ad-sync:${row.id}`,
      kind: "ad_sync" as const,
      severity: "warning" as const,
      shopId: row.shopId,
      shopDomain: row.shop.domain,
      summary: `Ad-spend sync failed after ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`,
      occurredAt: row.updatedAt,
    })),
    ...connectorAlerts.map((row) => ({
      id: `connector:${row.id}`,
      kind: "connector" as const,
      severity: row.status === "UNHEALTHY" ? ("critical" as const) : ("warning" as const),
      shopId: row.shopId,
      shopDomain: row.shop.domain,
      summary: `${formatOperatorProvider(row.provider)} connector is ${row.status.toLowerCase()}`,
      occurredAt: row.createdAt,
    })),
  ]
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 30);

  const failureTotal =
    failedImports +
    webhookFailureCount +
    recalcFailures +
    notificationFailures +
    adSyncFailures;

  return {
    generatedAt: now,
    revenue,
    lifecycle: {
      installTotal,
      installs30d,
      uninstallTotal,
      uninstalls30d,
      churnedStores30d: churnedShopIds.size,
      churnRate30d:
        churnDenominator === 0 ? null : churnedShopIds.size / churnDenominator,
    },
    connectors: connectorAdoption,
    failures: {
      failedImports,
      webhookFailures: webhookFailureCount,
      recalcFailures,
      notificationFailures,
      adSyncFailures,
    },
    system: {
      status: failureTotal > 0 ? ("degraded" as const) : ("healthy" as const),
      database: "reachable" as const,
      databaseLatencyMs,
      webhookBacklog,
      recalcBacklog,
      notificationBacklog,
      adSyncBacklog,
      adIngestion: process.env.MERIDIAN_REDIS_URL?.trim()
        ? ("configured" as const)
        : ("offline" as const),
      emailDelivery: process.env.RESEND_API_KEY?.trim()
        ? ("configured" as const)
        : ("offline" as const),
    },
    alerts,
  };
}

export async function loadOperatorStores(search = "") {
  const normalized = search.trim().toLowerCase().slice(0, 253);
  return prisma.shop.findMany({
    where: {
      isDemo: false,
      ...(normalized ? { domain: { contains: normalized, mode: "insensitive" } } : {}),
    },
    select: {
      id: true,
      domain: true,
      installedAt: true,
      uninstalledAt: true,
      lastSyncedAt: true,
      syncStatus: true,
      subscription: { select: { plan: true, status: true, trialEndsAt: true } },
    },
    orderBy: { installedAt: "desc" },
    take: 50,
  });
}

export async function loadOperatorStore(shopId: string) {
  const shop = await prisma.shop.findFirst({
    where: { id: shopId, isDemo: false },
    select: {
      id: true,
      domain: true,
      installedAt: true,
      uninstalledAt: true,
      lastSyncedAt: true,
      lastComputedAt: true,
      syncStatus: true,
      syncStartedAt: true,
      syncCompletedAt: true,
      syncStage: true,
      syncedOrders: true,
      syncedProducts: true,
      hasAllOrdersScope: true,
      earliestOrderAt: true,
      grantedScopes: true,
      subscription: {
        select: {
          plan: true,
          interval: true,
          status: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      connectors: {
        select: {
          provider: true,
          status: true,
          healthStatus: true,
          lastSyncedAt: true,
          lastHealthCheckedAt: true,
          lastHealthyAt: true,
          consecutiveFailures: true,
        },
        orderBy: { provider: "asc" },
      },
    },
  });
  if (!shop) return null;

  const [
    totalOrders,
    computedOrders,
    missingCogsOrders,
    totalVariants,
    missingCostVariants,
    failedWebhooks,
    pendingWebhooks,
    failedRecalcJobs,
    pendingRecalcJobs,
    failedNotifications,
    pendingNotifications,
    failedAdSyncWindows,
    pendingAdSyncWindows,
  ] = await Promise.all([
    prisma.order.count({ where: { shopId } }),
    prisma.order.count({ where: { shopId, computedAt: { not: null } } }),
    prisma.order.count({ where: { shopId, materializedMissingCogs: true } }),
    prisma.variant.count({ where: { shopId } }),
    prisma.variant.count({ where: { shopId, unitCost: null } }),
    prisma.webhookEvent.count({ where: { shopId, processedAt: null, error: { not: null } } }),
    prisma.webhookEvent.count({ where: { shopId, processedAt: null } }),
    prisma.recalcJob.count({ where: { shopId, status: "FAILED" } }),
    prisma.recalcJob.count({ where: { shopId, status: { in: ["QUEUED", "RUNNING"] } } }),
    prisma.merchantNotification.count({ where: { shopId, status: "FAILED" } }),
    prisma.merchantNotification.count({ where: { shopId, status: { in: ["PENDING", "SENDING"] } } }),
    prisma.adSyncWindow.count({ where: { shopId, status: "FAILED" } }),
    prisma.adSyncWindow.count({ where: { shopId, status: "PENDING" } }),
  ]);

  const dataComplete =
    shop.syncStatus === "COMPLETE" &&
    totalOrders === computedOrders &&
    missingCogsOrders === 0 &&
    missingCostVariants === 0;

  return {
    ...shop,
    dataCompleteness: {
      status: dataComplete ? ("complete" as const) : ("attention" as const),
      historyCoverage: shop.hasAllOrdersScope ? ("all_orders" as const) : ("limited_60_days" as const),
      totalOrders,
      computedOrders,
      missingCogsOrders,
      totalVariants,
      missingCostVariants,
    },
    jobHealth: {
      failedWebhooks,
      pendingWebhooks,
      failedRecalcJobs,
      pendingRecalcJobs,
      failedNotifications,
      pendingNotifications,
      failedAdSyncWindows,
      pendingAdSyncWindows,
    },
  };
}
