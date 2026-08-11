import {
  Prisma,
  type Customer,
  type Fulfillment,
  type Order,
  type OrderLineItem,
} from "@prisma/client";

import prisma from "~/db.server";
import { withCustomerErasureLock } from "~/lib/customer-erasure.server";
import {
  normaliseWebhookTopic,
  payloadReferencesCustomer,
  type CustomerReference,
} from "~/lib/webhook-payload.server";

/**
 * Servicing `customers/data_request`.
 *
 * Shopify's rule is that the app hands the export to the *merchant*, who is the
 * controller and answers the shopper, within 30 days. The app is a processor and
 * must not open its own channel to the data subject — so nothing here emails a
 * customer. The export is stored and surfaced in Settings for the merchant to
 * collect.
 *
 * The export is a second copy of a shopper's personal data. It therefore expires
 * on its own (below), and `customers/redact` deletes any copy still held.
 */

/** Shopify gives the merchant 30 days to answer; the export outlives that by a day. */
export const DATA_REQUEST_RETENTION_DAYS = 31;

/** Collected history is bounded per page; active obligations are never capped. */
export const DATA_REQUEST_HISTORY_PAGE_SIZE = 25;

type CustomerWithOrders = Customer & {
  orders: (Order & {
    lineItems: OrderLineItem[];
    fulfillments: Fulfillment[];
  })[];
};

export interface CustomerExport {
  shop: string;
  requestedAt: string;
  customer: {
    id: string;
    shopId: string;
    shopifyId: string;
    email: string | null;
    firstOrderAt: string | null;
    acquisitionChannel: string;
    acquisitionCampaignId: string | null;
    ordersCount: number;
    lifetimeRevenue: string;
    lifetimeProfit: string;
  } | null;
  orders: {
    id: string;
    shopId: string;
    shopifyId: string;
    shopifyUpdatedAt: string | null;
    orderNumber: number;
    processedAt: string;
    customerId: string | null;
    currency: string;
    subtotal: string;
    discountTotal: string;
    shippingCharged: string;
    taxTotal: string;
    total: string;
    refundedTotal: string;
    financialStatus: string;
    fulfillmentStatus: string;
    channel: string;
    campaignId: string | null;
    campaignName: string | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    landingSite: string | null;
    isFirstOrder: boolean;
    cogsTotal: string;
    shippingCost: string;
    paymentFee: string;
    adCostAttributed: string;
    overheadAllocated: string;
    contributionProfit: string;
    netProfit: string;
    computedAt: string | null;
    lineItems: {
      id: string;
      shopId: string;
      orderId: string;
      shopifyId: string;
      variantId: string | null;
      productId: string | null;
      title: string;
      sku: string | null;
      quantity: number;
      unitPrice: string;
      discount: string;
      unitCost: string;
      refundedQty: number;
    }[];
    fulfillments: {
      id: string;
      shopId: string;
      orderId: string;
      shopifyId: string | null;
      shopifyUpdatedAt: string | null;
      status: string;
      createdAt: string;
      shippedAt: string | null;
      deliveredAt: string | null;
      carrier: string | null;
      serviceLevel: string | null;
      shippingCost: string;
      pickPackCost: string;
      itemCount: number;
      location: string;
    }[];
  }[];
  pendingWebhookData: PendingWebhookPersonalData[];
  note?: string;
}

