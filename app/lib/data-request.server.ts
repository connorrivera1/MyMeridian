import type { Customer, Order, OrderLineItem } from "@prisma/client";

import prisma from "~/db.server";
import { centsToDollars, toCents } from "~/engine/money";

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

/** Never render more than this on Settings — the rest are expired or collected. */
const LIST_LIMIT = 25;

type CustomerWithOrders = Customer & {
  orders: (Order & { lineItems: OrderLineItem[] })[];
};

export interface CustomerExport {
  shop: string;
  requestedAt: string;
  customer: {
    shopifyId: string;
    email: string | null;
    firstOrderAt: Date | null;
    ordersCount: number;
    lifetimeRevenue: number;
    acquisitionChannel: string;
  } | null;
  orders: {
    orderNumber: number;
    processedAt: Date;
    total: number;
    items: { title: string; quantity: number; unitPrice: number }[];
  }[];
  note?: string;
}

/**
 * Everything Meridian holds about one shopper, in the form the merchant gets.
 *
 * Money is re-derived through cents rather than read off the Decimal, for the
 * same reason the engine does: the merchant may hand this to the shopper
 * verbatim, and a figure that disagrees with the order confirmation by a cent is
 * a dispute.
 */
export function buildCustomerExport(
  shopDomain: string,
  customer: CustomerWithOrders | null,
  requestedAt: Date,
): CustomerExport {
  if (!customer) {
    return {
      shop: shopDomain,
      requestedAt: requestedAt.toISOString(),
      customer: null,
      orders: [],
      note: "No data held for this customer.",
    };
  }

  return {
    shop: shopDomain,
    requestedAt: requestedAt.toISOString(),
    customer: {
      shopifyId: customer.shopifyId,
      email: customer.email,
      firstOrderAt: customer.firstOrderAt,
      ordersCount: customer.ordersCount,
      lifetimeRevenue: centsToDollars(toCents(customer.lifetimeRevenue)),
      acquisitionChannel: customer.acquisitionChannel,
    },
    orders: customer.orders.map((order) => ({
      orderNumber: order.orderNumber,
      processedAt: order.processedAt,
      total: centsToDollars(toCents(order.total)),
      items: order.lineItems.map((item) => ({
        title: item.title,
        quantity: item.quantity,
        unitPrice: centsToDollars(toCents(item.unitPrice)),
      })),
    })),
  };
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

  return prisma.dataRequest.upsert({
    where: { webhookId: input.webhookId },
    create: { webhookId: input.webhookId, ...data },
    // A retry carries the same customer; re-assembling picks up any order that
    // landed in between, so the newer report wins.
    update: data,
  });
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
  report: unknown;
}

/**
 * What Settings shows. Purges first, so an expired export is never listed as
 * collectable — the list and the retention promise cannot disagree.
 */
export async function listDataRequests(
  shopId: string,
  now = new Date(),
): Promise<DataRequestSummary[]> {
  await purgeExpiredDataRequests(now);

  const rows = await prisma.dataRequest.findMany({
    where: { shopId },
    orderBy: { requestedAt: "desc" },
    take: LIST_LIMIT,
  });

  return rows.map((row) => ({
    id: row.id,
    shopifyCustomerId: row.shopifyCustomerId,
    customerEmail: row.customerEmail,
    requestedAt: row.requestedAt,
    ordersIncluded: row.ordersIncluded,
    collectedAt: row.collectedAt,
    expiresAt: row.expiresAt,
    report: row.report,
  }));
}

/**
 * Stamp an export as collected.
 *
 * Scoped to the shop so an id from another store cannot be marked, and only the
 * first collection is recorded — the merchant may download it again, but the
 * audit trail should say when they first had it.
 */
export async function markDataRequestCollected(
  shopId: string,
  id: string,
  now = new Date(),
) {
  const { count } = await prisma.dataRequest.updateMany({
    where: { id, shopId, collectedAt: null },
    data: { collectedAt: now },
  });
  return count > 0;
}
