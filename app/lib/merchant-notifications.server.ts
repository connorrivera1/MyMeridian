import crypto from "node:crypto";

import {
  MerchantNotificationKind,
  MerchantNotificationStatus,
  Prisma,
} from "@prisma/client";

import prisma from "~/db.server";
import { sendEmail } from "~/lib/mail.server";

const DAY_MS = 24 * 60 * 60 * 1_000;
const LEASE_MS = 2 * 60 * 1_000;
const POLL_MS = 60 * 1_000;
const MAX_ATTEMPTS = 5;

type MoneySummary = {
  orders: number;
  revenue: number;
  contribution: number;
  netProfit: number;
  refunds: number;
  shippingCost: number;
};

export type WeeklySummaryPayload = {
  shopName: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  current: MoneySummary;
  previous: MoneySummary;
  missingCostLines: number;
};

export type AnomalyPayload = {
  shopName: string;
  currency: string;
  detectedAt: string;
  findings: string[];
};

function number(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

async function aggregateOrders(
  shopId: string,
  from: Date,
  to: Date,
): Promise<MoneySummary> {
  const result = await prisma.order.aggregate({
    where: { shopId, processedAt: { gte: from, lt: to } },
    _count: { _all: true },
    _sum: {
      total: true,
      contributionProfit: true,
      netProfit: true,
      refundedTotal: true,
      shippingCost: true,
    },
  });
  return {
    orders: result._count._all,
    revenue: number(result._sum.total),
    contribution: number(result._sum.contributionProfit),
    netProfit: number(result._sum.netProfit),
    refunds: number(result._sum.refundedTotal),
    shippingCost: number(result._sum.shippingCost),
  };
}

export function nextWeeklyOccurrence(day: number, now = new Date()): Date {
  const normalized = Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1;
  const next = new Date(now);
  next.setUTCHours(13, 0, 0, 0);
  let distance = (normalized - next.getUTCDay() + 7) % 7;
  if (distance === 0 && next <= now) distance = 7;
  next.setUTCDate(next.getUTCDate() + distance);
  return next;
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function percentChange(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? "flat" : "new this week";
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

export function renderWeeklySummary(payload: WeeklySummaryPayload): {
  subject: string;
  text: string;
  html: string;
} {
  const { current, previous, currency } = payload;
  const rows: Array<[string, string, string]> = [
    ["Orders", current.orders.toLocaleString(), percentChange(current.orders, previous.orders)],
    ["Revenue", formatMoney(current.revenue, currency), percentChange(current.revenue, previous.revenue)],
    ["Net profit", formatMoney(current.netProfit, currency), percentChange(current.netProfit, previous.netProfit)],
    ["Refunds", formatMoney(current.refunds, currency), percentChange(current.refunds, previous.refunds)],
  ];
  const subject = `${payload.shopName}: weekly profit summary`;
  const text = [
    `${payload.shopName} — weekly profit summary`,
    `${payload.periodStart.slice(0, 10)} to ${payload.periodEnd.slice(0, 10)}`,
    "",
    ...rows.map(([label, value, change]) => `${label}: ${value} (${change})`),
    ...(payload.missingCostLines > 0
      ? ["", `${payload.missingCostLines} sold line item(s) still have no recorded unit cost.`]
      : []),
    "",
    "Open MyMeridian for the qualified detail behind these figures.",
  ].join("\n");
  const html = `<h1>${escapeHtml(payload.shopName)} weekly profit summary</h1><p>${payload.periodStart.slice(0, 10)} to ${payload.periodEnd.slice(0, 10)}</p><table>${rows
    .map(
      ([label, value, change]) =>
        `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td><td>${escapeHtml(change)}</td></tr>`,
    )
    .join("")}</table>${
    payload.missingCostLines > 0
      ? `<p><strong>${payload.missingCostLines}</strong> sold line item(s) still have no recorded unit cost.</p>`
      : ""
  }<p>Open MyMeridian for the qualified detail behind these figures.</p>`;
  return { subject, text, html };
}

export function renderAnomalyAlert(payload: AnomalyPayload): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `${payload.shopName}: profit anomaly detected`;
  const text = [
    `${payload.shopName} — profit anomaly detected`,
    "",
    ...payload.findings.map((finding) => `• ${finding}`),
    "",
    "Open MyMeridian to inspect the affected inputs before acting.",
  ].join("\n");
  const html = `<h1>${escapeHtml(payload.shopName)} profit anomaly detected</h1><ul>${payload.findings
    .map((finding) => `<li>${escapeHtml(finding)}</li>`)
    .join("")}</ul><p>Open MyMeridian to inspect the affected inputs before acting.</p>`;
  return { subject, text, html };
}

export async function queueWeeklySummary(
  shop: {
    id: string;
    name: string;
    email: string | null;
    currency: string;
    weeklySummaryEmail: string | null;
    weeklySummaryDay: number;
  },
  now = new Date(),
): Promise<boolean> {
  const recipient = shop.weeklySummaryEmail ?? shop.email;
  if (!recipient) return false;
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - 7 * DAY_MS);
  const previousStart = new Date(now.getTime() - 14 * DAY_MS);
  const [current, previous, missingCostLines] = await Promise.all([
    aggregateOrders(shop.id, periodStart, periodEnd),
    aggregateOrders(shop.id, previousStart, periodStart),
    prisma.orderLineItem.count({
      where: {
        shopId: shop.id,
        unitCost: 0,
        quantity: { gt: 0 },
        order: { processedAt: { gte: periodStart, lt: periodEnd } },
      },
    }),
  ]);
  const payload: WeeklySummaryPayload = {
    shopName: shop.name,
    currency: shop.currency,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    current,
    previous,
    missingCostLines,
  };
  const rendered = renderWeeklySummary(payload);
  const weekKey = periodEnd.toISOString().slice(0, 10);
  try {
    await prisma.merchantNotification.create({
      data: {
        shopId: shop.id,
        kind: MerchantNotificationKind.WEEKLY_SUMMARY,
        recipient,
        subject: rendered.subject,
        payload: payload as unknown as Prisma.InputJsonValue,
        dedupeKey: `weekly:${shop.id}:${weekKey}`,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      nextWeeklySummaryAt: nextWeeklyOccurrence(shop.weeklySummaryDay, now),
      lastWeeklySummaryError: null,
    },
  });
  return true;
}

export async function detectAndQueueAnomalies(
  shop: { id: string; name: string; email: string | null; currency: string },
  now = new Date(),
): Promise<string[]> {
  const periodStart = new Date(now.getTime() - 7 * DAY_MS);
  const previousStart = new Date(now.getTime() - 14 * DAY_MS);
  const [current, previous, missingCostLines, unhealthyConnectors] =
    await Promise.all([
      aggregateOrders(shop.id, periodStart, now),
      aggregateOrders(shop.id, previousStart, periodStart),
      prisma.orderLineItem.count({
        where: {
          shopId: shop.id,
          unitCost: 0,
          quantity: { gt: 0 },
          order: { processedAt: { gte: periodStart, lt: now } },
        },
      }),
      prisma.connector.count({
        where: {
          shopId: shop.id,
          status: "CONNECTED",
          healthStatus: { in: ["DEGRADED", "UNHEALTHY"] },
        },
      }),
    ]);
  const findings: string[] = [];
  if (current.orders >= 5 && previous.orders >= 5) {
    const currentMargin = current.revenue ? current.netProfit / current.revenue : 0;
    const previousMargin = previous.revenue ? previous.netProfit / previous.revenue : 0;
    if (previousMargin - currentMargin >= 0.05) {
      findings.push(
        `Net margin fell ${((previousMargin - currentMargin) * 100).toFixed(1)} percentage points week over week.`,
      );
    }
    const currentRefundRate = current.revenue ? current.refunds / current.revenue : 0;
    const previousRefundRate = previous.revenue ? previous.refunds / previous.revenue : 0;
    if (currentRefundRate - previousRefundRate >= 0.05) {
      findings.push(
        `Refunds rose ${((currentRefundRate - previousRefundRate) * 100).toFixed(1)} percentage points as a share of revenue.`,
      );
    }
    const currentShipping = current.orders ? current.shippingCost / current.orders : 0;
    const previousShipping = previous.orders ? previous.shippingCost / previous.orders : 0;
    if (previousShipping > 0 && currentShipping / previousShipping >= 1.2) {
      findings.push(
        `Average shipping cost rose ${((currentShipping / previousShipping - 1) * 100).toFixed(1)}% week over week.`,
      );
    }
  }
  if (missingCostLines > 0) {
    findings.push(`${missingCostLines} sold line item(s) have no recorded unit cost.`);
  }
  if (unhealthyConnectors > 0) {
    findings.push(`${unhealthyConnectors} connected data source(s) are degraded or unhealthy.`);
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: { lastAnomalyCheckAt: now },
  });
  if (findings.length === 0 || !shop.email) return findings;

  const payload: AnomalyPayload = {
    shopName: shop.name,
    currency: shop.currency,
    detectedAt: now.toISOString(),
    findings,
  };
  const rendered = renderAnomalyAlert(payload);
  const dayKey = now.toISOString().slice(0, 10);
  try {
    await prisma.merchantNotification.create({
      data: {
        shopId: shop.id,
        kind: MerchantNotificationKind.ANOMALY_ALERT,
        recipient: shop.email,
        subject: rendered.subject,
        payload: payload as unknown as Prisma.InputJsonValue,
        dedupeKey: `anomaly:${shop.id}:${dayKey}`,
      },
    });
    await prisma.shop.update({
      where: { id: shop.id },
      data: { lastAnomalyAlertAt: now },
    });
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      throw error;
    }
  }
  return findings;
}

