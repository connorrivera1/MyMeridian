import { Channel } from "@prisma/client";

import prisma from "~/db.server";

/**
 * Translation layer between Shopify's webhook payloads and Meridian's schema.
 *
 * Shopify sends money as decimal strings; they are stored as-is and only parsed
 * inside the engine, so nothing round-trips through a float on the way in.
 */

type Payload = Record<string, any>;

const gid = (kind: string, id: unknown) => `gid://shopify/${kind}/${id}`;

/**
 * Variant GIDs carried by a products/create or products/update payload.
 *
 * Exists so the webhook can ask Shopify for the one field the payload never
 * carries — the unit cost on each variant's inventory item.
 */
export function variantGidsIn(payload: Payload): string[] {
  return (payload.variants ?? [])
    .map((variant: Payload) => gid("ProductVariant", variant.id))
    .filter(Boolean);
}

function decimal(value: unknown, fallback = "0.00"): string {
  if (value === null || value === undefined) return fallback;
  const text = String(value);
  return /^-?\d+(\.\d+)?$/.test(text) ? text : fallback;
}

/**
 * Work out which channel an order came from.
 *
 * UTM parameters on the landing URL are the strongest signal a merchant
 * actually controls; the referrer is the fallback. Anything unrecognised
 * becomes DIRECT rather than OTHER, because "we don't know" is far more often
 * a direct visit than an exotic channel — and mislabelling it OTHER hides it in
 * a bucket nobody looks at.
 */
export interface AttributionSignals {
  landingSite?: string | null;
  referringSite?: string | null;
  /** Explicit UTM values, e.g. from customerJourneySummary. Win over parsed ones. */
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
}

export function deriveChannel(
  signals: AttributionSignals,
): { channel: Channel; utm: Record<string, string | null> } {
  const { landingSite, referringSite } = signals;

  const utm: Record<string, string | null> = {
    source: signals.utmSource ?? null,
    medium: signals.utmMedium ?? null,
    campaign: signals.utmCampaign ?? null,
  };

  // Fall back to parsing the landing URL only where the journey did not
  // already give us a value.
  if (landingSite && (!utm.source || !utm.medium || !utm.campaign)) {
    try {
      const url = new URL(landingSite, "https://placeholder.invalid");
      utm.source ??= url.searchParams.get("utm_source");
      utm.medium ??= url.searchParams.get("utm_medium");
      utm.campaign ??= url.searchParams.get("utm_campaign");
    } catch {
      // Malformed landing URLs are common; fall through to the referrer.
    }
  }

  const source = (utm.source ?? "").toLowerCase();
  const medium = (utm.medium ?? "").toLowerCase();

  if (/facebook|meta|instagram|fb/.test(source)) return { channel: Channel.FACEBOOK, utm };
  if (/google|adwords/.test(source)) {
    return {
      channel: /organic/.test(medium) ? Channel.ORGANIC_SEARCH : Channel.GOOGLE,
      utm,
    };
  }
  if (/tiktok/.test(source)) return { channel: Channel.TIKTOK, utm };
  if (/klaviyo|mailchimp|email|newsletter/.test(source) || medium === "email") {
    return { channel: Channel.EMAIL, utm };
  }
  if (/affiliate|partner/.test(medium)) return { channel: Channel.AFFILIATE, utm };

  const referrer = (referringSite ?? "").toLowerCase();
  if (referrer) {
    if (/facebook|instagram/.test(referrer)) return { channel: Channel.FACEBOOK, utm };
    if (/tiktok/.test(referrer)) return { channel: Channel.TIKTOK, utm };
    if (/google|bing|duckduckgo|yahoo/.test(referrer)) {
      return { channel: Channel.ORGANIC_SEARCH, utm };
    }
    return { channel: Channel.REFERRAL, utm };
  }

  return { channel: Channel.DIRECT, utm };
}

