import { ratio, type Cents } from "./money";
import type { AdSpendRow, Channel, EngineOrder, OrderProfit } from "./types";

/**
 * Customer acquisition economics by channel.
 *
 * The load-bearing idea: a channel is not good because it is cheap, it is good
 * because the customers it brings in earn back what they cost. So CAC is always
 * shown next to the contribution profit those same customers went on to
 * generate, and against what the ad platform *claims* it delivered.
 */

export type ChannelVerdict =
  | "PROFITABLE"
  | "MARGINAL"
  | "UNPROFITABLE"
  | "NO_SPEND";

/** Days after acquisition at which cumulative value is sampled. */
export const LTV_CHECKPOINTS = [0, 7, 14, 30, 60, 90] as const;

export interface LtvPoint {
  day: number;
  cumulativeProfitPerCustomerCents: Cents;
  /**
   * Customers who have actually had this many days to come back. A customer
   * acquired last week cannot contribute to a 90-day figure, and averaging them
   * in as a zero is the most common way LTV gets understated.
   */
  cohortSize: number;
  /** False when no customer has aged far enough for this checkpoint yet. */
  measurable: boolean;
}

export interface ChannelPerformance {
  channel: Channel;

  spendCents: Cents;
  impressions: number;
  clicks: number;

  orders: number;
  newCustomers: number;
  returningOrders: number;

  netRevenueCents: Cents;
  contributionProfitCents: Cents;

  /** Blended acquisition cost: all channel spend ÷ customers it acquired. */
  cacCents: Cents | null;
  /**
   * Contribution profit on the acquiring order alone, *after* its ad cost.
   * Positive means the first order already paid for the customer.
   */
  firstOrderProfitPerCustomerCents: Cents;
  /**
   * Cumulative contribution per acquired customer after 90 days, before
   * marketing cost — the figure CAC is measured against.
   */
  ltv90Cents: Cents;
  /** False when no cohort has reached 90 days yet — show "—", never 0. */
  ltv90Measurable: boolean;
  ltvCurve: LtvPoint[];

  /** Days for cumulative profit per customer to cover CAC. Null if it never does. */
  paybackDays: number | null;
  /** 90-day value over acquisition cost. The headline health number. */
  ltvToCacRatio: number | null;

  measuredRoas: number | null;
  platformRoas: number | null;
  /** How much the platform over-reports. Positive = platform claims more than we measure. */
  attributionGapPct: number | null;

  verdict: ChannelVerdict;
}

export interface CampaignPerformance {
  channel: Channel;
  campaignId: string;
  campaignName: string;
  spendCents: Cents;
  orders: number;
  newCustomers: number;
  netRevenueCents: Cents;
  contributionProfitCents: Cents;
  cacCents: Cents | null;
  measuredRoas: number | null;
  profitPerCustomerCents: Cents;
  verdict: ChannelVerdict;
}

const DAY_MS = 86_400_000;

/**
 * Judge a channel on the cohort it acquired, not on the orders that happened to
 * carry its name.
 *
 * A channel that brings in customers who then return by email would look
 * unprofitable under order-level attribution — every repeat order gets credited
 * elsewhere. Measuring 90-day value against CAC asks the question the merchant
 * actually has: does a customer from here earn back what they cost?
 */
function channelVerdict(args: {
  spendCents: Cents;
  cacCents: Cents | null;
  ltv90Cents: Cents;
  ltv90Measurable: boolean;
  contributionProfitCents: Cents;
}): ChannelVerdict {
  if (args.spendCents <= 0) return "NO_SPEND";

  // No cohort yet, or not enough history to judge one — fall back to whether
  // the channel's own orders covered their ad cost.
  if (!args.cacCents || args.cacCents <= 0 || !args.ltv90Measurable) {
    return args.contributionProfitCents > 0 ? "PROFITABLE" : "UNPROFITABLE";
  }

  const ratio = args.ltv90Cents / args.cacCents;
  if (ratio < 1) return "UNPROFITABLE";
  if (ratio < 1.5) return "MARGINAL";
  return "PROFITABLE";
}

function campaignVerdict(
  spendCents: Cents,
  contributionProfitCents: Cents,
): ChannelVerdict {
  if (spendCents <= 0) return "NO_SPEND";
  if (contributionProfitCents <= 0) return "UNPROFITABLE";
  return contributionProfitCents / spendCents < 0.2 ? "MARGINAL" : "PROFITABLE";
}

