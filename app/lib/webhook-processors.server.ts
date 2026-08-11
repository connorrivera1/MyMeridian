import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { planIdForSubscriptionName } from "~/lib/billing.server";
import {
  buildCustomerExport,
  findPendingWebhookPersonalData,
  recordDataRequest,
} from "~/lib/data-request.server";
import { redactCustomerEverywhere } from "~/lib/customer-erasure.server";
import { ANNUAL_SUFFIX } from "~/lib/plans";
import { capabilitiesForShop } from "~/lib/scopes";
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
  invalidateAnalyticsCache();
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
}: WebhookContext): Promise<void> {
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

  await prisma.shop.update({
    where: { id: shop.id },
    data: { grantedScopes: granted || null },
  });
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
        include: { lineItems: true, fulfillments: true },
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