/**
 * What a set of Shopify refunds actually took back.
 *
 * `refund.transactions[]` is an attempt log, not a ledger: a declined refund
 * stays in it with `status: "error"`, and a retry adds a second entry for the
 * same money. Summing the array blindly turned one $120 refund that failed and
 * was retried into $240 returned, which subtracts more ex-tax revenue than the
 * order ever booked and drives its margin negative.
 *
 * Only successful transactions of kind `refund` moved money. A `void` releases
 * an authorisation that was never captured, so it is not a refund either.
 */
export function refundedTotalFrom(refunds: unknown): string {
  if (!Array.isArray(refunds)) return "0.00";

  const total = refunds
    .flatMap((refund: Payload) => refund?.transactions ?? [])
    .filter((tx: Payload) => {
      const status = String(tx?.status ?? "").toLowerCase();
      const kind = String(tx?.kind ?? "refund").toLowerCase();
      return kind === "refund" && (status === "success" || status === "");
    })
    .reduce((sum: number, tx: Payload) => sum + Number(tx?.amount ?? 0), 0);

  return total.toFixed(2);
}

export async function syncOrderFromShopify(shopId: string, payload: Payload) {
  const shopifyId = gid("Order", payload.id);

  const { channel, utm } = deriveChannel({
    landingSite: payload.landing_site,
    referringSite: payload.referring_site,
  });

  // Customer first, so the order can be linked in one write.
  let customerId: string | null = null;
  if (payload.customer?.id) {
    const customer = await prisma.customer.upsert({
      where: {
        shopId_shopifyId: {
          shopId,
          shopifyId: gid("Customer", payload.customer.id),
        },
      },
      create: {
        shopId,
        shopifyId: gid("Customer", payload.customer.id),
        email: payload.customer.email ?? null,
        acquisitionChannel: channel,
        acquisitionCampaignId: utm.campaign,
        firstOrderAt: new Date(payload.processed_at ?? payload.created_at),
      },
      update: { email: payload.customer.email ?? undefined },
    });
    customerId = customer.id;
  }

  const refundedTotal = refundedTotalFrom(payload.refunds);

  const processedAt = new Date(payload.processed_at ?? payload.created_at);

  // Whether this is the customer's first order must be decided by comparison
  // against their OTHER orders, never by a bare count.
  //
  // Shopify redelivers the same order routinely — orders/create is followed by
  // orders/updated, and refunds/create arrives later with the order nested
  // inside. On every redelivery the order is already stored, so a plain
  // `count({ customerId }) === 0` counts the order against itself and flips a
  // genuine first order to false. That silently destroys new-customer counts,
  // and CAC is spend divided by new customers, so the acquisition screen
  // overstates CAC for every redelivered order.
  const isFirstOrder = customerId
    ? (await prisma.order.count({
        where: {
          shopId,
          customerId,
          shopifyId: { not: shopifyId },
          processedAt: { lt: processedAt },
        },
      })) === 0
    : false;

  const shippingCharged =
    payload.total_shipping_price_set?.shop_money?.amount ??
    payload.shipping_lines?.reduce(
      (sum: number, line: Payload) => sum + Number(line.price ?? 0),
      0,
    ) ??
    0;

  const orderData = {
    orderNumber: Number(payload.order_number ?? payload.number ?? 0),
    processedAt,
    customerId,
    currency: payload.currency ?? "USD",
    subtotal: decimal(payload.subtotal_price),
    discountTotal: decimal(payload.total_discounts),
    shippingCharged: decimal(shippingCharged),
    taxTotal: decimal(payload.total_tax),
    total: decimal(payload.total_price),
    refundedTotal: decimal(refundedTotal),
    financialStatus: payload.financial_status ?? "paid",
    fulfillmentStatus: payload.fulfillment_status ?? "unfulfilled",
    channel,
    campaignId: utm.campaign,
    utmSource: utm.source,
    utmMedium: utm.medium,
    utmCampaign: utm.campaign,
    landingSite: payload.landing_site ?? null,
    isFirstOrder,
  };

  const order = await prisma.order.upsert({
    where: { shopId_shopifyId: { shopId, shopifyId } },
    create: { shopId, shopifyId, ...orderData },
    update: orderData,
  });

  await syncLineItems(shopId, order.id, payload);

  return order;
}

