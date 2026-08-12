import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { reconcileConnectedCarriersForShop } from "~/integrations/shipping.server";
import { planIdForSubscriptionName } from "~/lib/billing.server";
import {
  buildCustomerExport,
  findPendingWebhookPersonalData,
  recordDataRequest,
} from "~/lib/data-request.server";
import { redactCustomerEverywhere } from "~/lib/customer-erasure.server";
import { ANNUAL_SUFFIX } from "~/lib/plans";
import { capabilitiesForShop, parseScopes } from "~/lib/scopes";
import { synchroniseShopifyShippingConnector } from "~/lib/provision.server";
import {
  adminClientForShop,
  hydrateInventoryItemProducts,
  hydrateOrderVariantProducts,
  hydrateProductWebhook,
} from "~/lib/shopify-catalog.server";
import {
  syncFulfillmentFromShopify,
  syncOrderFromShopify,
  syncProductFromShopify,
} from "~/lib/sync.server";
import {
  billSoftOrderOverage,
  recordOrderUsage,
} from "~/lib/usage-meter.server";
import type { WebhookContext } from "~/lib/webhooks.server";

/** Shared by orders/create, orders/updated and refunds/create. */
export async function processOrdersWebhook({
  shopDomain,
  payload,
  topic,
}: WebhookContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  // refunds/create is a bare Refund, not an Order. Its authoritative financial
  // effect arrives in orders/updated; syncing it here creates a phantom order.
  if (topic === "REFUNDS_CREATE") {
    invalidateAnalyticsCache();
    return;
  }

  const variantIds = (
    Array.isArray(payload.line_items) ? payload.line_items : []
  )
    .map((item: Record<string, unknown>) => item.variant_id)
    .filter(
      (id: unknown): id is string | number =>
        typeof id === "string" || typeof id === "number",
    )
    .map(String);
  if (variantIds.length > 0) {
    const admin = await adminClientForShop(shopDomain);
    const includeCost = capabilitiesForShop(
      shop,
      process.env.SCOPES,
    ).inventoryCost;
    const products = await hydrateOrderVariantProducts(
      admin,
      variantIds,
      includeCost,
    );
    for (const product of products) {
      await syncProductFromShopify(shop.id, product);
    }
  }

  await syncOrderFromShopify(shop.id, payload);
  const orderId = payload.id ?? payload.admin_graphql_api_id;
  if (typeof orderId === "string" || typeof orderId === "number") {
    const usage = await recordOrderUsage(
      shop.id,
      `order:${shop.id}:${String(orderId)}`,
    );
    if (usage.status === "soft_overage" || usage.status === "cap_reached") {
      try {
        await billSoftOrderOverage(shopDomain, usage.meterId);
      } catch (error) {
        // Soft overage must never turn a valid order delivery into a retry. The
        // meter remains visible and Shopify billing can be retried on the next
        // threshold batch.
        console.error(
          "[billing] soft overage charge deferred for %s:",
          shopDomain,
          error,
        );
      }
    }
  }
  invalidateAnalyticsCache();
}

function dateOrNow(value: unknown): Date {
  if (typeof value === "string" || value instanceof Date) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** Store only a safe checkout projection; no Admin API round trip is needed. */
export async function processCheckoutsWebhook({
  shopDomain,
  payload,
}: WebhookContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  const token = payload.token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("checkout webhook omitted its token");
  }

  const shopifyUpdatedAt = dateOrNow(payload.updated_at);
  const existing = await prisma.checkout.findUnique({
    where: { shopId_token: { shopId: shop.id, token } },
    select: { shopifyUpdatedAt: true },
  });
  if (existing && existing.shopifyUpdatedAt >= shopifyUpdatedAt) return;

  const lineItems = Array.isArray(payload.line_items)
    ? payload.line_items.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  const totalQuantity = lineItems.reduce((sum, item) => {
    const quantity = Number(item.quantity ?? 0);
    return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0);
  }, 0);

  await prisma.checkout.upsert({
    where: { shopId_token: { shopId: shop.id, token } },
    create: {
      shopId: shop.id,
      token,
      cartToken:
        typeof payload.cart_token === "string" ? payload.cart_token : null,
      currency:
        typeof payload.currency === "string" ? payload.currency : shop.currency,
      total:
        typeof payload.total_price === "string" ||
        typeof payload.total_price === "number"
          ? String(payload.total_price)
          : "0",
      lineCount: lineItems.length,
      totalQuantity,
      status: payload.completed_at ? "completed" : "open",
      createdAt: dateOrNow(payload.created_at),
      shopifyUpdatedAt,
      completedAt: payload.completed_at
        ? dateOrNow(payload.completed_at)
        : null,
    },
    update: {
      cartToken:
        typeof payload.cart_token === "string" ? payload.cart_token : null,
      currency:
        typeof payload.currency === "string" ? payload.currency : shop.currency,
      total:
        typeof payload.total_price === "string" ||
        typeof payload.total_price === "number"
          ? String(payload.total_price)
          : "0",
      lineCount: lineItems.length,
      totalQuantity,
      status: payload.completed_at ? "completed" : "open",
      shopifyUpdatedAt,
      completedAt: payload.completed_at
        ? dateOrNow(payload.completed_at)
        : null,
    },
  });
}

