import { Channel, CostSource, Prisma } from "@prisma/client";

import prisma from "~/db.server";
import {
  loadEffectiveCosts,
  observeVariantCost,
} from "~/lib/cost-history.server";
import { customerErasureStateInTransaction } from "~/lib/customer-erasure.server";
import { withOrderLock } from "~/lib/order-lock.server";
import { withProductLock } from "~/lib/product-lock.server";
import { toMicros } from "~/engine/money";
import { splitOrderTax } from "~/engine/tax";

/**
 * Translation layer between Shopify's webhook payloads and Meridian's schema.
 *
 * Shopify sends money as decimal strings; they are stored as-is and only parsed
 * inside the engine, so nothing round-trips through a float on the way in.
 */

type Payload = Record<string, any>;

const gid = (kind: string, id: unknown) => {
  const value = String(id ?? "").trim();
  return value.startsWith("gid://shopify/")
    ? value
    : `gid://shopify/${kind}/${value}`;
};

function sourceTime(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Shopify returned an invalid ${label}: ${String(value)}`);
  }
  return parsed;
}

function decimal(value: unknown, fallback = "0.00"): string {
  if (value === null || value === undefined) return fallback;
  const text = String(value);
  return /^-?\d+(\.\d+)?$/.test(text) ? text : fallback;
}

function centsDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(cents));
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
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

export function deriveChannel(signals: AttributionSignals): {
  channel: Channel;
  utm: Record<string, string | null>;
} {
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

  if (/facebook|meta|instagram|fb/.test(source))
    return { channel: Channel.FACEBOOK, utm };
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
  if (/affiliate|partner/.test(medium))
    return { channel: Channel.AFFILIATE, utm };

  const referrer = (referringSite ?? "").toLowerCase();
  if (referrer) {
    if (/facebook|instagram/.test(referrer))
      return { channel: Channel.FACEBOOK, utm };
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
  const shopifyUpdatedAt = sourceTime(payload.updated_at, "order updated_at");

  const { channel, utm } = deriveChannel({
    landingSite: payload.landing_site,
    referringSite: payload.referring_site,
    utmSource: payload.meridian_utm_source,
    utmMedium: payload.meridian_utm_medium,
    utmCampaign: payload.meridian_utm_campaign,
  });

  const refundedTotal = refundedTotalFrom(payload.refunds);

  const processedAt = new Date(payload.processed_at ?? payload.created_at);
  if (Number.isNaN(processedAt.getTime())) {
    throw new Error(`Shopify order ${shopifyId} has no valid processed time`);
  }

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
    shopifyUpdatedAt,
    currency: payload.currency ?? "USD",
    subtotal: decimal(payload.subtotal_price),
    discountTotal: decimal(payload.total_discounts),
    shippingCharged: decimal(shippingCharged),
    taxTotal: decimal(payload.total_tax),
    taxesIncluded: Boolean(payload.taxes_included),
    taxCountryCode:
      String(payload.tax_destination?.country_code ?? "").trim().toUpperCase() || null,
    taxRegionCode:
      String(payload.tax_destination?.province_code ?? "").trim().toUpperCase() || null,
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
  };

  const lineItems: Payload[] = payload.line_items ?? [];
  const refundedByLineItem = new Map<string, number>();
  for (const refund of payload.refunds ?? []) {
    for (const item of refund.refund_line_items ?? []) {
      const key = String(item.line_item_id);
      refundedByLineItem.set(
        key,
        (refundedByLineItem.get(key) ?? 0) + Number(item.quantity ?? 0),
      );
    }
  }

  // The stable Shopify identity is available before an Order row exists and
  // is shared by webhook and backfill writers. Using a database cuid here left
  // two concurrent creates outside the same lock domain.
  return withOrderLock(`${shopId}|${shopifyId}`, async (tx) => {
    const existing = await tx.order.findUnique({
      where: { shopId_shopifyId: { shopId, shopifyId } },
    });
    if (
      existing?.shopifyUpdatedAt &&
      (!shopifyUpdatedAt || shopifyUpdatedAt < existing.shopifyUpdatedAt)
    ) {
      return existing;
    }

    // Customer erasure check and association are inside the same transaction
    // as the order and children. Redaction can therefore win before this lock
    // (the order becomes anonymous) or after commit (the cascade/set-null path
    // removes identity), but can never land in a recreation gap between them.
    let customerId: string | null = null;
    let customerFirstOrderAt: Date | null = null;
    if (payload.customer?.id) {
      const customerShopifyId = gid("Customer", payload.customer.id);
      const erasure = await customerErasureStateInTransaction(tx, shopId, {
        id: customerShopifyId,
      });
      if (!erasure.erased) {
        const customer = await tx.customer.upsert({
          where: {
            shopId_shopifyId: { shopId, shopifyId: customerShopifyId },
          },
          create: {
            shopId,
            shopifyId: customerShopifyId,
            email: payload.customer.email ?? null,
            acquisitionChannel: channel,
            acquisitionCampaignId: utm.campaign,
            firstOrderAt: processedAt,
          },
          update: { email: payload.customer.email ?? undefined },
        });
        customerId = customer.id;
        customerFirstOrderAt = customer.firstOrderAt;
      }
    }

    // Whether this is the customer's first order must exclude this order on a
    // replay. The shop/customer lock above serialises two different orders for
    // the same shopper; the reconciliation below settles out-of-order arrival.
    const isFirstOrder = customerId
      ? (await tx.order.count({
          where: {
            shopId,
            customerId,
            shopifyId: { not: shopifyId },
            processedAt: { lt: processedAt },
          },
        })) === 0
      : false;

    const order = await tx.order.upsert({
      where: { shopId_shopifyId: { shopId, shopifyId } },
      create: {
        shopId,
        shopifyId,
        ...orderData,
        customerId,
        isFirstOrder,
      },
      update: { ...orderData, customerId },
    });

    const variantGids = lineItems
      .filter((item) => item.variant_id)
      .map((item) => gid("ProductVariant", item.variant_id));
    const variants = await tx.variant.findMany({
      where: { shopId, shopifyId: { in: variantGids } },
      select: { id: true, shopifyId: true, productId: true, unitCost: true },
    });
    const variantByGid = new Map(
      variants.map((variant) => [variant.shopifyId, variant]),
    );

    // COGS is frozen from the cost timeline as it stood when the order was
    // *placed*, not as it stands now. For a live webhook those are the same
    // instant and nothing changes. For the historical import they are not, and
    // stamping today's supplier cost onto a two-year-old order — which is what
    // this line did before cost history existed — silently rewrote the entire
    // backfill to today's margins.
    const effectiveCosts = await loadEffectiveCosts(
      variants.map((variant) => variant.id),
      processedAt,
      tx,
    );

    const rows = lineItems.map((item) => {
      const variant = item.variant_id
        ? variantByGid.get(gid("ProductVariant", item.variant_id))
        : undefined;
      // Falling back to the catalog's current cost keeps a variant with no
      // timeline behaving exactly as it did before this change.
      const effective = variant ? effectiveCosts.get(variant.id) : undefined;
      const lineDiscount = (item.discount_allocations ?? []).reduce(
        (sum: number, allocation: Payload) =>
          sum + Number(allocation.amount ?? 0),
        0,
      );
      return {
        shopId,
        orderId: order.id,
        shopifyId: gid("LineItem", item.id),
        variantId: variant?.id ?? null,
        productId: variant?.productId ?? null,
        title: item.title ?? item.name ?? "Item",
        sku: item.sku ?? null,
        quantity: Number(item.quantity ?? 0),
        unitPrice: decimal(item.price),
        discount: decimal(lineDiscount.toFixed(2)),
        unitCost: decimal(
          effective?.unitCost ?? variant?.unitCost ?? "0",
          "0.0000",
        ),
        costEffectiveAt: effective?.effectiveAt ?? null,
        refundedQty: refundedByLineItem.get(String(item.id)) ?? 0,
      };
    });

    await tx.orderLineItem.deleteMany({ where: { orderId: order.id } });
    if (rows.length > 0) await tx.orderLineItem.createMany({ data: rows });

    const taxComponents = splitOrderTax({
      totalTax: orderData.taxTotal,
      taxesIncluded: orderData.taxesIncluded,
      countryCode: orderData.taxCountryCode,
      regionCode: orderData.taxRegionCode,
      lineItems,
      shippingLines: payload.shipping_lines ?? [],
      taxLines: payload.tax_lines ?? [],
    });
    await tx.orderTaxComponent.deleteMany({ where: { orderId: order.id } });
    if (taxComponents.length > 0) {
      await tx.orderTaxComponent.createMany({
        data: taxComponents.map((component) => ({
          shopId,
          orderId: order.id,
          sourceKey: component.sourceKey,
          regime: component.regime,
          jurisdictionType: component.jurisdictionType,
          title: component.title,
          source: component.source,
          countryCode: component.countryCode,
          regionCode: component.regionCode,
          rate: component.rate,
          taxableAmount: component.taxableAmount,
          reportedTax: centsDecimal(component.reportedTaxCents),
          taxAmount: centsDecimal(component.taxAmountCents),
          lineItemTax: centsDecimal(component.lineItemTaxCents),
          shippingTax: centsDecimal(component.shippingTaxCents),
          roundingAdjustment: centsDecimal(component.roundingAdjustmentCents),
          channelLiable: component.channelLiable,
          includedInPrice: component.includedInPrice,
        })),
      });
    }
    await tx.order.update({
      where: { id: order.id },
      data: { taxReconciledAt: new Date() },
    });

    // Once a fulfilment webhook has supplied authoritative rows, derive the
    // header from those rows instead of allowing an order replay to resurrect
    // a shipment that was cancelled on an independent source clock.
    const hasFulfillmentRows = await tx.fulfillment.findFirst({
      where: { shopId, orderId: order.id },
      select: { id: true },
    });
    let fulfillmentStatus = order.fulfillmentStatus;
    if (hasFulfillmentRows) {
      const active = await tx.fulfillment.count({
        where: {
          shopId,
          orderId: order.id,
          status: { notIn: [...INACTIVE_FULFILLMENT_STATUSES] },
        },
      });
      fulfillmentStatus = active > 0 ? "fulfilled" : "unfulfilled";
      if (fulfillmentStatus !== order.fulfillmentStatus) {
        await tx.order.update({
          where: { id: order.id },
          data: { fulfillmentStatus },
        });
      }
    }

    const earliest = customerId
      ? await reconcileFirstOrderInTransaction(
          tx,
          shopId,
          customerId,
          customerFirstOrderAt,
        )
      : null;

    return {
      ...order,
      fulfillmentStatus,
      isFirstOrder: earliest ? earliest.id === order.id : order.isFirstOrder,
    };
  });
}

/**
 * Make exactly one of a customer's orders their first, and say so on the
 * customer row too.
 *
 * Order of arrival decides nothing here: the earliest stored order wins, and
 * ties — two orders sharing a `processedAt` to the millisecond — fall to the
 * order number, which Shopify issues in sequence. Idempotent, so it is safe to
 * run on every delivery of the same order.
 */
export async function reconcileFirstOrder(
  shopId: string,
  customerId: string,
  knownFirstOrderAt: Date | null = null,
) {
  return prisma.$transaction((tx) =>
    reconcileFirstOrderInTransaction(tx, shopId, customerId, knownFirstOrderAt),
  );
}

async function reconcileFirstOrderInTransaction(
  tx: Prisma.TransactionClient,
  shopId: string,
  customerId: string,
  knownFirstOrderAt: Date | null = null,
) {
  const earliest = await tx.order.findFirst({
    where: { shopId, customerId },
    orderBy: [
      { processedAt: "asc" },
      { orderNumber: "asc" },
      { shopifyId: "asc" },
    ],
    select: {
      id: true,
      isFirstOrder: true,
      processedAt: true,
      channel: true,
      campaignId: true,
    },
  });
  if (!earliest) return null;

  await tx.order.updateMany({
    where: { shopId, customerId, isFirstOrder: true, id: { not: earliest.id } },
    data: { isFirstOrder: false },
  });

  if (!earliest.isFirstOrder) {
    await tx.order.update({
      where: { id: earliest.id },
      data: { isFirstOrder: true },
    });
  }

  // The customer row is stamped when it is created, from the first order
  // *delivered* rather than the first placed — so the same misordering pins the
  // acquisition channel to whichever order happened to arrive first. A
  // recompute would eventually correct `firstOrderAt`; it never touches the
  // channel, and CAC is reported per channel.
  if (knownFirstOrderAt?.getTime() !== earliest.processedAt.getTime()) {
    await tx.customer.update({
      where: { id: customerId },
      data: {
        firstOrderAt: earliest.processedAt,
        acquisitionChannel: earliest.channel,
        acquisitionCampaignId: earliest.campaignId,
      },
    });
  }

  return earliest;
}

/**
 * The same decision for a whole shop, in one statement.
 *
 * The import flags the first order it *sees* for each customer, which is right
 * only when it sees all of them, oldest first. A resumed import, or one run on
 * a shop whose webhooks already wrote newer orders, sees a slice — so the flag
 * is settled once at the end from what is actually stored.
 */
export async function reconcileFirstOrdersForShop(shopId: string) {
  return prisma.$executeRaw`
    WITH ranked AS (
      SELECT
        o.id,
        ROW_NUMBER() OVER (
          PARTITION BY o."customerId"
          ORDER BY o."processedAt" ASC, o."orderNumber" ASC, o."shopifyId" ASC
        ) = 1 AS is_first
      FROM "Order" o
      WHERE o."shopId" = ${shopId} AND o."customerId" IS NOT NULL
    )
    UPDATE "Order" AS o
       SET "isFirstOrder" = ranked.is_first
      FROM ranked
     WHERE o.id = ranked.id
       AND o."isFirstOrder" IS DISTINCT FROM ranked.is_first
  `;
}

/**
 * Append an observed cost to the variant's timeline, inside the product lock.
 *
 * `effectiveAt` is Shopify's own inventory-item mutation time, not the moment
 * the delivery arrived. That is what makes redelivery idempotent — the same
 * change carries the same instant and upserts onto one row — and it is also
 * simply true: the cost changed when the merchant changed it, not when the
 * webhook happened to land.
 *
 * A cost Shopify reports as absent withdraws nothing. The merchant may have
 * supplied that cost themselves, and an unauthorised Admin field coming back
 * empty is not evidence the cost stopped existing.
 */
async function recordObservedCost(
  tx: Prisma.TransactionClient,
  shopId: string,
  variantId: string,
  variant: Payload,
  context: {
    unitCostKnown: boolean;
    inventoryItemUpdatedAt: Date | null;
    observedAt: Date;
  },
): Promise<void> {
  if (!context.unitCostKnown) return;
  if (variant.unit_cost === null || variant.unit_cost === undefined) return;

  await observeVariantCost(
    {
      shopId,
      variantId,
      unitCostMicros: toMicros(decimal(variant.unit_cost, "0.0000")),
      effectiveAt: context.inventoryItemUpdatedAt ?? context.observedAt,
      source: CostSource.SHOPIFY,
      note: null,
    },
    tx,
  );
}

export async function syncProductFromShopify(shopId: string, payload: Payload) {
  const shopifyId = gid("Product", payload.id);
  const observedAt = new Date();
  const sourceUpdatedAt = sourceTime(payload.updated_at, "product updated_at");

  return withProductLock(shopId, shopifyId, async (tx) => {
    const existingProduct = await tx.product.findUnique({
      where: { shopId_shopifyId: { shopId, shopifyId } },
    });

    // The lock establishes one atomic writer, but lock acquisition order is
    // not Shopify mutation order. A delayed 12:02 delivery must never replace
    // catalog state already published from 12:03. A payload without Shopify's
    // source timestamp can initialise legacy state, but it cannot outrank a
    // row whose source chronology is already known.
    const publishesCurrentState =
      !existingProduct ||
      !existingProduct.shopifyUpdatedAt ||
      (sourceUpdatedAt !== null &&
        sourceUpdatedAt >= existingProduct.shopifyUpdatedAt);

    const product = publishesCurrentState
      ? await tx.product.upsert({
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
            shopifyUpdatedAt: sourceUpdatedAt,
          },
          update: {
            title: payload.title ?? "Untitled",
            handle: payload.handle ?? String(payload.id),
            productType: payload.product_type ?? null,
            vendor: payload.vendor ?? null,
            status: (payload.status ?? "active").toUpperCase(),
            imageUrl: payload.image?.src ?? null,
            shopifyUpdatedAt: sourceUpdatedAt,
          },
        })
      : existingProduct;

    for (const variant of payload.variants ?? []) {
      const variantGid = gid("ProductVariant", variant.id);
      const price = new Prisma.Decimal(decimal(variant.price));

      const existing = await tx.variant.findUnique({
        where: { shopId_shopifyId: { shopId, shopifyId: variantGid } },
        select: {
          id: true,
          price: true,
          inventoryItemShopifyId: true,
          inventoryItemUpdatedAt: true,
          _count: { select: { priceHistory: true } },
        },
      });

      const inventoryItemShopifyId = variant.inventory_item_gid
        ? gid("InventoryItem", variant.inventory_item_gid)
        : null;
      const inventoryItemUpdatedAt = sourceTime(
        variant.inventory_item_updated_at,
        "inventory item updated_at",
      );
      const publishesInventoryState =
        inventoryItemShopifyId !== null &&
        (!existing?.inventoryItemUpdatedAt ||
          (inventoryItemUpdatedAt !== null &&
            inventoryItemUpdatedAt >= existing.inventoryItemUpdatedAt));
      const unitCostKnown = variant.unit_cost_known === true;
      const weightUpdate = Object.prototype.hasOwnProperty.call(
        variant,
        "grams",
      )
        ? {
            weightGrams:
              variant.grams === null || variant.grams === undefined
                ? null
                : Number(variant.grams),
          }
        : {};
      const inventoryData = publishesInventoryState
        ? {
            inventoryItemShopifyId,
            inventoryItemUpdatedAt,
            ...(unitCostKnown
              ? {
                  unitCost:
                    variant.unit_cost === null ||
                    variant.unit_cost === undefined
                      ? null
                      : decimal(variant.unit_cost, "0.0000"),
                  costSource:
                    variant.unit_cost === null ||
                    variant.unit_cost === undefined
                      ? CostSource.ESTIMATED
                      : CostSource.SHOPIFY,
                }
              : {}),
          }
        : {};

      // A late webhook remains valuable evidence of the price that existed at
      // its own Shopify timestamp. Preserve that fact once, but never let it
      // alter current Product/Variant fields.
      if (!publishesCurrentState) {
        if (existing && publishesInventoryState) {
          await tx.variant.update({
            where: { id: existing.id },
            data: inventoryData,
          });
          await recordObservedCost(tx, shopId, existing.id, variant, {
            unitCostKnown,
            inventoryItemUpdatedAt,
            observedAt,
          });
        }
        if (!existing || !sourceUpdatedAt) continue;
        const duplicate = await tx.priceChange.findFirst({
          where: {
            variantId: existing.id,
            price,
            effectiveAt: sourceUpdatedAt,
          },
          select: { id: true },
        });
        if (!duplicate) {
          await tx.priceChange.create({
            data: {
              shopId,
              variantId: existing.id,
              price,
              effectiveAt: sourceUpdatedAt,
            },
          });
        }
        continue;
      }

      const record = await tx.variant.upsert({
        where: { shopId_shopifyId: { shopId, shopifyId: variantGid } },
        create: {
          shopId,
          productId: product.id,
          shopifyId: variantGid,
          sku: variant.sku ?? null,
          title: variant.title ?? "Default",
          price,
          compareAtPrice: variant.compare_at_price
            ? decimal(variant.compare_at_price)
            : null,
          inventoryQty: Number(variant.inventory_quantity ?? 0),
          weightGrams:
            variant.grams === null || variant.grams === undefined
              ? null
              : Number(variant.grams),
          ...inventoryData,
        },
        update: {
          sku: variant.sku ?? null,
          title: variant.title ?? "Default",
          price,
          compareAtPrice: variant.compare_at_price
            ? decimal(variant.compare_at_price)
            : null,
          inventoryQty: Number(variant.inventory_quantity ?? 0),
          ...weightUpdate,
          ...inventoryData,
        },
      });

      if (publishesInventoryState) {
        await recordObservedCost(tx, shopId, record.id, variant, {
          unitCostKnown,
          inventoryItemUpdatedAt,
          observedAt,
        });
      }

      // Current price and its irreconstructible history commit together. A
      // failed insert rolls the price back, so durable replay still observes
      // the old price and appends exactly one transition.
      const needsPriceFact =
        !existing ||
        existing._count.priceHistory === 0 ||
        !new Prisma.Decimal(existing.price).equals(price);
      if (!needsPriceFact) continue;

      const effectiveAt = sourceUpdatedAt ?? observedAt;
      const duplicate = await tx.priceChange.findFirst({
        where: { variantId: record.id, price, effectiveAt },
        select: { id: true },
      });
      if (!duplicate) {
        await tx.priceChange.create({
          data: {
            shopId,
            variantId: record.id,
            price,
            effectiveAt,
          },
        });
      }
    }

    return product;
  });
}

/** Shopify fulfilment states that mean nothing shipped, or that it came back. */
export const INACTIVE_FULFILLMENT_STATUSES = new Set([
  "cancelled",
  "canceled",
  "error",
  "failure",
]);

/**
 * Whether a fulfilment in this state actually put goods on a van.
 *
 * The backfill and the webhook both write `Fulfillment.shippedAt` and used to
 * disagree about it: the webhook cleared it for a cancelled shipment, the
 * import stamped it unconditionally. One column, two writers, two meanings.
 */
export function fulfillmentDidShip(status: string | null | undefined): boolean {
  return !INACTIVE_FULFILLMENT_STATUSES.has(
    String(status ?? "success").toLowerCase(),
  );
}

/**
 * Apply a `fulfillments/create` or `fulfillments/update` delivery.
 *
 * Identity is Shopify's fulfilment id, never the timestamp. An update repeats
 * the original `created_at`, so matching on `(shopId, orderId, createdAt)` read
 * every update as a duplicate already stored and returned early — cancellations
 * and carrier corrections never landed, and two shipments created in the same
 * second collapsed into one row.
 */
export async function syncFulfillmentFromShopify(
  shopId: string,
  payload: Payload,
) {
  const orderShopifyId = gid("Order", payload.order_id);
  const shopifyId = payload.id ? gid("Fulfillment", payload.id) : null;
  const createdAt = new Date(payload.created_at);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(
      `Shopify fulfillment ${shopifyId ?? "without id"} has no valid created_at`,
    );
  }
  const shopifyUpdatedAt = sourceTime(
    payload.updated_at,
    "fulfillment updated_at",
  );
  const status = String(payload.status ?? "success").toLowerCase();
  const shipped = !INACTIVE_FULFILLMENT_STATUSES.has(status);

  const itemCount = (payload.line_items ?? []).reduce(
    (sum: number, item: Payload) => sum + Number(item.quantity ?? 0),
    0,
  );

  const fields = {
    status,
    createdAt,
    shopifyUpdatedAt,
    // A cancelled fulfilment never shipped, and one that was cancelled after
    // the fact did not stay shipped. Clearing this keeps the fulfilment engine
    // from counting it against the warehouse's throughput.
    shippedAt: shipped && payload.created_at ? createdAt : null,
    carrier: payload.tracking_company ?? null,
    serviceLevel: payload.service ?? null,
    itemCount,
    location: String(payload.location_id ?? "primary"),
  };

  return withOrderLock(`${shopId}|${orderShopifyId}`, async (tx) => {
    const order = await tx.order.findUnique({
      where: {
        shopId_shopifyId: { shopId, shopifyId: orderShopifyId },
      },
    });
    if (!order) return null;

    // Rows imported before `shopifyId` existed carry none. Fall back to the
    // old time match once so the first current update adopts that row.
    const existing = shopifyId
      ? ((await tx.fulfillment.findUnique({
          where: { shopId_shopifyId: { shopId, shopifyId } },
        })) ??
        (await tx.fulfillment.findFirst({
          where: { shopId, orderId: order.id, createdAt, shopifyId: null },
        })))
      : await tx.fulfillment.findFirst({
          where: { shopId, orderId: order.id, createdAt },
        });

    if (
      existing?.shopifyUpdatedAt &&
      (!shopifyUpdatedAt || shopifyUpdatedAt < existing.shopifyUpdatedAt)
    ) {
      return existing;
    }

    const fulfillment = existing
      ? await tx.fulfillment.update({
          where: { id: existing.id },
          data: { ...fields, shopifyId: shopifyId ?? existing.shopifyId },
        })
      : await tx.fulfillment.create({
          data: {
            shopId,
            orderId: order.id,
            shopifyId,
            ...fields,
            // Real carrier cost arrives from the 3PL connector, not Shopify.
            shippingCost: "0.00",
            pickPackCost: "0.00",
          },
        });

    const active = await tx.fulfillment.count({
      where: {
        shopId,
        orderId: order.id,
        status: { notIn: [...INACTIVE_FULFILLMENT_STATUSES] },
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { fulfillmentStatus: active > 0 ? "fulfilled" : "unfulfilled" },
    });

    return fulfillment;
  });
}