async function syncLineItems(shopId: string, orderId: string, payload: Payload) {
  const lineItems: Payload[] = payload.line_items ?? [];

  // Refunded quantities live on the refunds array, not the line items.
  const refundedByLineItem = new Map<string, number>();
  for (const refund of payload.refunds ?? []) {
    for (const item of refund.refund_line_items ?? []) {
      const key = String(item.line_item_id);
      refundedByLineItem.set(key, (refundedByLineItem.get(key) ?? 0) + Number(item.quantity ?? 0));
    }
  }

  // Resolve variants once so each line can snapshot the current landed cost.
  const variantGids = lineItems
    .filter((item) => item.variant_id)
    .map((item) => gid("ProductVariant", item.variant_id));

  const variants = await prisma.variant.findMany({
    where: { shopId, shopifyId: { in: variantGids } },
    select: { id: true, shopifyId: true, productId: true, unitCost: true },
  });
  const variantByGid = new Map(variants.map((v) => [v.shopifyId, v]));

  await prisma.orderLineItem.deleteMany({ where: { orderId } });

  if (lineItems.length === 0) return;

  await prisma.orderLineItem.createMany({
    data: lineItems.map((item) => {
      const variant = item.variant_id
        ? variantByGid.get(gid("ProductVariant", item.variant_id))
        : undefined;

      const lineDiscount = (item.discount_allocations ?? []).reduce(
        (sum: number, allocation: Payload) => sum + Number(allocation.amount ?? 0),
        0,
      );

      return {
        shopId,
        orderId,
        shopifyId: gid("LineItem", item.id),
        variantId: variant?.id ?? null,
        productId: variant?.productId ?? null,
        title: item.title ?? item.name ?? "Item",
        sku: item.sku ?? null,
        quantity: Number(item.quantity ?? 0),
        unitPrice: decimal(item.price),
        discount: decimal(lineDiscount.toFixed(2)),
        // Snapshot, not a reference: a supplier price rise next month must not
        // retroactively change what this order earned.
        unitCost: decimal(variant?.unitCost ?? "0", "0.0000"),
        refundedQty: refundedByLineItem.get(String(item.id)) ?? 0,
      };
    }),
  });
}

export async function syncProductFromShopify(shopId: string, payload: Payload) {
  const shopifyId = gid("Product", payload.id);

  const product = await prisma.product.upsert({
    where: { shopId_shopifyId: { shopId, shopifyId } },
    create: {
      shopId,
      shopifyId,
      title: payload.title ?? "Untitled",
      handle: payload.handle ?? String(payload.id),
      productType: payload.product_type ?? null,
      vendor: payload.vendor ?? null,
      status: (payload.status ?? "active").toUpperCase(),
      imageUrl: payload.image?.src ?? null,
    },
    update: {
      title: payload.title ?? "Untitled",
      handle: payload.handle ?? String(payload.id),
      productType: payload.product_type ?? null,
      vendor: payload.vendor ?? null,
      status: (payload.status ?? "active").toUpperCase(),
      imageUrl: payload.image?.src ?? null,
    },
  });

  for (const variant of payload.variants ?? []) {
    const variantGid = gid("ProductVariant", variant.id);
    const price = decimal(variant.price);

    const existing = await prisma.variant.findUnique({
      where: { shopId_shopifyId: { shopId, shopifyId: variantGid } },
    });

    const record = await prisma.variant.upsert({
      where: { shopId_shopifyId: { shopId, shopifyId: variantGid } },
      create: {
        shopId,
        productId: product.id,
        shopifyId: variantGid,
        sku: variant.sku ?? null,
        title: variant.title ?? "Default",
        price,
        compareAtPrice: variant.compare_at_price ? decimal(variant.compare_at_price) : null,
        inventoryQty: Number(variant.inventory_quantity ?? 0),
        weightGrams: variant.grams ? Number(variant.grams) : null,
      },
      update: {
        sku: variant.sku ?? null,
        title: variant.title ?? "Default",
        price,
        compareAtPrice: variant.compare_at_price ? decimal(variant.compare_at_price) : null,
        inventoryQty: Number(variant.inventory_quantity ?? 0),
      },
    });

    // Record price moves as they happen — this history is the only thing that
    // makes elasticity estimable later, and it cannot be reconstructed.
    if (!existing || String(existing.price) !== price) {
      await prisma.priceChange.create({
        data: {
          shopId,
          variantId: record.id,
          price,
          effectiveAt: new Date(payload.updated_at ?? Date.now()),
        },
      });
    }
  }

  return product;
}