export async function processProductsWebhook({
  shopDomain,
  payload,
}: WebhookContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  const admin = await adminClientForShop(shopDomain);
  const hydrated = await hydrateProductWebhook(
    admin,
    payload,
    capabilitiesForShop(shop, process.env.SCOPES).inventoryCost,
  );
  await syncProductFromShopify(shop.id, hydrated);
  invalidateAnalyticsCache();
}

/** Keep the current cost basis fresh when a merchant edits an inventory item. */
export async function processInventoryItemsWebhook({
  shopDomain,
  payload,
}: WebhookContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  const capabilities = capabilitiesForShop(shop, process.env.SCOPES);
  if (!capabilities.inventoryCost) return;
  const inventoryItemId = payload.id;
  if (
    typeof inventoryItemId !== "string" &&
    typeof inventoryItemId !== "number"
  ) {
    throw new Error("inventory_items/update omitted its inventory item id");
  }

  const admin = await adminClientForShop(shopDomain);
  const products = await hydrateInventoryItemProducts(
    admin,
    String(inventoryItemId),
    true,
  );
  for (const product of products) {
    await syncProductFromShopify(shop.id, product);
  }
  invalidateAnalyticsCache();
}

export async function processFulfillmentsWebhook({
  shopDomain,
  payload,
}: WebhookContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  await syncFulfillmentFromShopify(shop.id, payload);
  // Shopify's fulfillment signal gives the reports API an immediate chance to
  // surface a newly purchased label. Provider outages remain isolated here;
  // the five-minute reconciliation sweep is the durable fallback.
  await reconcileConnectedCarriersForShop(shop.id);
  invalidateAnalyticsCache();
}

export async function processAppUninstalledWebhook({
  shopDomain,
}: WebhookContext): Promise<void> {
  await prisma.session.deleteMany({ where: { shop: shopDomain } });
  await prisma.shop.updateMany({
    where: { domain: shopDomain },
    data: { uninstalledAt: new Date() },
  });
  await prisma.subscription.updateMany({
    where: { shop: { domain: shopDomain } },
    data: { plan: "none", status: "cancelled" },
  });
  await prisma.usageMeter.updateMany({
    where: { shop: { domain: shopDomain } },
    data: { status: "suspended" },
  });
  console.info(`[app] uninstalled from ${shopDomain}; sessions cleared`);
}

/**
 * A development store can be converted to a paid merchant store. Shopify
 * recommends SHOP_UPDATE as the invalidation signal; the next charge request
 * then re-reads ShopPlan.partnerDevelopment before deciding test versus real.
 */
export async function processShopUpdateWebhook({
  shopDomain,
}: WebhookContext): Promise<void> {
  await prisma.shop.updateMany({
    where: { domain: shopDomain },
    data: { partnerDevelopment: null },
  });
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "accepted"]);

interface AppSubscriptionPayload {
  admin_graphql_api_id?: string;
  name?: string;
  status?: string;
  trial_ends_on?: string | null;
  billing_on?: string | null;
}

export async function processAppSubscriptionsWebhook({
  shopDomain,
  payload,
  webhookId,
  topic,
}: WebhookContext): Promise<void> {
  if (topic === "APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT") {
    await prisma.usageMeter.updateMany({
      where: { shop: { domain: shopDomain }, metric: "orders" },
      data: { status: "cap_reached", capWarningNotifiedAt: new Date() },
    });
    return;
  }

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  const sub = (payload.app_subscription ?? {}) as AppSubscriptionPayload;
  const status = (sub.status ?? "").toLowerCase();
  const isActive = ACTIVE_SUBSCRIPTION_STATUSES.has(status);
  const planId = planIdForSubscriptionName(sub.name);

  if (isActive && !planId) {
    console.error(
      `[billing] active subscription "${sub.name}" for ${shopDomain} matches no known plan`,
    );
  }

  const interval = (sub.name ?? "").trim().toLowerCase().endsWith(ANNUAL_SUFFIX)
    ? "annual"
    : "monthly";
  const data = {
    plan: isActive && planId ? planId : "none",
    interval,
    status: status || "unknown",
    shopifyChargeId: sub.admin_graphql_api_id ?? null,
    trialEndsAt: sub.trial_ends_on ? new Date(sub.trial_ends_on) : null,
    currentPeriodEnd: sub.billing_on ? new Date(sub.billing_on) : null,
  };

  await prisma.subscription.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, ...data },
    update: data,
  });
  await prisma.subscriptionEvent.upsert({
    where: { webhookId },
    create: {
      webhookId,
      shopId: shop.id,
      name: sub.name ?? "",
      plan: data.plan,
      interval,
      status: data.status,
    },
    // A recovered delivery represents the same transition. Current state was
    // already upserted above; immutable history must not append or mutate.
    update: {},
  });
  console.info(
    `[billing] ${shopDomain}: subscription "${sub.name}" -> plan=${data.plan} status=${data.status}`,
  );
}