async function queueDueWork(now = new Date()): Promise<void> {
  const [weeklyShops, anomalyShops] = await Promise.all([
    prisma.shop.findMany({
      where: {
        uninstalledAt: null,
        weeklySummaryEnabled: true,
        OR: [
          { nextWeeklySummaryAt: null },
          { nextWeeklySummaryAt: { lte: now } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        currency: true,
        weeklySummaryEmail: true,
        weeklySummaryDay: true,
      },
      take: 50,
    }),
    prisma.shop.findMany({
      where: {
        uninstalledAt: null,
        anomalyAlertsEnabled: true,
        OR: [
          { lastAnomalyCheckAt: null },
          { lastAnomalyCheckAt: { lte: new Date(now.getTime() - DAY_MS) } },
        ],
      },
      select: { id: true, name: true, email: true, currency: true },
      take: 50,
    }),
  ]);
  for (const shop of weeklyShops) await queueWeeklySummary(shop, now);
  for (const shop of anomalyShops) await detectAndQueueAnomalies(shop, now);
}

async function leaseNotification(now = new Date()) {
  for (let contention = 0; contention < 8; contention += 1) {
    const candidate = await prisma.merchantNotification.findFirst({
      where: {
        status: { in: [MerchantNotificationStatus.PENDING, MerchantNotificationStatus.SENDING] },
        availableAt: { lte: now },
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    });
    if (!candidate) return null;
    const leaseToken = crypto.randomUUID();
    const claimed = await prisma.merchantNotification.updateMany({
      where: {
        id: candidate.id,
        status: { in: [MerchantNotificationStatus.PENDING, MerchantNotificationStatus.SENDING] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        status: MerchantNotificationStatus.SENDING,
        attempts: { increment: 1 },
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      },
    });
    if (claimed.count === 1) return { ...candidate, leaseToken };
  }
  return null;
}

async function deliverOne(): Promise<boolean> {
  const notification = await leaseNotification();
  if (!notification) return false;
  try {
    const rendered =
      notification.kind === MerchantNotificationKind.WEEKLY_SUMMARY
        ? renderWeeklySummary(notification.payload as unknown as WeeklySummaryPayload)
        : renderAnomalyAlert(notification.payload as unknown as AnomalyPayload);
    await sendEmail({
      to: notification.recipient,
      subject: notification.subject,
      text: rendered.text,
      html: rendered.html,
      idempotencyKey: notification.dedupeKey,
    });
    await prisma.$transaction([
      prisma.merchantNotification.updateMany({
        where: { id: notification.id, leaseToken: notification.leaseToken },
        data: {
          status: MerchantNotificationStatus.SENT,
          sentAt: new Date(),
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      }),
      ...(notification.kind === MerchantNotificationKind.WEEKLY_SUMMARY
        ? [
            prisma.shop.update({
              where: { id: notification.shopId },
              data: { lastWeeklySummaryAt: new Date(), lastWeeklySummaryError: null },
            }),
          ]
        : []),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1_000) : "Unknown delivery error";
    const terminal = notification.attempts + 1 >= MAX_ATTEMPTS;
    await prisma.$transaction([
      prisma.merchantNotification.updateMany({
        where: { id: notification.id, leaseToken: notification.leaseToken },
        data: {
          status: terminal ? MerchantNotificationStatus.FAILED : MerchantNotificationStatus.PENDING,
          availableAt: new Date(Date.now() + 2 ** notification.attempts * 60_000),
          error: message,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      }),
      ...(notification.kind === MerchantNotificationKind.WEEKLY_SUMMARY
        ? [
            prisma.shop.update({
              where: { id: notification.shopId },
              data: { lastWeeklySummaryError: message },
            }),
          ]
        : []),
    ]);
  }
  return true;
}

interface NotificationState {
  timer?: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __meridianMerchantNotifications: NotificationState | undefined;
}

const state = (globalThis.__meridianMerchantNotifications ??= {});

function beginNotificationSweep(): void {
  if (state.inFlight) return;
  const work = queueDueWork()
    .then(async () => {
      for (let sent = 0; sent < 20 && (await deliverOne()); sent += 1) {
        // bounded drain
      }
    })
    .catch((error) => console.error("[merchant-notifications] sweep failed", error))
    .finally(() => {
      if (state.inFlight === work) state.inFlight = undefined;
    });
  state.inFlight = work;
}

export function startMerchantNotificationScheduler(intervalMs = POLL_MS): void {
  if (state.timer) return;
  beginNotificationSweep();
  state.timer = setInterval(beginNotificationSweep, intervalMs);
  state.timer.unref?.();
}

export function stopMerchantNotificationScheduler(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
}

export async function purgeOldMerchantNotifications(
  now = new Date(),
  retentionDays = 90,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const deleted = await prisma.merchantNotification.deleteMany({
    where: {
      status: { in: [MerchantNotificationStatus.SENT, MerchantNotificationStatus.FAILED] },
      createdAt: { lt: cutoff },
    },
  });
  return deleted.count;
}