/** Shopify fulfilment states that mean nothing shipped, or that it came back. */
const INACTIVE_FULFILLMENT_STATUSES = new Set(["cancelled", "canceled", "error", "failure"]);

/**
 * Apply a `fulfillments/create` or `fulfillments/update` delivery.
 *
 * Identity is Shopify's fulfilment id, never the timestamp. An update repeats
 * the original `created_at`, so matching on `(shopId, orderId, createdAt)` read
 * every update as a duplicate already stored and returned early — cancellations
 * and carrier corrections never landed, and two shipments created in the same
 * second collapsed into one row.
 */
export async function syncFulfillmentFromShopify(shopId: string, payload: Payload) {
  const order = await prisma.order.findUnique({
    where: { shopId_shopifyId: { shopId, shopifyId: gid("Order", payload.order_id) } },
  });
  if (!order) return null;

  const shopifyId = payload.id ? gid("Fulfillment", payload.id) : null;
  const createdAt = new Date(payload.created_at);
  const status = String(payload.status ?? "success").toLowerCase();
  const shipped = !INACTIVE_FULFILLMENT_STATUSES.has(status);

  const itemCount = (payload.line_items ?? []).reduce(
    (sum: number, item: Payload) => sum + Number(item.quantity ?? 0),
    0,
  );

  const fields = {
    status,
    createdAt,
    // A cancelled fulfilment never shipped, and one that was cancelled after
    // the fact did not stay shipped. Clearing this keeps the fulfilment engine
    // from counting it against the warehouse's throughput.
    shippedAt: shipped && payload.created_at ? createdAt : null,
    carrier: payload.tracking_company ?? null,
    serviceLevel: payload.service ?? null,
    itemCount,
    location: String(payload.location_id ?? "primary"),
  };

  // Rows imported before `shopifyId` existed carry none, and neither does a
  // payload without an id. Fall back to the old triple match so an update to
  // one of those adopts the row instead of writing a second one beside it.
  const existing = shopifyId
    ? ((await prisma.fulfillment.findUnique({
        where: { shopId_shopifyId: { shopId, shopifyId } },
      })) ??
      (await prisma.fulfillment.findFirst({
        where: { shopId, orderId: order.id, createdAt, shopifyId: null },
      })))
    : await prisma.fulfillment.findFirst({
        where: { shopId, orderId: order.id, createdAt },
      });

  const fulfillment = existing
    ? await prisma.fulfillment.update({
        where: { id: existing.id },
        data: { ...fields, shopifyId: shopifyId ?? existing.shopifyId },
      })
    : await prisma.fulfillment.create({
        data: {
          shopId,
          orderId: order.id,
          shopifyId,
          ...fields,
          // Real carrier cost arrives from the 3PL connector, not from Shopify.
          // Left at zero so the engine falls back to the merchant's cost rule
          // rather than silently claiming this shipment was free.
          shippingCost: "0.00",
          pickPackCost: "0.00",
        },
      });

  // Derived, not asserted: the order is only fulfilled while at least one of
  // its fulfilments is. Stamping "fulfilled" unconditionally left an order
  // whose single shipment was cancelled reading as shipped forever.
  const active = await prisma.fulfillment.count({
    where: { shopId, orderId: order.id, status: { notIn: [...INACTIVE_FULFILLMENT_STATUSES] } },
  });

  await prisma.order.update({
    where: { id: order.id },
    data: { fulfillmentStatus: active > 0 ? "fulfilled" : "unfulfilled" },
  });

  return fulfillment;
}