export async function processAppScopesUpdateWebhook({
  shopDomain,
  payload,
}: WebhookContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  const current = (payload.current ?? []) as string[] | string;
  const granted = Array.isArray(current) ? current.join(",") : String(current);
  if (granted === (shop.grantedScopes ?? "")) return;
  const orderHistoryAccessChanged =
    parseScopes(granted).has("read_all_orders") !==
    parseScopes(shop.grantedScopes).has("read_all_orders");

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      grantedScopes: granted || null,
      ...(orderHistoryAccessChanged
        ? {
            syncStatus: "PENDING",
            syncCompletedAt: null,
            syncStage: "Order-history access changed",
            hasAllOrdersScope: false,
          }
        : {}),
    },
  });
  await synchroniseShopifyShippingConnector(shop.id, granted);
  if (orderHistoryAccessChanged) {
    // Managed installation grants this scope without reinstalling. Claim the
    // new import from the webhook so a merchant does not need to discover and
    // press Re-import before lifetime history becomes truthful.
    const { requestBackfill } = await import("~/lib/backfill-queue.server");
    await requestBackfill(shop.id);
  }
  // Scope changes alter whether protected customer cohorts may be loaded, so
  // a warm analytics entry cannot survive the capability change.
  invalidateAnalyticsCache();
  console.info(
    `[scopes] ${shopDomain}: granted scopes are now "${granted}" ` +
      `(was "${shop.grantedScopes ?? ""}")`,
  );
}

export async function processCustomerDataRequestWebhook({
  shopDomain,
  payload,
  webhookId,
}: WebhookContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  const customerId = (payload.customer as { id?: number | string } | undefined)
    ?.id;
  if (
    customerId === undefined ||
    customerId === null ||
    String(customerId).trim() === ""
  ) {
    throw new Error(
      "customers/data_request payload is missing required customer.id",
    );
  }

  const customerEmail = (payload.customer as { email?: string } | undefined)
    ?.email;

  const customer = await prisma.customer.findFirst({
    where: {
      shopId: shop.id,
      OR: [
        { shopifyId: `gid://shopify/Customer/${customerId}` },
        { shopifyId: String(customerId) },
      ],
    },
    include: {
      orders: {
        include: {
          lineItems: true,
          fulfillments: true,
          taxComponents: true,
          shippingCostObservations: true,
        },
        orderBy: { processedAt: "asc" },
      },
    },
  });
  const delivery = await prisma.webhookEvent.findUnique({
    where: { webhookId },
    select: { receivedAt: true },
  });
  // Immutable delivery time, not retry/worker time. A recovered request must
  // never restart its 31-day retention clock.
  const requestedAt = delivery?.receivedAt ?? new Date();
  const pendingWebhookData = await findPendingWebhookPersonalData(
    shop.id,
    {
      id: customerId,
      email: customerEmail,
    },
    customer?.orders.map((order) => order.shopifyId) ?? [],
  );
  const report = buildCustomerExport(
    shopDomain,
    customer,
    requestedAt,
    pendingWebhookData,
  );

  await recordDataRequest({
    shopId: shop.id,
    webhookId,
    shopifyCustomerId: customer?.shopifyId ?? String(customerId),
    customerEmail: customer?.email ?? customerEmail ?? null,
    report,
    requestedAt,
  });
  await prisma.webhookEvent.update({
    where: { webhookId },
    data: { error: null },
  });
  console.info(
    `[gdpr] data request for ${shopDomain}: ${
      customer
        ? `${report.orders.length} orders assembled, awaiting collection`
        : "no data held"
    }`,
  );
}

export async function processCustomersRedactWebhook({
  shopDomain,
  payload,
  webhookId,
}: WebhookContext): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;

  const customerId = (payload.customer as { id?: number | string } | undefined)
    ?.id;
  if (
    customerId === undefined ||
    customerId === null ||
    String(customerId).trim() === ""
  ) {
    throw new Error("customers/redact payload is missing required customer.id");
  }
  const customerEmail = (payload.customer as { email?: string } | undefined)
    ?.email;
  const result = await redactCustomerEverywhere({
    shopId: shop.id,
    webhookId,
    customer: { id: customerId, email: customerEmail },
  });
  console.info(
    `[gdpr] redacted customer data for ${shopDomain}; ` +
      `${result.customerId ? "normalized customer deleted; " : "no normalized customer row; "}` +
      `${result.exportsRemoved} held data export(s) deleted; ` +
      `${result.queuedPayloadsScrubbed} recovery payload(s) scrubbed`,
  );
}

export async function processShopRedactWebhook({
  shopDomain,
}: WebhookContext): Promise<void> {
  await prisma.session.deleteMany({ where: { shop: shopDomain } });

  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (shop) {
    // Keep the delivery until the owner deletion succeeds. The cascade then
    // removes this payload and every other delivery owned by the shop.
    await prisma.shop.delete({ where: { id: shop.id } });
  }
  await prisma.webhookEvent.deleteMany({ where: { shopDomain } });
  if (!shop) return;

  console.info(`[gdpr] purged all data for ${shopDomain}`);
}
