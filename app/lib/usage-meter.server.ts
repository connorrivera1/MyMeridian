import { Prisma } from "@prisma/client";

import prisma from "~/db.server";
import {
  adminClientForShop,
  type AdminGraphqlClient,
} from "~/lib/shopify-catalog.server";
import { USAGE_CAP_AMOUNT, USAGE_TERMS } from "~/lib/plans";

export const ORDER_USAGE_METRIC = "orders";
export const OVERAGE_UNIT_PRICE = 0.05;
export { USAGE_CAP_AMOUNT, USAGE_TERMS };
export const USAGE_CHARGE_BATCH_UNITS = 100;

export type UsageMeterStatus =
  | "under_limit"
  | "soft_overage"
  | "cap_reached"
  | "suspended";

interface MeterPolicy {
  softLimit: number;
  hardLimit: number;
}

const DEFAULT_METER_POLICY: MeterPolicy = {
  softLimit: 1_000,
  hardLimit: 1_200,
};

const POLICY_BY_PLAN: Record<string, MeterPolicy> = {
  starter: DEFAULT_METER_POLICY,
  growth: { softLimit: 5_000, hardLimit: 6_000 },
  scale: { softLimit: 20_000, hardLimit: 24_000 },
};

export function meterPolicyForPlan(planName: string | null | undefined): MeterPolicy {
  return POLICY_BY_PLAN[planName ?? "starter"] ?? DEFAULT_METER_POLICY;
}

export function usageMeterStatus(
  used: number,
  softLimit: number,
  hardLimit: number,
): UsageMeterStatus {
  if (used >= hardLimit) return "cap_reached";
  if (used > softLimit) return "soft_overage";
  return "under_limit";
}

function utcMonthBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    start,
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export interface UsageRecordResult {
  counted: boolean;
  meterId: string;
  used: number;
  status: UsageMeterStatus;
  crossedSoftLimit: boolean;
}

function isRetryableTransactionError(error: unknown): boolean {
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : (error as { code?: unknown } | null)?.code;
  return code === "P2034" || code === "P2002";
}

/**
 * Count one business event exactly once. The unique source id handles both
 * Shopify retries and multiple topics describing the same order.
 */
export async function recordOrderUsage(
  shopId: string,
  sourceId: string,
  now = new Date(),
): Promise<UsageRecordResult> {
  const { start, end } = utcMonthBounds(now);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
    const shop = await tx.shop.findUnique({
      where: { id: shopId },
      select: {
        planName: true,
        uninstalledAt: true,
        subscription: { select: { plan: true } },
      },
    });
    if (!shop) throw new Error(`Cannot meter usage for unknown shop ${shopId}`);

    const policy = meterPolicyForPlan(shop.subscription?.plan ?? shop.planName);
    const meter = await tx.usageMeter.upsert({
      where: {
        shopId_metric_periodStart: {
          shopId,
          metric: ORDER_USAGE_METRIC,
          periodStart: start,
        },
      },
      create: {
        shopId,
        metric: ORDER_USAGE_METRIC,
        periodStart: start,
        periodEnd: end,
        softLimit: policy.softLimit,
        hardLimit: policy.hardLimit,
        status: shop.uninstalledAt ? "suspended" : "under_limit",
      },
      update: {},
    });

    try {
      await tx.usageMeterEvent.create({
        data: {
          shopId,
          meterId: meter.id,
          source: "order",
          sourceId,
        },
      });
    } catch (error) {
      if (
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002") ||
        ((error as { code?: unknown } | null)?.code === "P2002")
      ) {
        return {
          counted: false,
          meterId: meter.id,
          used: meter.used,
          status: meter.status as UsageMeterStatus,
          crossedSoftLimit: false,
        };
      }
      throw error;
    }

    const updated = await tx.usageMeter.update({
      where: { id: meter.id },
      data: {
        used: { increment: 1 },
      },
    });

    const used = updated.used;
    const status = shop.uninstalledAt
      ? "suspended"
      : usageMeterStatus(used, meter.softLimit, meter.hardLimit);
    const crossedSoftLimit = used === meter.softLimit + 1;
    const statusWhere = shop.uninstalledAt
      ? { id: meter.id }
      : used >= meter.hardLimit
        ? { id: meter.id, used: { gte: meter.hardLimit } }
        : used > meter.softLimit
          ? {
              id: meter.id,
              used: { gt: meter.softLimit, lt: meter.hardLimit },
            }
          : { id: meter.id, used: { lte: meter.softLimit } };
    await tx.usageMeter.updateMany({
      where: statusWhere,
      data: {
        status,
        ...(used > meter.softLimit && !meter.overageNotifiedAt
          ? { overageNotifiedAt: now }
          : {}),
        ...(used >= meter.hardLimit && !meter.capWarningNotifiedAt
          ? { capWarningNotifiedAt: now }
          : {}),
      },
    });

        return {
          counted: true,
          meterId: updated.id,
          used: updated.used,
          status: updated.status as UsageMeterStatus,
          crossedSoftLimit,
        };
      });
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt < 7) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(50, 2 ** attempt)),
        );
        continue;
      }
      throw error;
    }
  }

  throw new Error("Usage meter transaction was not completed");
}

interface UsageLineItem {
  id: string;
  pricingDetails: {
    cappedAmount: { amount: string; currencyCode: string };
    balanceUsed: { amount: string; currencyCode: string };
  };
}

