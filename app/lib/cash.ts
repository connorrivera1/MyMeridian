/**
 * Cash-side revenue: what Shopify actually charged, kept, and owes us.
 *
 * The subscription tables (revenue.ts) answer "what are my active
 * subscriptions worth at list price". This module answers the other question —
 * "what money moved" — from the Partner API's transaction ledger: gross
 * charged, Shopify's processing fee, net to us, including refunds and
 * adjustments the webhook stream never carries.
 *
 * Pure functions over already-fetched rows, same discipline as revenue.ts:
 * the network call lives in the MCP server, the arithmetic lives here with
 * tests. Amounts arrive from the API as decimal strings and are converted to
 * integer cents exactly once, at the boundary.
 */

export interface CashTransactionRow {
  type: string;
  createdAt: string;
  /** Decimal strings as the Partner API sends them; null when the
   *  transaction type does not carry that amount. */
  grossAmount: string | null;
  shopifyFee: string | null;
  netAmount: string | null;
  shop: string | null;
}

export interface CashSummary {
  windowDays: number;
  transactionCount: number;
  grossCents: number;
  feeCents: number;
  netCents: number;
  byType: Record<string, { count: number; netCents: number }>;
}

/** "12.34" → 1234; null/garbage → 0. One rounding, at the boundary. */
export function toCents(amount: string | null): number {
  if (!amount) return 0;
  const parsed = Number.parseFloat(amount);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function summariseCash(
  rows: readonly CashTransactionRow[],
  windowDays: number,
): CashSummary {
  const byType: CashSummary["byType"] = {};

  let grossCents = 0;
  let feeCents = 0;
  let netCents = 0;

  for (const row of rows) {
    const net = toCents(row.netAmount);
    grossCents += toCents(row.grossAmount);
    feeCents += toCents(row.shopifyFee);
    netCents += net;

    const bucket = (byType[row.type] ??= { count: 0, netCents: 0 });
    bucket.count += 1;
    bucket.netCents += net;
  }

  return {
    windowDays,
    transactionCount: rows.length,
    grossCents,
    feeCents,
    netCents,
    byType,
  };
}
