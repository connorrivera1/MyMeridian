import { describe, expect, it } from "vitest";

import {
  buildCustomerJourneys,
  buildJourneysFromRows,
  computeCampaignPerformance,
  computeChannelPerformance,
} from "./acquisition";
import { computeProfitForPeriod } from "./profit";
import {
  ZERO_COST_RULES,
  type AdSpendRow,
  type Channel,
  type EngineOrder,
} from "./types";

const TZ = "America/New_York";
const PERIOD_START = new Date("2026-01-01T00:00:00Z");
const PERIOD_END = new Date("2026-03-31T23:59:59Z");

function order(args: {
  id: string;
  customerId: string;
  at: string;
  channel: Channel;
  campaignId?: string | null;
  priceCents: number;
  costCents: number;
  isFirstOrder?: boolean;
}): EngineOrder {
  return {
    id: args.id,
    orderNumber: 1,
    processedAt: new Date(args.at),
    customerId: args.customerId,
    channel: args.channel,
    campaignId: args.campaignId ?? null,
    isFirstOrder: args.isFirstOrder ?? false,
    subtotalCents: args.priceCents,
    discountTotalCents: 0,
    shippingChargedCents: 0,
    taxTotalCents: 0,
    totalCents: args.priceCents,
    refundedTotalCents: 0,
    returnFeesRetainedCents: 0,
    returnShippingCostCents: 0,
    actualShippingCostCents: 0,
    actualPickPackCostCents: 0,
    lineItems: [
      {
        id: `li-${args.id}`,
        productId: "p1",
        variantId: "v1",
        title: "Product",
        quantity: 1,
        refundedQty: 0,
        unitPriceCents: args.priceCents,
        discountCents: 0,
        unitCostMicros: args.costCents * 100,
      },
    ],
  };
}

function spendRow(over: Partial<AdSpendRow> & { date: Date }): AdSpendRow {
  return {
    channel: "FACEBOOK",
    campaignId: null,
    campaignName: null,
    spendCents: 0,
    impressions: 0,
    clicks: 0,
    platformConversions: 0,
    platformRevenueCents: 0,
    ...over,
  };
}

/**
 * Ten customers acquired on the same Facebook day, each returning 20 days later
 * through a direct visit. Round numbers so the cohort maths is checkable by hand.
 */
function buildCohort() {
  const orders: EngineOrder[] = [];

  for (let i = 1; i <= 10; i++) {
    orders.push(
      order({
        id: `first-${i}`,
        customerId: `c${i}`,
        at: "2026-01-05T15:00:00Z",
        channel: "FACEBOOK",
        campaignId: "camp-a",
        priceCents: 20_000,
        costCents: 6000,
        isFirstOrder: true,
      }),
    );
    orders.push(
      order({
        id: `repeat-${i}`,
        customerId: `c${i}`,
        at: "2026-01-25T15:00:00Z",
        channel: "DIRECT",
        priceCents: 20_000,
        costCents: 5000,
      }),
    );
  }

  // $1,000 of spend against 10 acquired customers => $100 CAC.
  const spend = [
    spendRow({
      date: new Date("2026-01-05T12:00:00Z"),
      channel: "FACEBOOK",
      campaignId: "camp-a",
      campaignName: "Prospecting — Broad",
      spendCents: 100_000,
      platformRevenueCents: 260_000, // platform over-reports
    }),
  ];

  const period = computeProfitForPeriod(orders, spend, ZERO_COST_RULES, TZ);

  return { orders, spend, profits: period.orders };
}

/**
 * The same ten acquisitions, plus ten customers who were already customers
 * before this window opened and simply ordered through Facebook again inside
 * it.
 *
 * This is what a real store looks like and what a fixture built only from
 * acquisitions cannot show: from inside the window the two groups are
 * identical apart from `isFirstOrder`. The returners are placed on a different
 * day from the spend row so they take no ad cost, which keeps CAC arithmetic
 * the only thing that moves.
 */
function buildCohortWithReturners() {
  const { orders, spend } = buildCohort();

  for (let i = 11; i <= 20; i++) {
    orders.push(
      order({
        id: `returner-${i}`,
        customerId: `c${i}`,
        at: "2026-01-10T15:00:00Z",
        channel: "FACEBOOK",
        campaignId: "camp-a",
        priceCents: 20_000,
        costCents: 6000,
      }),
    );
  }

  const period = computeProfitForPeriod(orders, spend, ZERO_COST_RULES, TZ);

  return { orders, spend, profits: period.orders };
}