export interface PendingWebhookPersonalData {
  topic: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

/**
 * Everything Meridian holds about one shopper, in the form the merchant gets.
 *
 * Decimal values are serialized as exact strings rather than passing through
 * JavaScript floats. The merchant may hand this to the shopper verbatim, and a
 * figure that disagrees with the stored ledger by a cent is a dispute.
 */
export function buildCustomerExport(
  shopDomain: string,
  customer: CustomerWithOrders | null,
  requestedAt: Date,
  pendingWebhookData: PendingWebhookPersonalData[] = [],
): CustomerExport {
  if (!customer) {
    return {
      shop: shopDomain,
      requestedAt: requestedAt.toISOString(),
      customer: null,
      orders: [],
      pendingWebhookData,
      note:
        pendingWebhookData.length === 0
          ? "No data held for this customer."
          : "No normalized customer row is held; transient minimized webhook recovery data is listed below.",
    };
  }

  return {
    shop: shopDomain,
    requestedAt: requestedAt.toISOString(),
    customer: {
      id: customer.id,
      shopId: customer.shopId,
      shopifyId: customer.shopifyId,
      email: customer.email,
      firstOrderAt: customer.firstOrderAt?.toISOString() ?? null,
      acquisitionChannel: customer.acquisitionChannel,
      acquisitionCampaignId: customer.acquisitionCampaignId,
      ordersCount: customer.ordersCount,
      lifetimeRevenue: String(customer.lifetimeRevenue),
      lifetimeProfit: String(customer.lifetimeProfit),
    },
    orders: customer.orders.map((order) => ({
      id: order.id,
      shopId: order.shopId,
      shopifyId: order.shopifyId,
      shopifyUpdatedAt: order.shopifyUpdatedAt?.toISOString() ?? null,
      orderNumber: order.orderNumber,
      processedAt: order.processedAt.toISOString(),
      customerId: order.customerId,
      currency: order.currency,
      subtotal: String(order.subtotal),
      discountTotal: String(order.discountTotal),
      shippingCharged: String(order.shippingCharged),
      taxTotal: String(order.taxTotal),
      total: String(order.total),
      refundedTotal: String(order.refundedTotal),
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      channel: order.channel,
      campaignId: order.campaignId,
      campaignName: order.campaignName,
      utmSource: order.utmSource,
      utmMedium: order.utmMedium,
      utmCampaign: order.utmCampaign,
      landingSite: order.landingSite,
      isFirstOrder: order.isFirstOrder,
      cogsTotal: String(order.cogsTotal),
      shippingCost: String(order.shippingCost),
      paymentFee: String(order.paymentFee),
      adCostAttributed: String(order.adCostAttributed),
      overheadAllocated: String(order.overheadAllocated),
      contributionProfit: String(order.contributionProfit),
      netProfit: String(order.netProfit),
      computedAt: order.computedAt?.toISOString() ?? null,
      lineItems: order.lineItems.map((item) => ({
        id: item.id,
        shopId: item.shopId,
        orderId: item.orderId,
        shopifyId: item.shopifyId,
        variantId: item.variantId,
        productId: item.productId,
        title: item.title,
        sku: item.sku,
        quantity: item.quantity,
        unitPrice: String(item.unitPrice),
        discount: String(item.discount),
        unitCost: String(item.unitCost),
        refundedQty: item.refundedQty,
      })),
      fulfillments: order.fulfillments.map((fulfillment) => ({
        id: fulfillment.id,
        shopId: fulfillment.shopId,
        orderId: fulfillment.orderId,
        shopifyId: fulfillment.shopifyId,
        shopifyUpdatedAt: fulfillment.shopifyUpdatedAt?.toISOString() ?? null,
        status: fulfillment.status,
        createdAt: fulfillment.createdAt.toISOString(),
        shippedAt: fulfillment.shippedAt?.toISOString() ?? null,
        deliveredAt: fulfillment.deliveredAt?.toISOString() ?? null,
        carrier: fulfillment.carrier,
        serviceLevel: fulfillment.serviceLevel,
        shippingCost: String(fulfillment.shippingCost),
        pickPackCost: String(fulfillment.pickPackCost),
        itemCount: fulfillment.itemCount,
        location: fulfillment.location,
      })),
    })),
    pendingWebhookData,
  };
}

/** Any transient minimized recovery payload still naming this shopper. */
export async function findPendingWebhookPersonalData(
  shopId: string,
  customer: CustomerReference,
  orderShopifyIds: string[] = [],
): Promise<PendingWebhookPersonalData[]> {
  const rows = await prisma.webhookEvent.findMany({
    where: {
      shopId,
      processedAt: null,
      payload: { not: Prisma.DbNull },
    },
    select: { topic: true, receivedAt: true, payload: true },
    orderBy: { receivedAt: "asc" },
  });

  const orderIds = new Set(
    orderShopifyIds.flatMap((id) => [
      id,
      id.replace(/^gid:\/\/shopify\/Order\//i, ""),
    ]),
  );

  return rows.flatMap((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    const belongsToCustomerOrder =
      payload &&
      (normaliseWebhookTopic(row.topic) === "FULFILLMENTS_CREATE" ||
        normaliseWebhookTopic(row.topic) === "FULFILLMENTS_UPDATE") &&
      payload.order_id !== undefined &&
      orderIds.has(String(payload.order_id));
    return payload &&
      (payloadReferencesCustomer(payload, customer) || belongsToCustomerOrder)
      ? [
          {
            topic: row.topic,
            receivedAt: row.receivedAt.toISOString(),
            payload,
          },
        ]
      : [];
  });
}

/**
 * Store an assembled export against Shopify's delivery id.
 *
 * Upsert rather than create: Shopify retries a delivery it did not hear 200 for,
 * and two rows for one request would show the merchant the same shopper twice
 * and leave a copy behind when they collect the other.
 */
export async function recordDataRequest(input: {
  shopId: string;
  webhookId: string;
  shopifyCustomerId: string;
  customerEmail: string | null;
  report: CustomerExport;
  requestedAt: Date;
}) {
  const expiresAt = new Date(
    input.requestedAt.getTime() + DATA_REQUEST_RETENTION_DAYS * 86_400_000,
  );

  const data = {
    shopId: input.shopId,
    shopifyCustomerId: input.shopifyCustomerId,
    customerEmail: input.customerEmail,
    requestedAt: input.requestedAt,
    ordersIncluded: input.report.orders.length,
    report: input.report as unknown as object,
    expiresAt,
  };

  return withCustomerErasureLock(
    input.shopId,
    // Shopify's stable id is authoritative. Locking on email as well would let
    // customer A's erasure suppress customer B's valid access report when the
    // two customer records share or later reuse an address.
    { id: input.shopifyCustomerId },
    async (tx, { erased }) => {
      // An access request already executing when customers/redact committed
      // must not recreate a second copy of the just-erased data.
      let storedData = data;
      if (erased) {
        // The request still needs a response artifact, whether it raced the
        // redaction or arrived later. Store a de-identified empty response:
        // neither the raw Shopify id/email nor erased rows are recreated.
        storedData = {
          ...data,
          shopifyCustomerId: "redacted-request",
          customerEmail: null,
          ordersIncluded: 0,
          report: {
            shop: input.report.shop,
            requestedAt: input.report.requestedAt,
            customer: null,
            orders: [],
            pendingWebhookData: [],
            note: "No normalized customer data is held. Purpose-limited keyed erasure guards remain until the store is erased.",
          },
        };
      }
      return tx.dataRequest.upsert({
        where: { webhookId: input.webhookId },
        create: { webhookId: input.webhookId, ...storedData },
        // A retry carries the same customer; re-assembling picks up any order
        // that landed in between, so the newer report wins. requestedAt and
        // expiresAt are intentionally immutable: recovery cannot restart the
        // 31-day retention clock.
        update: {
          shopifyCustomerId: storedData.shopifyCustomerId,
          customerEmail: storedData.customerEmail,
          ordersIncluded: storedData.ordersIncluded,
          report: storedData.report,
        },
      });
    },
  );
}

/** Drop every export past its retention date, collected or not. */
export async function purgeExpiredDataRequests(now = new Date()) {
  const { count } = await prisma.dataRequest.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  return count;
}

/**
 * Erasure has to reach the exports too.
 *
 * `customers/redact` deletes the Customer row, so an export assembled from an
 * earlier `data_request` would be the only remaining copy of exactly the data
 * the shopper asked to have removed. Matched on Shopify's id in both the raw and
 * gid forms, because that is how the rest of the app has to match it.
 */
export async function deleteDataRequestsForCustomer(
  shopId: string,
  shopifyCustomerId: string | number,
) {
  const { count } = await prisma.dataRequest.deleteMany({
    where: {
      shopId,
      shopifyCustomerId: {
        in: [
          String(shopifyCustomerId),
          `gid://shopify/Customer/${shopifyCustomerId}`,
        ],
      },
    },
  });
  return count;
}

export interface DataRequestSummary {
  id: string;
  shopifyCustomerId: string;
  customerEmail: string | null;
  requestedAt: Date;
  ordersIncluded: number;
  collectedAt: Date | null;
  expiresAt: Date;
}

export interface DataRequestList {
  /** Every live legal obligation, without a display cap. */
  outstanding: DataRequestSummary[];
  /** Collected rows are audit history and are deliberately paginated. */
  history: DataRequestSummary[];
  historyPage: number;
  historyPageCount: number;
  collectedTotal: number;
}

export interface ListDataRequestsOptions {
  now?: Date;
  historyPage?: number;
}

const DATA_REQUEST_SUMMARY_SELECT = {
  id: true,
  shopifyCustomerId: true,
  customerEmail: true,
  requestedAt: true,
  ordersIncluded: true,
  collectedAt: true,
  expiresAt: true,
} as const;

function requestedHistoryPage(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) return 1;
  return value!;
}

/**
 * What Privacy requests shows. Purges first, so an expired export is never
 * listed as collectable — the list and the retention promise cannot disagree.
 */
export async function listDataRequests(
  shopId: string,
  options: ListDataRequestsOptions = {},
): Promise<DataRequestList> {
  const now = options.now ?? new Date();
  await purgeExpiredDataRequests(now);

  const collectedTotal = await prisma.dataRequest.count({
    where: { shopId, collectedAt: { not: null } },
  });
  const historyPageCount = Math.max(
    1,
    Math.ceil(collectedTotal / DATA_REQUEST_HISTORY_PAGE_SIZE),
  );
  const historyPage = Math.min(
    requestedHistoryPage(options.historyPage),
    historyPageCount,
  );

  const [outstanding, history] = await Promise.all([
    prisma.dataRequest.findMany({
      where: { shopId, collectedAt: null },
      // Oldest first: the request closest to its response deadline leads.
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      select: DATA_REQUEST_SUMMARY_SELECT,
    }),
    prisma.dataRequest.findMany({
      where: { shopId, collectedAt: { not: null } },
      orderBy: [{ collectedAt: "desc" }, { id: "desc" }],
      skip: (historyPage - 1) * DATA_REQUEST_HISTORY_PAGE_SIZE,
      take: DATA_REQUEST_HISTORY_PAGE_SIZE,
      select: DATA_REQUEST_SUMMARY_SELECT,
    }),
  ]);

  return {
    outstanding,
    history,
    historyPage,
    historyPageCount,
    collectedTotal,
  };
}

/**
 * Fetch an export for the authenticated download resource and stamp collection.
 *
 * The conditional stamp and report read share one transaction. An expired or
 * cross-shop row cannot be returned; the first collection timestamp is
 * immutable even when the merchant downloads again.
 */
export async function collectDataRequestForDownload(
  shopId: string,
  id: string,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    await tx.dataRequest.updateMany({
      where: { id, shopId, collectedAt: null, expiresAt: { gt: now } },
      data: { collectedAt: now },
    });

    return tx.dataRequest.findFirst({
      where: { id, shopId, expiresAt: { gt: now } },
      select: { report: true, requestedAt: true },
    });
  });
}
