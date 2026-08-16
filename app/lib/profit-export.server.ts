import type { Prisma } from "@prisma/client";

import prisma, { withTenantDatabase } from "~/db.server";

/** A bounded, interactive export; longer history belongs in an async job. */
export const MAX_PROFIT_EXPORT_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;

export function profitExportRangeIsAllowed(from: Date, to: Date): boolean {
  const duration = to.getTime() - from.getTime();
  return Number.isFinite(duration) && duration > 0 && duration <= MAX_PROFIT_EXPORT_RANGE_MS;
}

export const PROFIT_EXPORT_HEADER = [
  "order_number",
  "processed_at",
  "currency",
  "channel",
  "revenue",
  "refunds",
  "cogs",
  "shipping_cost",
  "return_shipping_cost",
  "payment_fee",
  "pick_pack_cost",
  "ad_cost_attributed",
  "overhead_allocated",
  "contribution_profit",
  "net_profit",
  "computed_at",
] as const;

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

type ExportOrder = Prisma.OrderGetPayload<{
  select: {
    id: true;
    orderNumber: true;
    processedAt: true;
    currency: true;
    channel: true;
    total: true;
    refundedTotal: true;
    cogsTotal: true;
    materializedOutboundShippingCost: true;
    materializedReturnShippingCost: true;
    materializedPaymentFee: true;
    materializedPickPackCost: true;
    adCostAttributed: true;
    overheadAllocated: true;
    contributionProfit: true;
    netProfit: true;
    computedAt: true;
  };
}>;

export function profitOrderCsvRow(order: Omit<ExportOrder, "id">): string {
  return [
    order.orderNumber,
    order.processedAt.toISOString(),
    order.currency,
    order.channel,
    order.total,
    order.refundedTotal,
    order.cogsTotal,
    order.materializedOutboundShippingCost,
    order.materializedReturnShippingCost,
    order.materializedPaymentFee,
    order.materializedPickPackCost,
    order.adCostAttributed,
    order.overheadAllocated,
    order.contributionProfit,
    order.netProfit,
    order.computedAt?.toISOString() ?? "",
  ]
    .map(csvCell)
    .join(",");
}

/**
 * Stream in bounded pages. Even a multi-million-order export keeps only 1,000
 * rows in memory and pushes back naturally through the response stream.
 */
export function createProfitExportStream(input: {
  shopId: string;
  from: Date;
  to: Date;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cursor: string | undefined;
  let done = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(`${PROFIT_EXPORT_HEADER.join(",")}\r\n`),
      );
    },
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }
      try {
        const rows = await withTenantDatabase({ shopId: input.shopId }, () =>
          prisma.order.findMany({
            where: {
              shopId: input.shopId,
              processedAt: { gte: input.from, lt: input.to },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: "asc" },
            take: 1_000,
            select: {
              id: true,
              orderNumber: true,
              processedAt: true,
              currency: true,
              channel: true,
              total: true,
              refundedTotal: true,
              cogsTotal: true,
              materializedOutboundShippingCost: true,
              materializedReturnShippingCost: true,
              materializedPaymentFee: true,
              materializedPickPackCost: true,
              adCostAttributed: true,
              overheadAllocated: true,
              contributionProfit: true,
              netProfit: true,
              computedAt: true,
            },
          }),
        );
        if (rows.length === 0) {
          done = true;
          controller.close();
          return;
        }
        cursor = rows.at(-1)!.id;
        controller.enqueue(
          encoder.encode(`${rows.map(profitOrderCsvRow).join("\r\n")}\r\n`),
        );
        if (rows.length < 1_000) done = true;
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
