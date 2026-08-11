import {
  Prisma,
  ShippingAdjustmentKind,
  ShippingAdjustmentSource,
} from "@prisma/client";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { convertCents, fxRate } from "~/lib/fx.server";

/**
 * Ingestion for the shipping-cost correction ledger.
 *
 * Carrier invoices arrive weeks after shipment, keyed by the carrier's own
 * identifiers and usually referencing the order by name/number rather than by
 * anything Meridian stores as a primary key. This module resolves those
 * references, converts foreign-currency lines once at the door, and writes
 * idempotently — re-importing the same invoice must be a no-op, because an
 * import that double-charges a $4.20 reweigh on retry is indistinguishable
 * from a real second correction in every later report.
 */

export interface ShippingAdjustmentEntry {
  /** The source system's stable id for this line (invoice line id, etc). */
  reference: string;
  kind: ShippingAdjustmentKind;
  source: ShippingAdjustmentSource;
  /** Signed decimal string; positive = extra cost, negative = carrier credit. */
  amount: string;
  /** ISO currency of `amount`; omitted means the shop currency. */
  currency?: string | null;
  /** How the source names the order: Shopify order GID, or "#1042"/1042. */
  orderReference: string | number;
  /** Optional Shopify fulfilment GID, when the source can name the parcel. */
  fulfillmentReference?: string | null;
  reason?: string | null;
  occurredAt: Date;
}

export interface ShippingAdjustmentResult {
  written: number;
  /** Same (source, reference) already recorded — replay, not new information. */
  duplicates: number;
  /** Lines whose order reference matched nothing; reported, never guessed. */
  unmatched: string[];
}

const ORDER_GID_PREFIX = "gid://shopify/Order/";

function isOrderGid(reference: string): boolean {
  return reference.startsWith(ORDER_GID_PREFIX);
}

async function resolveOrderId(
  shopId: string,
  reference: string | number,
): Promise<string | null> {
  const raw = String(reference).trim();
  if (raw === "") return null;

  if (isOrderGid(raw)) {
    const byGid = await prisma.order.findUnique({
      where: { shopId_shopifyId: { shopId, shopifyId: raw } },
      select: { id: true },
    });
    return byGid?.id ?? null;
  }

  const digits = raw.replace(/\D/g, "");
  if (digits === "") return null;

  // A bare numeric reference is ambiguous between the Shopify id and the
  // order number. The numeric id form is tried first because it is globally
  // unique; order numbers are only unique per shop, which the filter enforces.
  const byNumericGid = await prisma.order.findUnique({
    where: {
      shopId_shopifyId: { shopId, shopifyId: `${ORDER_GID_PREFIX}${digits}` },
    },
    select: { id: true },
  });
  if (byNumericGid) return byNumericGid.id;

  const byNumber = await prisma.order.findFirst({
    where: { shopId, orderNumber: Number(digits) },
    select: { id: true },
  });
  return byNumber?.id ?? null;
}

async function resolveFulfillmentId(
  shopId: string,
  orderId: string,
  reference: string | null | undefined,
): Promise<string | null> {
  if (!reference) return null;
  const fulfillment = await prisma.fulfillment.findFirst({
    where: { shopId, orderId, shopifyId: String(reference) },
    select: { id: true },
  });
  return fulfillment?.id ?? null;
}

/**
 * Record a batch of adjustments. Each line resolves, converts and writes
 * independently: one unmatched invoice line must not block the ninety-nine
 * that matched, and the unmatched ones come back by reference so the caller
 * can surface them instead of retrying forever.
 */
export async function recordShippingAdjustments(
  shopId: string,
  shopCurrency: string,
  entries: readonly ShippingAdjustmentEntry[],
): Promise<ShippingAdjustmentResult> {
  const result: ShippingAdjustmentResult = {
    written: 0,
    duplicates: 0,
    unmatched: [],
  };

  for (const entry of entries) {
    const orderId = await resolveOrderId(shopId, entry.orderReference);
    if (!orderId) {
      result.unmatched.push(entry.reference);
      continue;
    }
    const fulfillmentId = await resolveFulfillmentId(
      shopId,
      orderId,
      entry.fulfillmentReference,
    );

    const sourceCurrency = entry.currency?.toUpperCase() || null;
    const needsConversion =
      sourceCurrency !== null && sourceCurrency !== shopCurrency.toUpperCase();

    const sourceAmountCents = Math.round(Number(entry.amount) * 100);
    if (!Number.isFinite(sourceAmountCents)) {
      result.unmatched.push(entry.reference);
      continue;
    }

    // Convert at the rate of the day the cost occurred — the invoice's own
    // economics — not the day the import happened to run.
    const rate = needsConversion
      ? await fxRate(entry.occurredAt, sourceCurrency, shopCurrency)
      : 1;
    const amountCents = convertCents(sourceAmountCents, rate);

    try {
      await prisma.shippingLabelAdjustment.create({
        data: {
          shopId,
          orderId,
          fulfillmentId,
          kind: entry.kind,
          source: entry.source,
          reference: entry.reference,
          amount: new Prisma.Decimal((amountCents / 100).toFixed(2)),
          sourceCurrency: needsConversion ? sourceCurrency : null,
          sourceAmount: needsConversion
            ? new Prisma.Decimal((sourceAmountCents / 100).toFixed(2))
            : null,
          reason: entry.reason ?? null,
          occurredAt: entry.occurredAt,
        },
      });
      result.written += 1;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        result.duplicates += 1;
        continue;
      }
      throw error;
    }
  }

  if (result.written > 0) {
    // Materialised profit for the affected orders is now stale. The analytics
    // cache is invalidated immediately; the durable recompute is the caller's
    // decision because a large import wants one recompute at the end, not one
    // per invoice file.
    invalidateAnalyticsCache();
  }

  return result;
}