export interface CustomerJourney {
  customerId: string;
  acquiredAt: Date;
  channel: Channel;
  campaignId: string | null;
  /**
   * True when `acquiredAt` is the customer's genuine first order, and not
   * merely the earliest one that fell inside the loaded window.
   *
   * Journeys are always built from a window of orders, so a customer acquired
   * two years ago who orders again this month is indistinguishable, from inside
   * that window, from someone brand new: their earliest visible order *is* the
   * start of the data. Only the order's own `isFirstOrder` flag can separate
   * them, because it is maintained against the customer's whole history by
   * `reconcileFirstOrder` rather than against whatever the query returned.
   *
   * Everything that divides by "customers acquired" has to filter on this, or
   * it is really dividing by "customers seen".
   */
  acquiredInWindow: boolean;
  timeline: {
    dayOffset: number;
    /** Contribution profit after the ad spend attributed to this order. */
    profitCents: Cents;
    /**
     * Contribution profit *before* marketing cost.
     *
     * Payback is measured against this. Comparing a figure that already has
     * acquisition cost deducted back against CAC charges the merchant for the
     * same ad twice, and makes healthy channels look like they never pay back.
     */
    grossContributionCents: Cents;
  }[];
}

/**
 * Reconstruct each customer's journey from their first order onward.
 * A customer belongs to the channel that brought them in — later orders count
 * toward that channel's return even if they arrived by email or direct.
 */
/**
 * Build journeys from lean materialised rows rather than full engine orders.
 *
 * Used for the long cohort lookback, where loading a year of line items would
 * be prohibitive. Same shape, same downstream maths.
 */
export function buildJourneysFromRows(
  rows: readonly {
    customerId: string;
    processedAt: Date;
    channel: Channel;
    campaignId: string | null;
    isFirstOrder: boolean;
    contributionProfitCents: Cents;
    adCostCents: Cents;
  }[],
): CustomerJourney[] {
  const byCustomer = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byCustomer.get(row.customerId) as typeof rows[number][] | undefined;
    if (bucket) bucket.push(row);
    else byCustomer.set(row.customerId, [row] as never);
  }

  const journeys: CustomerJourney[] = [];

  for (const [customerId, customerRows] of byCustomer) {
    const sorted = [...customerRows].sort(
      (a, b) => a.processedAt.getTime() - b.processedAt.getTime(),
    );
    const first = sorted[0]!;

    journeys.push({
      customerId,
      acquiredAt: first.processedAt,
      channel: first.channel,
      campaignId: first.campaignId,
      acquiredInWindow: first.isFirstOrder,
      timeline: sorted.map((row) => ({
        dayOffset: Math.floor(
          (row.processedAt.getTime() - first.processedAt.getTime()) / DAY_MS,
        ),
        profitCents: row.contributionProfitCents,
        grossContributionCents: row.contributionProfitCents + row.adCostCents,
      })),
    });
  }

  return journeys;
}

export function buildCustomerJourneys(
  orders: readonly EngineOrder[],
  orderProfits: readonly OrderProfit[],
): CustomerJourney[] {
  const profitByOrderId = new Map(orderProfits.map((p) => [p.orderId, p]));

  const byCustomer = new Map<string, EngineOrder[]>();
  for (const order of orders) {
    if (!order.customerId) continue;
    const bucket = byCustomer.get(order.customerId);
    if (bucket) bucket.push(order);
    else byCustomer.set(order.customerId, [order]);
  }

  const journeys: CustomerJourney[] = [];

  for (const [customerId, customerOrders] of byCustomer) {
    const sorted = [...customerOrders].sort(
      (a, b) => a.processedAt.getTime() - b.processedAt.getTime(),
    );
    const first = sorted[0]!;

    journeys.push({
      customerId,
      acquiredAt: first.processedAt,
      channel: first.channel,
      campaignId: first.campaignId,
      acquiredInWindow: first.isFirstOrder,
      timeline: sorted.map((order) => {
        const profit = profitByOrderId.get(order.id);
        return {
          dayOffset: Math.floor(
            (order.processedAt.getTime() - first.processedAt.getTime()) / DAY_MS,
          ),
          profitCents: profit?.contributionProfitCents ?? 0,
          grossContributionCents:
            (profit?.contributionProfitCents ?? 0) + (profit?.adCostCents ?? 0),
        };
      }),
    });
  }

  return journeys;
}

/**
 * Average cumulative contribution profit per acquired customer at each
 * checkpoint, measured only over customers old enough to have reached it.
 *
 * Without this, a channel that acquired heavily in the last month looks like it
 * never pays back — the recent cohort dilutes every checkpoint with zeroes it
 * has not had time to earn.
 */
