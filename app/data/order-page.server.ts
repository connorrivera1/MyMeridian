import { Channel, Prisma } from "@prisma/client";

import prisma from "~/db.server";
import { toMaterializedOrderProfit } from "~/data/materialized-analytics.server";
import { ORDER_PAGE_SIZE, type OrderSortKey } from "~/data/order-page";
import type { DateRange } from "~/data/queries.server";

interface CursorPayload {
  v: 1;
  sort: OrderSortKey;
  channel: string | null;
  from: string;
  to: string;
  id: string;
  value: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  raw: string | null,
  expected: Omit<CursorPayload, "v" | "id" | "value">,
): CursorPayload | null {
  if (!raw || raw.length > 1_024) return null;
  try {
    const value = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      value.v !== 1 ||
      value.sort !== expected.sort ||
      value.channel !== expected.channel ||
      value.from !== expected.from ||
      value.to !== expected.to ||
      typeof value.id !== "string" ||
      value.id.length < 1 ||
      value.id.length > 200 ||
      typeof value.value !== "string" ||
      value.value.length < 1 ||
      value.value.length > 100
    ) {
      return null;
    }
    return value as CursorPayload;
  } catch {
    return null;
  }
}

function validChannel(value: string | null): Channel | null {
  return value && Object.values(Channel).includes(value as Channel)
    ? (value as Channel)
    : null;
}

function cursorCondition(
  cursor: CursorPayload,
  side: "after" | "before",
): Prisma.OrderWhereInput | null {
  const after = side === "after";
  if (cursor.sort === "recent") {
    const at = new Date(cursor.value);
    if (Number.isNaN(at.getTime())) return null;
    const operator = after ? "lt" : "gt";
    return {
      OR: [
        { processedAt: { [operator]: at } },
        {
          processedAt: at,
          id: { [operator]: cursor.id },
        },
      ],
    };
  }

  try {
    const profit = new Prisma.Decimal(cursor.value);
    const canonicalDescending = cursor.sort === "best";
    const operator =
      after === canonicalDescending ? ("lt" as const) : ("gt" as const);
    return {
      OR: [
        { netProfit: { [operator]: profit } },
        { netProfit: profit, id: { [operator]: cursor.id } },
      ],
    };
  } catch {
    return null;
  }
}

function orderBy(
  sort: OrderSortKey,
  reverse: boolean,
): Prisma.OrderOrderByWithRelationInput[] {
  const canonical = sort === "worst" ? "asc" : "desc";
  const direction = reverse
    ? canonical === "asc"
      ? "desc"
      : "asc"
    : canonical;
  const field = sort === "recent" ? "processedAt" : "netProfit";
  return [{ [field]: direction }, { id: direction }];
}

const orderProfitSelect = {
  id: true,
  orderNumber: true,
  processedAt: true,
  customerId: true,
  channel: true,
  campaignId: true,
  isFirstOrder: true,
  subtotal: true,
  discountTotal: true,
  shippingCharged: true,
  total: true,
  taxTotal: true,
  refundedTotal: true,
  returnFeesRetained: true,
  cogsTotal: true,
  adCostAttributed: true,
  overheadAllocated: true,
  contributionProfit: true,
  netProfit: true,
  materializedPaymentFee: true,
  materializedPickPackCost: true,
  materializedOutboundShippingCost: true,
  materializedReturnShippingCost: true,
  materializedUnits: true,
  materializedMissingCogs: true,
  materializedModeledCosts: true,
} satisfies Prisma.OrderSelect;

type PageRow = Prisma.OrderGetPayload<{ select: typeof orderProfitSelect }>;

function cursorFor(
  row: PageRow,
  expected: Omit<CursorPayload, "v" | "id" | "value">,
): string {
  return encodeCursor({
    v: 1,
    ...expected,
    id: row.id,
    value:
      expected.sort === "recent"
        ? row.processedAt.toISOString()
        : row.netProfit.toString(),
  });
}

export interface LoadOrderPageInput {
  shopId: string;
  range: DateRange;
  sort: OrderSortKey;
  channelFilter: string | null;
  requestedPage: number;
  after: string | null;
  before: string | null;
}

/**
 * Load only one table page from the materialized profit ledger.
 *
 * The all-range order field and daily chart intentionally retain their lean
 * two-column/full-range inputs. The table no longer copies, sorts and slices
 * every profit object merely to show sixty rows. A temporarily incomplete
 * ledger returns null so the caller can use the exact live engine result until
 * the durable recompute finishes rather than hide new orders.
 */
export async function loadOrderPage(input: LoadOrderPageInput) {
  const channel = validChannel(input.channelFilter);
  const rangeWhere = {
    shopId: input.shopId,
    processedAt: { gte: input.range.from, lte: input.range.to },
  } satisfies Prisma.OrderWhereInput;
  const filteredWhere = {
    ...rangeWhere,
    ...(channel ? { channel } : {}),
  } satisfies Prisma.OrderWhereInput;

  const [allCount, computedCount, total] = await Promise.all([
    prisma.order.count({ where: rangeWhere }),
    prisma.order.count({
      where: { ...rangeWhere, computedAt: { not: null } },
    }),
    prisma.order.count({
      where: { ...filteredWhere, computedAt: { not: null } },
    }),
  ]);
  if (allCount !== computedCount) return null;

  const pageCount = Math.max(1, Math.ceil(total / ORDER_PAGE_SIZE));
  const requested = Number.isFinite(input.requestedPage)
    ? Math.trunc(input.requestedPage)
    : 1;
  const page = Math.min(Math.max(1, requested), pageCount);
  const expected = {
    sort: input.sort,
    channel: channel ?? null,
    from: input.range.from.toISOString(),
    to: input.range.to.toISOString(),
  };
  const before = decodeCursor(input.before, expected);
  const after = before ? null : decodeCursor(input.after, expected);
  const side = before ? "before" : after ? "after" : null;
  const cursor = before ?? after;
  const condition = cursor && side ? cursorCondition(cursor, side) : null;
  const reverse = side === "before";

  const rows = await prisma.order.findMany({
    where: {
      ...filteredWhere,
      computedAt: { not: null },
      ...(condition ?? {}),
    },
    orderBy: orderBy(input.sort, reverse),
    // Old page-number bookmarks remain valid through a bounded offset
    // fallback. Every link emitted from this response uses keyset cursors.
    ...(side ? {} : { skip: (page - 1) * ORDER_PAGE_SIZE }),
    take: ORDER_PAGE_SIZE + 1,
    select: orderProfitSelect,
  });

  const hasMore = rows.length > ORDER_PAGE_SIZE;
  const selected = rows.slice(0, ORDER_PAGE_SIZE);
  if (reverse) selected.reverse();
  const hasPrevious = side === "before" ? hasMore : Boolean(after) || page > 1;
  const hasNext = side === "before" ? true : hasMore;

  return {
    rows: selected.map(toMaterializedOrderProfit),
    total,
    page,
    pageCount,
    previousCursor:
      hasPrevious && selected[0] ? cursorFor(selected[0], expected) : null,
    nextCursor:
      hasNext && selected.at(-1) ? cursorFor(selected.at(-1)!, expected) : null,
  };
}
