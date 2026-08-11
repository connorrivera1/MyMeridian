import {
  allocate,
  applyRate,
  costOfUnits,
  ratio,
  sumCents,
  type Cents,
} from "./money";
import type {
  AdSpendRow,
  Channel,
  CostRuleSet,
  EngineOrder,
  OrderProfit,
} from "./types";

/**
 * Day bucketing happens in the merchant's timezone, not UTC.
 *
 * A store in Los Angeles running Facebook ads sees spend reported on Pacific
 * days. Bucketing orders by UTC would shift every evening order into the next
 * day and quietly skew CAC for the whole account.
 */
export function dayKey(date: Date, timeZone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, which sorts correctly as a string.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function monthKey(date: Date, timeZone: string): string {
  return dayKey(date, timeZone).slice(0, 7);
}

// ---------------------------------------------------------------------------
// Ad spend attribution
// ---------------------------------------------------------------------------

export interface AdAttribution {
  byOrderId: Map<string, Cents>;
  /**
   * Spend on days a channel produced no orders. It is real money and it is
   * excluded from per-order costs, so it is surfaced separately rather than
   * dropped — otherwise order-level profit will never reconcile to the P&L.
   */
  unattributedCents: Cents;
  unattributedByChannel: Map<Channel, Cents>;
}

/**
 * Spread each spend row across the orders it plausibly produced.
 *
 * Allocation is *equal per order*, not proportional to order value. An ad does
 * not cost more because the resulting basket was larger, and value-weighting
 * makes big orders look artificially unprofitable.
 *
 * Campaign-level matching is preferred; a spend row only falls back to
 * channel-level when no order carries its campaign id. Each row is allocated
 * exactly once, so nothing is double counted.
 */
export function attributeAdSpend(
  orders: readonly EngineOrder[],
  spend: readonly AdSpendRow[],
  timeZone: string,
): AdAttribution {
  const byCampaignDay = new Map<string, EngineOrder[]>();
  const byChannelDay = new Map<string, EngineOrder[]>();

  for (const order of orders) {
    const day = dayKey(order.processedAt, timeZone);

    const channelKey = `${order.channel}|${day}`;
    const channelBucket = byChannelDay.get(channelKey);
    if (channelBucket) channelBucket.push(order);
    else byChannelDay.set(channelKey, [order]);

    if (order.campaignId) {
      const campaignKey = `${order.campaignId}|${day}`;
      const campaignBucket = byCampaignDay.get(campaignKey);
      if (campaignBucket) campaignBucket.push(order);
      else byCampaignDay.set(campaignKey, [order]);
    }
  }

  const byOrderId = new Map<string, Cents>();
  const unattributedByChannel = new Map<Channel, Cents>();
  let unattributedCents = 0;

  for (const row of spend) {
    if (row.spendCents === 0) continue;

    const day = dayKey(row.date, timeZone);

    const matched =
      (row.campaignId
        ? byCampaignDay.get(`${row.campaignId}|${day}`)
        : undefined) ?? byChannelDay.get(`${row.channel}|${day}`);

    if (!matched || matched.length === 0) {
      unattributedCents += row.spendCents;
      unattributedByChannel.set(
        row.channel,
        (unattributedByChannel.get(row.channel) ?? 0) + row.spendCents,
      );
      continue;
    }

    const shares = allocate(
      row.spendCents,
      matched.map(() => 1),
    );
    matched.forEach((order, i) => {
      byOrderId.set(
        order.id,
        (byOrderId.get(order.id) ?? 0) + (shares[i] ?? 0),
      );
    });
  }

  return { byOrderId, unattributedCents, unattributedByChannel };
}

// ---------------------------------------------------------------------------
// Overhead allocation
// ---------------------------------------------------------------------------

function daysInCalendarMonth(key: string): number {
  const [year, month] = key.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Amortise fixed monthly overhead across each month's orders.
 *
 * Equal per order rather than proportional to revenue: rent, salaries and
 * software scale with how many orders you process, not with basket size.
 *
 * When a reporting window covers only part of a month, only that part of the
 * month's overhead is charged. Without the proration a rolling 30-day window
 * that straddles two calendar months bills two full months of rent — which is
 * both wrong and, because it lands squarely on the headline profit figure,
 * exactly the kind of error that teaches a merchant to distrust the tool.
 */
export function allocateOverhead(
  orders: readonly EngineOrder[],
  monthlyOverheadCents: Cents,
  timeZone: string,
  range?: { from: Date; to: Date },
): Map<string, Cents> {
  const byOrderId = new Map<string, Cents>();
  if (monthlyOverheadCents <= 0) return byOrderId;

  const months = new Map<string, EngineOrder[]>();
  for (const order of orders) {
    const key = monthKey(order.processedAt, timeZone);
    const bucket = months.get(key);
    if (bucket) bucket.push(order);
    else months.set(key, [order]);
  }

  // How many days of each calendar month the window actually covers.
  const coveredDays = new Map<string, number>();
  if (range) {
    const seen = new Set<string>();
    for (
      let t = range.from.getTime();
      t <= range.to.getTime();
      t += 86_400_000
    ) {
      const day = dayKey(new Date(t), timeZone);
      if (seen.has(day)) continue;
      seen.add(day);
      const month = day.slice(0, 7);
      coveredDays.set(month, (coveredDays.get(month) ?? 0) + 1);
    }
  }

  for (const [month, monthOrders] of months) {
    let amount = monthlyOverheadCents;

    if (range) {
      const covered = coveredDays.get(month) ?? 0;
      const total = daysInCalendarMonth(month);
      amount = Math.round(
        (monthlyOverheadCents * Math.min(covered, total)) / total,
      );
    }

    const shares = allocate(
      amount,
      monthOrders.map(() => 1),
    );
    monthOrders.forEach((order, i) => {
      byOrderId.set(order.id, shares[i] ?? 0);
    });
  }

  return byOrderId;
}

// ---------------------------------------------------------------------------
// Per-order profit
// ---------------------------------------------------------------------------

export function computeOrderProfit(
  order: EngineOrder,
  rules: CostRuleSet,
  adCostCents: Cents = 0,
  overheadCents: Cents = 0,
): OrderProfit {
  let cogsCents = 0;
  let units = 0;
  let missingCost = false;

  for (const item of order.lineItems) {
    const soldQty = Math.max(0, item.quantity - item.refundedQty);
    units += soldQty;

    // Refunded units are treated as restocked: their revenue and their COGS
    // both come back out. Return shipping is captured by the shipping cost.
    cogsCents += costOfUnits(item.unitCostMicros, soldQty);

    if (item.unitCostMicros <= 0 && soldQty > 0) missingCost = true;
  }

  const grossRevenueCents = order.subtotalCents;
  const discountCents = order.discountTotalCents;
  const shippingRevenueCents = order.shippingChargedCents;

  // A refund amount from Shopify includes the tax that was returned with it.
  // Revenue here is ex-tax, so the refund has to be reduced to its ex-tax share
  // before it is subtracted. Netting the gross refund against ex-tax revenue
  // over-subtracts by exactly the tax, and on a fully refunded order that drives
  // revenue negative — which then produces a nonsense margin.
  //
  // Return fees complicate the share. A restocking or return-shipping fee the
  // merchant kept is charged ex-tax, so what was *paid back* is the taxed value
  // of the goods minus an untaxed fee. Scaling the paid-back amount alone
  // shaves the tax rate off the fee as well — on a $110 return with a $20 fee
  // at 10% tax, that misreports ~$2 of retained fee as returned tax. The tax
  // share belongs to the full value that came back (refund + fee); the fee then
  // comes out ex-tax, whole.
  const returnFeesRetainedCents = Math.max(0, order.returnFeesRetainedCents);
  const exTaxShare =
    order.totalCents > 0
      ? (order.totalCents - order.taxTotalCents) / order.totalCents
      : 1;
  const refundCents = Math.max(
    0,
    Math.round(
      (order.refundedTotalCents + returnFeesRetainedCents) * exTaxShare,
    ) - returnFeesRetainedCents,
  );

  // Tax is excluded throughout: it is collected on behalf of a tax authority
  // and was never the merchant's revenue.
  const netRevenueCents =
    grossRevenueCents - discountCents + shippingRevenueCents - refundCents;

  const usedDefaultShipping = order.actualShippingCostCents === null;
  const shippingCostCents =
    order.actualShippingCostCents ?? rules.shippingDefaultPerOrderCents;

  const usedDefaultPickPack = order.actualPickPackCostCents === null;
  const pickPackCents =
    order.actualPickPackCostCents ??
    rules.pickPackPerOrderCents + rules.pickPackPerItemCents * units;

  // Processors charge on the full captured amount, tax and shipping included,
  // and do not return the percentage or the fixed fee when you refund. Basing
  // this on the post-refund figure would understate fees on returns-heavy stores.
  const paymentFeeCents =
    applyRate(order.totalCents, rules.paymentPercentRate) +
    rules.paymentFixedPerOrderCents;

  // Confirmation means the merchant reviewed a rule; it does not turn a
  // modelled fee or fallback into measured order-level data. Keep affected
  // orders visibly estimated until a real source supplies the cost.
  const estimatedPaymentFee = paymentFeeCents !== 0;
  const estimatedShippingDefault =
    usedDefaultShipping && shippingCostCents !== 0;
  const estimatedPickPack = usedDefaultPickPack && pickPackCents !== 0;
  // Monthly overhead participates in the net-profit allocation for every
  // order in its month. Even when cent rounding gives a particular order a
  // zero share, its headline still rests on that non-zero monthly assumption.
  const estimatedOverhead = rules.monthlyOverheadCents !== 0;

  // A return label is real fulfilment spend on this order, but unlike outbound
  // shipping there is no modeled fallback: it either exists in the adjustment
  // ledger or the order genuinely had none.
  const returnShippingCostCents = order.returnShippingCostCents;

  const totalCostCents =
    cogsCents +
    shippingCostCents +
    paymentFeeCents +
    pickPackCents +
    adCostCents +
    returnShippingCostCents +
    overheadCents;

  const contributionProfitCents =
    netRevenueCents -
    cogsCents -
    shippingCostCents -
    paymentFeeCents -
    pickPackCents -
    adCostCents -
    returnShippingCostCents;

  const netProfitCents = contributionProfitCents - overheadCents;

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    processedAt: order.processedAt,
    channel: order.channel,
    customerId: order.customerId,
    isFirstOrder: order.isFirstOrder,

    grossRevenueCents,
    discountCents,
    refundCents,
    returnFeesRetainedCents,
    shippingRevenueCents,
    netRevenueCents,

    cogsCents,
    shippingCostCents,
    paymentFeeCents,
    pickPackCents,
    adCostCents,
    overheadCents,
    returnShippingCostCents,
    totalCostCents,

    contributionProfitCents,
    netProfitCents,

    // A margin against zero or negative revenue is not a small number, it is a
    // meaningless one — a fully refunded order would otherwise report something
    // like 26,000%. Report "no margin to compute" instead.
    contributionMarginPct:
      netRevenueCents > 0
        ? ratio(contributionProfitCents, netRevenueCents)
        : null,
    netMarginPct:
      netRevenueCents > 0 ? ratio(netProfitCents, netRevenueCents) : null,

    units,
    hasMissingCogs: missingCost,
    usesModeledCosts:
      estimatedPaymentFee ||
      estimatedShippingDefault ||
      estimatedPickPack ||
      estimatedOverhead,
    usesEstimatedCosts:
      missingCost ||
      estimatedPaymentFee ||
      estimatedShippingDefault ||
      estimatedPickPack ||
      estimatedOverhead,
  };
}

// ---------------------------------------------------------------------------
// Period roll-up
// ---------------------------------------------------------------------------

export interface PeriodProfit {
  orders: OrderProfit[];
  orderCount: number;
  units: number;

  grossRevenueCents: Cents;
  discountCents: Cents;
  refundCents: Cents;
  /** Return/restocking fees retained across the period's refunds. */
  returnFeesRetainedCents: Cents;
  shippingRevenueCents: Cents;
  netRevenueCents: Cents;

  cogsCents: Cents;
  shippingCostCents: Cents;
  paymentFeeCents: Cents;
  pickPackCents: Cents;
  attributedAdCostCents: Cents;
  unattributedAdCostCents: Cents;
  totalAdCostCents: Cents;
  /** Merchant-paid return labels across the period. */
  returnShippingCostCents: Cents;
  overheadCents: Cents;

  contributionProfitCents: Cents;
  /** Net profit including ad spend that could not be tied to any order. */
  netProfitCents: Cents;

  contributionMarginPct: number | null;
  netMarginPct: number | null;
  averageOrderValueCents: Cents;
  profitPerOrderCents: Cents;
}

export function computeProfitForPeriod(
  orders: readonly EngineOrder[],
  spend: readonly AdSpendRow[],
  rules: CostRuleSet,
  timeZone: string,
  /** Reporting window, so partial months are only charged pro rata. */
  range?: { from: Date; to: Date },
): PeriodProfit {
  const attribution = attributeAdSpend(orders, spend, timeZone);
  const overhead = allocateOverhead(
    orders,
    rules.monthlyOverheadCents,
    timeZone,
    range,
  );

  const computed = orders.map((order) =>
    computeOrderProfit(
      order,
      rules,
      attribution.byOrderId.get(order.id) ?? 0,
      overhead.get(order.id) ?? 0,
    ),
  );

  const pick = (fn: (o: OrderProfit) => Cents) => sumCents(computed.map(fn));

  const netRevenueCents = pick((o) => o.netRevenueCents);
  const contributionProfitCents = pick((o) => o.contributionProfitCents);
  const attributedAdCostCents = pick((o) => o.adCostCents);
  const overheadCents = pick((o) => o.overheadCents);

  // Unattributed spend never lands on an order, so it is subtracted here to
  // keep the total honest.
  const netProfitCents =
    contributionProfitCents - overheadCents - attribution.unattributedCents;

  const orderCount = computed.length;

  return {
    orders: computed,
    orderCount,
    units: computed.reduce((sum, o) => sum + o.units, 0),

    grossRevenueCents: pick((o) => o.grossRevenueCents),
    discountCents: pick((o) => o.discountCents),
    refundCents: pick((o) => o.refundCents),
    returnFeesRetainedCents: pick((o) => o.returnFeesRetainedCents),
    shippingRevenueCents: pick((o) => o.shippingRevenueCents),
    netRevenueCents,

    cogsCents: pick((o) => o.cogsCents),
    shippingCostCents: pick((o) => o.shippingCostCents),
    paymentFeeCents: pick((o) => o.paymentFeeCents),
    pickPackCents: pick((o) => o.pickPackCents),
    attributedAdCostCents,
    unattributedAdCostCents: attribution.unattributedCents,
    totalAdCostCents: attributedAdCostCents + attribution.unattributedCents,
    returnShippingCostCents: pick((o) => o.returnShippingCostCents),
    overheadCents,

    contributionProfitCents,
    netProfitCents,

    contributionMarginPct: ratio(contributionProfitCents, netRevenueCents),
    netMarginPct: ratio(netProfitCents, netRevenueCents),
    averageOrderValueCents: orderCount
      ? Math.round(netRevenueCents / orderCount)
      : 0,
    profitPerOrderCents: orderCount
      ? Math.round(netProfitCents / orderCount)
      : 0,
  };
}