function ltvCurveFor(
  journeys: readonly CustomerJourney[],
  dataEnd: Date,
): LtvPoint[] {
  return LTV_CHECKPOINTS.map((day) => {
    const eligible = journeys.filter(
      (j) => (dataEnd.getTime() - j.acquiredAt.getTime()) / DAY_MS >= day,
    );

    if (eligible.length === 0) {
      return {
        day,
        cumulativeProfitPerCustomerCents: 0,
        cohortSize: 0,
        measurable: false,
      };
    }

    const total = eligible.reduce((sum, journey) => {
      const upTo = journey.timeline
        .filter((entry) => entry.dayOffset <= day)
        .reduce((s, entry) => s + entry.grossContributionCents, 0);
      return sum + upTo;
    }, 0);

    return {
      day,
      cumulativeProfitPerCustomerCents: Math.round(total / eligible.length),
      cohortSize: eligible.length,
      measurable: true,
    };
  });
}

/**
 * First day on which average cumulative profit per acquired customer covers CAC.
 * Interpolates between checkpoints so the answer isn't always a round number.
 */
function paybackDaysFor(curve: readonly LtvPoint[], cacCents: Cents): number | null {
  if (cacCents <= 0) return 0;

  // Unmeasurable checkpoints are gaps in the evidence, not zeroes.
  const measurable = curve.filter((p) => p.measurable);

  let previous: LtvPoint | null = null;
  for (const point of measurable) {
    if (point.cumulativeProfitPerCustomerCents >= cacCents) {
      if (!previous) return point.day;

      const span =
        point.cumulativeProfitPerCustomerCents -
        previous.cumulativeProfitPerCustomerCents;
      if (span <= 0) return point.day;

      const needed = cacCents - previous.cumulativeProfitPerCustomerCents;
      const fraction = needed / span;
      return Math.round(previous.day + fraction * (point.day - previous.day));
    }
    previous = point;
  }

  return null;
}

export function computeChannelPerformance(
  orders: readonly EngineOrder[],
  orderProfits: readonly OrderProfit[],
  spend: readonly AdSpendRow[],
  options: {
    periodStart: Date;
    periodEnd: Date;
    /**
     * Journeys over a longer lookback, used only for the value curve.
     *
     * Spend and CAC belong to the reporting window — that is this month's cost
     * of acquisition. What a customer is *worth* cannot be measured inside a
     * 30-day window at all, so it is measured across every cohort old enough to
     * answer, and compared against the current CAC.
     */
    cohortJourneys?: readonly CustomerJourney[];
    /** Latest date the cohort data covers, for measurability checks. */
    cohortEnd?: Date;
  },
): ChannelPerformance[] {
  const profitByOrderId = new Map(orderProfits.map((p) => [p.orderId, p]));
  const journeys = buildCustomerJourneys(orders, orderProfits);
  const valueJourneys = options.cohortJourneys ?? journeys;
  const cohortEnd = options.cohortEnd ?? options.periodEnd;

  const channels = new Set<Channel>();
  for (const o of orders) channels.add(o.channel);
  for (const s of spend) channels.add(s.channel);

  const results: ChannelPerformance[] = [];

  for (const channel of channels) {
    const channelSpend = spend.filter((s) => s.channel === channel);
    const spendCents = channelSpend.reduce((sum, s) => sum + s.spendCents, 0);
    const impressions = channelSpend.reduce((sum, s) => sum + s.impressions, 0);
    const clicks = channelSpend.reduce((sum, s) => sum + s.clicks, 0);
    const platformRevenueCents = channelSpend.reduce(
      (sum, s) => sum + s.platformRevenueCents,
      0,
    );

    const channelOrders = orders.filter((o) => o.channel === channel);
    const channelProfits = channelOrders
      .map((o) => profitByOrderId.get(o.id))
      .filter((p): p is OrderProfit => !!p);

    const netRevenueCents = channelProfits.reduce(
      (sum, p) => sum + p.netRevenueCents,
      0,
    );
    const contributionProfitCents = channelProfits.reduce(
      (sum, p) => sum + p.contributionProfitCents,
      0,
    );

    // Only customers actually acquired inside the window — mixing in customers
    // acquired earlier would deflate CAC.
    //
    // `acquiredInWindow` is what does that work, and the date bounds alone
    // cannot. `journeys` is built from the orders loaded *for* this window, so
    // every journey's `acquiredAt` is inside it by construction and the bounds
    // exclude nothing: a customer from two years ago who reorders this month
    // arrives here looking newly acquired. The bounds are kept because callers
    // may pass a journey set built over a wider span than they are reporting on.
    const cohort = journeys.filter(
      (j) =>
        j.channel === channel &&
        j.acquiredInWindow &&
        j.acquiredAt >= options.periodStart &&
        j.acquiredAt <= options.periodEnd,
    );

    const newCustomers = cohort.length;
    const cacCents = newCustomers > 0 ? Math.round(spendCents / newCustomers) : null;

    const firstOrderProfitTotal = cohort.reduce(
      (sum, j) => sum + (j.timeline[0]?.profitCents ?? 0),
      0,
    );

    // Value is measured across every cohort old enough to answer, not just the
    // ones acquired inside the reporting window.
    //
    // Still only customers whose day zero is actually in the data. A customer
    // acquired before the lookback begins has both a false acquisition date and
    // a timeline missing its opening orders, so averaging them into "value per
    // acquired customer" measures a fragment of a journey against a whole CAC.
    const valueCohort = valueJourneys.filter(
      (j) => j.channel === channel && j.acquiredInWindow,
    );
    const curve = ltvCurveFor(valueCohort, cohortEnd);
    const day90 = curve.find((p) => p.day === 90);
    const ltv90Measurable = day90?.measurable ?? false;
    const ltv90Cents = day90?.cumulativeProfitPerCustomerCents ?? 0;

    results.push({
      channel,
      spendCents,
      impressions,
      clicks,
      orders: channelOrders.length,
      newCustomers,
      returningOrders: channelOrders.filter((o) => !o.isFirstOrder).length,
      netRevenueCents,
      contributionProfitCents,
      cacCents,
      firstOrderProfitPerCustomerCents: newCustomers
        ? Math.round(firstOrderProfitTotal / newCustomers)
        : 0,
      ltv90Cents,
      ltvCurve: curve,
      paybackDays: cacCents === null ? null : paybackDaysFor(curve, cacCents),
      ltv90Measurable,
      // Never surfaced as 0.00x when it simply has not been measured — a
      // ratio of zero reads as "worthless", which is a different claim.
      ltvToCacRatio:
        cacCents && ltv90Measurable ? ratio(ltv90Cents, cacCents) : null,
      measuredRoas: ratio(netRevenueCents, spendCents),
      platformRoas: ratio(platformRevenueCents, spendCents),
      attributionGapPct: ratio(
        platformRevenueCents - netRevenueCents,
        netRevenueCents,
      ),
      verdict: channelVerdict({
        spendCents,
        cacCents,
        ltv90Cents,
        ltv90Measurable,
        contributionProfitCents,
      }),
    });
  }

  return results.sort((a, b) => b.spendCents - a.spendCents);
}