interface ActiveSubscription {
  status: string;
  lineItems: Array<{ id: string; plan: { pricingDetails: UsageLineItem["pricingDetails"] | null } }>;
}

const USAGE_SUBSCRIPTION_QUERY = `#graphql
  query MeridianUsageSubscription {
    currentAppInstallation {
      activeSubscriptions {
        status
        lineItems {
          id
          plan {
            pricingDetails {
              ... on AppUsagePricing {
                cappedAmount { amount currencyCode }
                balanceUsed { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

const USAGE_RECORD_MUTATION = `#graphql
  mutation MeridianUsageRecord(
    $description: String!
    $price: MoneyInput!
    $subscriptionLineItemId: ID!
    $idempotencyKey: String
  ) {
    appUsageRecordCreate(
      description: $description
      price: $price
      subscriptionLineItemId: $subscriptionLineItemId
      idempotencyKey: $idempotencyKey
    ) {
      appUsageRecord { id }
      userErrors { field message }
    }
  }
`;

async function graphqlJson<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message ?? "Shopify GraphQL error").join("; "));
  }
  if (!body.data) throw new Error("Shopify GraphQL returned no data");
  return body.data;
}

async function findUsageLineItem(admin: AdminGraphqlClient): Promise<UsageLineItem | null> {
  const data = await graphqlJson<{
    currentAppInstallation?: { activeSubscriptions?: ActiveSubscription[] };
  }>(admin, USAGE_SUBSCRIPTION_QUERY);
  for (const subscription of data.currentAppInstallation?.activeSubscriptions ?? []) {
    if (subscription.status !== "ACTIVE") continue;
    for (const lineItem of subscription.lineItems) {
      if (lineItem.plan.pricingDetails) {
        return { id: lineItem.id, pricingDetails: lineItem.plan.pricingDetails };
      }
    }
  }
  return null;
}

/**
 * Charge only batched soft overage. A missing usage line item is not fatal:
 * recurring-only legacy subscriptions keep working, while new usage-enabled
 * subscriptions communicate with Shopify using an idempotent mutation.
 */
export async function billSoftOrderOverage(
  shopDomain: string,
  meterId: string,
): Promise<{ billedUnits: number; skipped: boolean }> {
  const meter = await prisma.usageMeter.findUnique({ where: { id: meterId } });
  if (!meter || meter.status === "suspended" || meter.used <= meter.softLimit) {
    return { billedUnits: 0, skipped: true };
  }

  const pendingUnits = meter.used - meter.softLimit - meter.billedUnits;
  if (pendingUnits < USAGE_CHARGE_BATCH_UNITS && !meter.capWarningNotifiedAt) {
    return { billedUnits: 0, skipped: true };
  }
  const units = Math.min(
    Math.max(pendingUnits, 0),
    USAGE_CHARGE_BATCH_UNITS,
  );
  if (units <= 0) return { billedUnits: 0, skipped: true };

  const admin = await adminClientForShop(shopDomain);
  const usageLineItem = await findUsageLineItem(admin);
  if (!usageLineItem) {
    await prisma.usageMeter.update({
      where: { id: meterId },
      data: {
        billingError: "Active Shopify subscription has no usage pricing line item",
        lastBillingAttemptAt: new Date(),
        billingAttempts: { increment: 1 },
      },
    });
    return { billedUnits: 0, skipped: true };
  }

  const remainingCap =
    Number(usageLineItem.pricingDetails.cappedAmount.amount) -
    Number(usageLineItem.pricingDetails.balanceUsed.amount);
  const chargeAmount = Math.min(units * OVERAGE_UNIT_PRICE, Math.max(remainingCap, 0));
  const chargeableUnits = Math.floor(chargeAmount / OVERAGE_UNIT_PRICE);
  if (chargeableUnits <= 0) {
    await prisma.usageMeter.update({
      where: { id: meterId },
      data: { status: "cap_reached", billingError: "Shopify usage cap reached" },
    });
    return { billedUnits: 0, skipped: true };
  }

  const targetBilledUnits = meter.billedUnits + chargeableUnits;
  const data = await graphqlJson<{
    appUsageRecordCreate: {
      appUsageRecord?: { id: string } | null;
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(admin, USAGE_RECORD_MUTATION, {
    description: `Meridian soft overage: ${chargeableUnits} orders above the monthly threshold`,
    price: {
      amount: Number(chargeAmount.toFixed(2)),
      currencyCode: usageLineItem.pricingDetails.cappedAmount.currencyCode,
    },
    subscriptionLineItemId: usageLineItem.id,
    idempotencyKey: `meridian:${meterId}:${targetBilledUnits}`,
  });
  const errors = data.appUsageRecordCreate.userErrors ?? [];
  if (errors.length > 0 || !data.appUsageRecordCreate.appUsageRecord?.id) {
    throw new Error(errors.map((error) => error.message).join("; ") || "Shopify did not return a usage record");
  }

  const claimed = await prisma.usageMeter.updateMany({
    where: { id: meterId, billedUnits: meter.billedUnits },
    data: {
      billedUnits: { increment: chargeableUnits },
      lastUsageRecordId: data.appUsageRecordCreate.appUsageRecord.id,
      billingError: null,
      lastBillingAttemptAt: new Date(),
      billingAttempts: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return { billedUnits: 0, skipped: true };
  return { billedUnits: chargeableUnits, skipped: false };
}