describe("buildCustomerJourneys", () => {
  it("credits a customer to the channel that first brought them in", () => {
    const { orders, profits } = buildCohort();
    const journeys = buildCustomerJourneys(orders, profits);

    expect(journeys).toHaveLength(10);
    expect(journeys.every((j) => j.channel === "FACEBOOK")).toBe(true);
    expect(journeys[0]!.timeline).toHaveLength(2);
    expect(journeys[0]!.timeline[1]!.dayOffset).toBe(20);
  });

  it("ignores orders with no customer attached", () => {
    const guest = order({
      id: "guest",
      customerId: "",
      at: "2026-01-05T15:00:00Z",
      channel: "DIRECT",
      priceCents: 1000,
      costCents: 500,
    });
    guest.customerId = null;

    expect(buildCustomerJourneys([guest], [])).toHaveLength(0);
  });

  it("marks a journey that opens on a repeat order as not acquired here", () => {
    const { orders, profits } = buildCohort();
    const acquired = buildCustomerJourneys(orders, profits);
    expect(acquired.every((j) => j.acquiredInWindow)).toBe(true);

    // The same customer seen from a window that starts after they were
    // acquired: the acquiring order is absent and the repeat leads the journey.
    const returning = buildCustomerJourneys(
      [
        order({
          id: "repeat-only",
          customerId: "c1",
          at: "2026-01-25T15:00:00Z",
          channel: "DIRECT",
          priceCents: 20_000,
          costCents: 5000,
        }),
      ],
      [],
    );

    expect(returning).toHaveLength(1);
    expect(returning[0]!.acquiredInWindow).toBe(false);
  });
});

describe("buildJourneysFromRows", () => {
  const cohortRow = (over: {
    customerId: string;
    at: string;
    isFirstOrder: boolean;
    contributionProfitCents: number;
  }) => ({
    customerId: over.customerId,
    processedAt: new Date(over.at),
    channel: "FACEBOOK" as Channel,
    campaignId: null,
    isFirstOrder: over.isFirstOrder,
    contributionProfitCents: over.contributionProfitCents,
    adCostCents: 0,
  });

  it("carries the acquisition flag through from the materialised rows", () => {
    const journeys = buildJourneysFromRows([
      cohortRow({
        customerId: "c1",
        at: "2026-01-05T00:00:00Z",
        isFirstOrder: true,
        contributionProfitCents: 10_000,
      }),
      cohortRow({
        customerId: "c2",
        at: "2026-01-06T00:00:00Z",
        isFirstOrder: false,
        contributionProfitCents: 2000,
      }),
    ]);

    expect(journeys.map((j) => j.acquiredInWindow)).toEqual([true, false]);
  });

  it("keeps customers with no visible first order out of the value curve", () => {
    const journeys = buildJourneysFromRows([
      cohortRow({
        customerId: "c1",
        at: "2026-01-05T00:00:00Z",
        isFirstOrder: true,
        contributionProfitCents: 10_000,
      }),
      // Acquired before the lookback begins. Their opening orders are missing,
      // so this journey is a fragment with a false day zero.
      cohortRow({
        customerId: "c2",
        at: "2026-01-06T00:00:00Z",
        isFirstOrder: false,
        contributionProfitCents: 2000,
      }),
    ]);

    const orders = [
      order({
        id: "o1",
        customerId: "c1",
        at: "2026-01-05T15:00:00Z",
        channel: "FACEBOOK",
        priceCents: 20_000,
        costCents: 6000,
        isFirstOrder: true,
      }),
    ];
    const spend = [
      spendRow({
        date: new Date("2026-01-05T12:00:00Z"),
        channel: "FACEBOOK",
        spendCents: 10_000,
      }),
    ];
    const period = computeProfitForPeriod(orders, spend, ZERO_COST_RULES, TZ);

    const facebook = computeChannelPerformance(orders, period.orders, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      cohortJourneys: journeys,
      cohortEnd: new Date("2026-06-01T00:00:00Z"),
    }).find((c) => c.channel === "FACEBOOK")!;

    const day90 = facebook.ltvCurve.find((p) => p.day === 90)!;

    // One measurable customer worth $100 — not two averaging $60.
    expect(day90.cohortSize).toBe(1);
    expect(day90.cumulativeProfitPerCustomerCents).toBe(10_000);
  });
});