export function computeCampaignPerformance(
  orders: readonly EngineOrder[],
  orderProfits: readonly OrderProfit[],
  spend: readonly AdSpendRow[],
): CampaignPerformance[] {
  const profitByOrderId = new Map(orderProfits.map((p) => [p.orderId, p]));
  const journeys = buildCustomerJourneys(orders, orderProfits);

  const campaigns = new Map<
    string,
    { channel: Channel; campaignId: string; campaignName: string; spendCents: Cents }
  >();

  for (const row of spend) {
    if (!row.campaignId) continue;
    const existing = campaigns.get(row.campaignId);
    if (existing) {
      existing.spendCents += row.spendCents;
    } else {
      campaigns.set(row.campaignId, {
        channel: row.channel,
        campaignId: row.campaignId,
        campaignName: row.campaignName ?? row.campaignId,
        spendCents: row.spendCents,
      });
    }
  }

  const results: CampaignPerformance[] = [];

  for (const campaign of campaigns.values()) {
    const campaignOrders = orders.filter((o) => o.campaignId === campaign.campaignId);
    const campaignProfits = campaignOrders
      .map((o) => profitByOrderId.get(o.id))
      .filter((p): p is OrderProfit => !!p);

    const netRevenueCents = campaignProfits.reduce(
      (sum, p) => sum + p.netRevenueCents,
      0,
    );
    const contributionProfitCents = campaignProfits.reduce(
      (sum, p) => sum + p.contributionProfitCents,
      0,
    );

    // Same rule as the channel cohort: a returning customer whose first visible
    // order carried this campaign's id was not acquired by it, and counting
    // them divides the campaign's spend by more customers than it bought.
    const newCustomers = journeys.filter(
      (j) => j.campaignId === campaign.campaignId && j.acquiredInWindow,
    ).length;

    results.push({
      channel: campaign.channel,
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      spendCents: campaign.spendCents,
      orders: campaignOrders.length,
      newCustomers,
      netRevenueCents,
      contributionProfitCents,
      cacCents: newCustomers
        ? Math.round(campaign.spendCents / newCustomers)
        : null,
      measuredRoas: ratio(netRevenueCents, campaign.spendCents),
      profitPerCustomerCents: newCustomers
        ? Math.round(contributionProfitCents / newCustomers)
        : 0,
      verdict: campaignVerdict(campaign.spendCents, contributionProfitCents),
    });
  }

  return results.sort((a, b) => b.spendCents - a.spendCents);
}