describe("computeChannelPerformance", () => {
  it("propagates missing COGS and modeled costs into channel quality", () => {
    const qualityOrder = order({
      id: "quality-order",
      customerId: "quality-customer",
      at: "2026-01-05T15:00:00Z",
      channel: "FACEBOOK",
      campaignId: "quality-campaign",
      priceCents: 10_000,
      costCents: 0,
      isFirstOrder: true,
    });
    const modeledRules = {
      ...ZERO_COST_RULES,
      paymentFixedPerOrderCents: 30,
    };
    const period = computeProfitForPeriod([qualityOrder], [], modeledRules, TZ);

    const [channel] = computeChannelPerformance(
      [qualityOrder],
      period.orders,
      [],
      { periodStart: PERIOD_START, periodEnd: PERIOD_END },
    );
    const [campaign] = computeCampaignPerformance(
      [qualityOrder],
      period.orders,
      [
        spendRow({
          date: new Date("2026-01-05T12:00:00Z"),
          campaignId: "quality-campaign",
          campaignName: "Quality",
          spendCents: 100,
        }),
      ],
    );

    expect(channel).toMatchObject({
      hasMissingCogs: true,
      usesModeledCosts: true,
    });
    expect(campaign).toMatchObject({
      hasMissingCogs: true,
      usesModeledCosts: true,
    });
  });

  it("computes CAC from spend and customers actually acquired", () => {
    const { orders, spend, profits } = buildCohort();

    const facebook = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    expect(facebook.newCustomers).toBe(10);
    expect(facebook.spendCents).toBe(100_000);
    expect(facebook.cacCents).toBe(10_000); // $100
  });

  it("measures the first order net of the ad spend that produced it", () => {
    const { orders, spend, profits } = buildCohort();

    const facebook = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    // $200 revenue − $60 COGS − $100 attributed ad spend = $40.
    expect(facebook.firstOrderProfitPerCustomerCents).toBe(4000);
  });

  it("follows the cohort's later orders even when they arrive through another channel", () => {
    const { orders, spend, profits } = buildCohort();

    const facebook = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    const day0 = facebook.ltvCurve.find((p) => p.day === 0)!;
    const day30 = facebook.ltvCurve.find((p) => p.day === 30)!;

    // The curve is contribution *before* marketing: $200 − $60 = $140.
    expect(day0.cumulativeProfitPerCustomerCents).toBe(14_000);
    // Repeat order adds $200 − $50 = $150.
    expect(day30.cumulativeProfitPerCustomerCents).toBe(29_000);
    expect(day30.cohortSize).toBe(10);
  });

  it("does not charge the same ad spend twice when measuring payback", () => {
    const { orders, spend, profits } = buildCohort();

    const facebook = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    // First-order profit is net of the $100 ad cost: $140 − $100 = $40.
    expect(facebook.firstOrderProfitPerCustomerCents).toBe(4000);

    // Payback compares the $140 gross contribution against the $100 CAC, so it
    // lands on day zero. Comparing the $40 net figure against CAC would deduct
    // the same advertising twice and report "never".
    expect(facebook.paybackDays).toBe(0);
  });

  it("refuses to report a checkpoint the cohort has not aged into", () => {
    const { orders, spend, profits } = buildCohort();

    // Acquired 5 Jan, data ends 31 Mar — 85 days, so 90 is not yet measurable.
    const truncated = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    const day90 = truncated.ltvCurve.find((p) => p.day === 90)!;

    expect(day90.measurable).toBe(false);
    expect(day90.cohortSize).toBe(0);

    // Given two more weeks of data the same cohort reports a real 90-day figure
    // rather than being diluted to zero.
    const matured = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: new Date("2026-04-30T23:59:59Z"),
    }).find((c) => c.channel === "FACEBOOK")!;

    const matureDay90 = matured.ltvCurve.find((p) => p.day === 90)!;

    expect(matureDay90.measurable).toBe(true);
    expect(matureDay90.cohortSize).toBe(10);
    expect(matured.ltv90Cents).toBe(29_000);
    expect(matured.ltvToCacRatio).toBeCloseTo(2.9, 5);
    expect(matured.verdict).toBe("PROFITABLE");
  });

  it("does not let a recent cohort drag payback out to never", () => {
    const { orders, spend, profits } = buildCohort();

    // Add ten customers acquired two days before the data ends. They cannot
    // have repeated yet, and must not be averaged in as zeroes.
    const recentOrders = [...orders];
    for (let i = 11; i <= 20; i++) {
      recentOrders.push(
        order({
          id: `recent-${i}`,
          customerId: `r${i}`,
          at: "2026-03-29T15:00:00Z",
          channel: "FACEBOOK",
          campaignId: "camp-a",
          priceCents: 20_000,
          costCents: 6000,
          isFirstOrder: true,
        }),
      );
    }

    const recomputed = computeProfitForPeriod(
      recentOrders,
      spend,
      ZERO_COST_RULES,
      TZ,
    );

    const facebook = computeChannelPerformance(
      recentOrders,
      recomputed.orders,
      spend,
      { periodStart: PERIOD_START, periodEnd: PERIOD_END },
    ).find((c) => c.channel === "FACEBOOK")!;

    const day30 = facebook.ltvCurve.find((p) => p.day === 30)!;

    // Only the ten mature customers count toward the 30-day figure.
    expect(day30.cohortSize).toBe(10);
    expect(day30.cumulativeProfitPerCustomerCents).toBeGreaterThan(10_000);
    expect(facebook.paybackDays).not.toBeNull();
  });

  it("interpolates the day CAC is paid back", () => {
    const { orders } = buildCohort();

    // Same cohort, double the spend: CAC is $200 against $140 of first-order
    // contribution, so payback genuinely takes until the repeat order.
    const spend = [
      spendRow({
        date: new Date("2026-01-05T12:00:00Z"),
        channel: "FACEBOOK",
        campaignId: "camp-a",
        campaignName: "Prospecting — Broad",
        spendCents: 200_000,
      }),
    ];
    const period = computeProfitForPeriod(orders, spend, ZERO_COST_RULES, TZ);

    const facebook = computeChannelPerformance(orders, period.orders, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    expect(facebook.cacCents).toBe(20_000);
    // Crosses $200 between day 14 ($140) and day 30 ($290).
    expect(facebook.paybackDays).toBe(20);
  });

  it("returns null payback when the cohort never earns its CAC back", () => {
    const orders = [
      order({
        id: "o1",
        customerId: "c1",
        at: "2026-01-05T15:00:00Z",
        channel: "FACEBOOK",
        priceCents: 5000,
        costCents: 4000,
        isFirstOrder: true,
      }),
    ];
    const spend = [
      spendRow({
        date: new Date("2026-01-05T12:00:00Z"),
        channel: "FACEBOOK",
        spendCents: 500_000,
      }),
    ];
    const period = computeProfitForPeriod(orders, spend, ZERO_COST_RULES, TZ);

    const facebook = computeChannelPerformance(orders, period.orders, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    expect(facebook.paybackDays).toBeNull();
    expect(facebook.verdict).toBe("UNPROFITABLE");
  });

  it("surfaces the gap between platform-reported and measured revenue", () => {
    const { orders, spend, profits } = buildCohort();

    const facebook = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    // Facebook claims $2,600; Meridian measures $2,000 of first-order revenue.
    expect(facebook.measuredRoas).toBeCloseTo(2, 5);
    expect(facebook.platformRoas).toBeCloseTo(2.6, 5);
    expect(facebook.attributionGapPct).toBeCloseTo(0.3, 5);
  });

  it("excludes customers acquired before the window from CAC", () => {
    // The shape the loader actually produces. Orders are fetched *for* the
    // reporting window, so the January order that acquired c1 is not in the
    // data at all — the only trace of it is `isFirstOrder: false` on the
    // February order.
    //
    // This test used to hand January orders to a February `periodStart`, which
    // no loader can produce: `acquiredAt` came out in January, the date bounds
    // rejected it, and the test passed. With realisable input the bounds are
    // powerless, because every journey's `acquiredAt` is inside the window by
    // construction — which is exactly how every returning customer came to be
    // counted as an acquisition.
    const orders = [
      order({
        id: "returning",
        customerId: "c1",
        at: "2026-02-10T15:00:00Z",
        channel: "FACEBOOK",
        priceCents: 20_000,
        costCents: 6000,
      }),
    ];
    const spend = [
      spendRow({
        date: new Date("2026-02-10T12:00:00Z"),
        channel: "FACEBOOK",
        spendCents: 100_000,
      }),
    ];
    const period = computeProfitForPeriod(orders, spend, ZERO_COST_RULES, TZ);

    const narrow = computeChannelPerformance(orders, period.orders, spend, {
      periodStart: new Date("2026-02-01T00:00:00Z"),
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    expect(narrow.orders).toBe(1);
    expect(narrow.newCustomers).toBe(0);
    expect(narrow.cacCents).toBeNull();
  });

  it("divides spend by the customers it bought, not the customers it saw", () => {
    const { orders, spend, profits } = buildCohortWithReturners();

    const facebook = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    }).find((c) => c.channel === "FACEBOOK")!;

    // Twenty customers ordered through Facebook inside the window. Ten of them
    // were bought; the other ten were already customers.
    expect(facebook.orders).toBe(20);
    expect(facebook.newCustomers).toBe(10);
    expect(facebook.returningOrders).toBe(10);

    // $1,000 ÷ 10 acquisitions. Counting all twenty gives $50 and makes the
    // channel look twice as efficient as it is.
    expect(facebook.cacCents).toBe(10_000);
  });

  it("does not let a deflated CAC flatter payback or the LTV ratio", () => {
    const { orders, spend, profits } = buildCohortWithReturners();

    const facebook = computeChannelPerformance(orders, profits, spend, {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      cohortEnd: new Date("2026-06-01T00:00:00Z"),
    }).find((c) => c.channel === "FACEBOOK")!;

    // An acquired customer is worth $290 gross of marketing over 90 days:
    // $140 on the acquiring order ($200 − $60 COGS) and $150 on the repeat
    // ($200 − $50). Against a true $100 CAC that is 2.9×.
    //
    // Counting the returners gave $50 CAC *and* averaged their single-order
    // $140 journeys into the curve — $215 over $50, a 4.3× that no cohort in
    // this fixture ever earned.
    expect(facebook.ltv90Measurable).toBe(true);
    expect(facebook.ltv90Cents).toBe(29_000);
    expect(facebook.ltvToCacRatio).toBeCloseTo(2.9, 5);
    expect(facebook.paybackDays).toBe(0);
  });

  it("reports organic channels as having no spend rather than infinite ROAS", () => {
    const orders = [
      order({
        id: "o1",
        customerId: "c1",
        at: "2026-01-05T15:00:00Z",
        channel: "ORGANIC_SEARCH",
        priceCents: 10_000,
        costCents: 3000,
        isFirstOrder: true,
      }),
    ];
    const period = computeProfitForPeriod(orders, [], ZERO_COST_RULES, TZ);

    const organic = computeChannelPerformance(orders, period.orders, [], {
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    })[0]!;

    expect(organic.verdict).toBe("NO_SPEND");
    expect(organic.measuredRoas).toBeNull();
    expect(organic.cacCents).toBe(0);
  });
});

describe("computeCampaignPerformance", () => {
  it("rolls spend and profit up per campaign", () => {
    const { orders, spend, profits } = buildCohort();

    const campaigns = computeCampaignPerformance(orders, profits, spend);

    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]!.campaignName).toBe("Prospecting — Broad");
    expect(campaigns[0]!.newCustomers).toBe(10);
    expect(campaigns[0]!.cacCents).toBe(10_000);
    expect(campaigns[0]!.verdict).toBe("PROFITABLE");
  });

  it("does not credit a campaign with customers it did not acquire", () => {
    const { orders, spend, profits } = buildCohortWithReturners();

    const campaign = computeCampaignPerformance(orders, profits, spend)[0]!;

    // Twenty orders carry camp-a, ten customers were bought by it. This one had
    // no date filter at all, so every returner counted.
    expect(campaign.orders).toBe(20);
    expect(campaign.newCustomers).toBe(10);
    expect(campaign.cacCents).toBe(10_000);
  });
});
