import { useLoaderData, useSearchParams } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { PaybackChart } from "~/design/charts";
import {
  AnimatedMoney,
  Badge,
  Banner,
  Card,
  Empty,
  IconAlert,
  IconChannels,
  IconOrders,
  IconOverview,
  Legend,
  Money,
  Tile,
  seriesColor,
} from "~/design/components";
import { formatPercent } from "~/engine/money";
import { CHANNEL_LABELS, type Channel } from "~/engine/types";
import { loadDashboard } from "~/lib/route-data.server";

import { VerdictBadge } from "./app.overview";

const CHANNEL_ORDER: Channel[] = [
  "FACEBOOK",
  "GOOGLE",
  "TIKTOK",
  "EMAIL",
  "ORGANIC_SEARCH",
  "DIRECT",
  "REFERRAL",
  "AFFILIATE",
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, analytics, rangeLabel, capabilities } =
    await loadDashboard(request);

  const paid = analytics.channels.filter((channel) => channel.spendCents > 0);

  const totalSpend = paid.reduce((sum, c) => sum + c.spendCents, 0);
  const totalNewCustomers = paid.reduce((sum, c) => sum + c.newCustomers, 0);
  const platformClaimed = paid.reduce(
    (sum, c) => sum + (c.platformRoas ?? 0) * c.spendCents,
    0,
  );
  const measured = paid.reduce((sum, c) => sum + c.netRevenueCents, 0);
  const channels = analytics.channels.map((channel) => ({
    channel: channel.channel,
    spendCents: channel.spendCents,
    orders: channel.orders,
    newCustomers: channel.newCustomers,
    cacCents: channel.cacCents,
    firstOrderProfitPerCustomerCents: channel.firstOrderProfitPerCustomerCents,
    ltv90Cents: channel.ltv90Cents,
    ltv90Measurable: channel.ltv90Measurable,
    ltvToCacRatio: channel.ltvToCacRatio,
    paybackDays: channel.paybackDays,
    measuredRoas: channel.measuredRoas,
    platformRoas: channel.platformRoas,
    attributionGapPct: channel.attributionGapPct,
    netRevenueCents: channel.netRevenueCents,
    contributionProfitCents: channel.contributionProfitCents,
    hasMissingCogs: channel.hasMissingCogs,
    usesModeledCosts: channel.usesModeledCosts,
    verdict: channel.verdict,
    ltvCurve: channel.ltvCurve,
  }));
  const campaigns = analytics.campaigns.map((campaign) => ({
    campaignId: campaign.campaignId,
    campaignName: campaign.campaignName,
    channel: campaign.channel,
    spendCents: campaign.spendCents,
    orders: campaign.orders,
    newCustomers: campaign.newCustomers,
    cacCents: campaign.cacCents,
    measuredRoas: campaign.measuredRoas,
    contributionProfitCents: campaign.contributionProfitCents,
    profitPerCustomerCents: campaign.profitPerCustomerCents,
    hasMissingCogs: campaign.hasMissingCogs,
    usesModeledCosts: campaign.usesModeledCosts,
    verdict: campaign.verdict,
  }));

  return {
    rangeLabel,
    currency: shop.currency,
    hasCustomerData: capabilities.customers,
    blended: {
      totalSpendCents: totalSpend,
      newCustomers: totalNewCustomers,
      blendedCacCents: totalNewCustomers
        ? Math.round(totalSpend / totalNewCustomers)
        : null,
      merRatio: totalSpend
        ? analytics.period.netRevenueCents / totalSpend
        : null,
      overclaimCents: Math.round(platformClaimed - measured),
      overclaimPct: measured ? (platformClaimed - measured) / measured : null,
    },
    costQuality: {
      missingCogsChannels: channels.filter((channel) => channel.hasMissingCogs)
        .length,
      modeledCostChannels: channels.filter(
        (channel) => channel.usesModeledCosts,
      ).length,
    },
    channels,
    campaigns,
  };
}

export default function Acquisition() {
  const data = useLoaderData<typeof loader>();

  return <AcquisitionView data={data} />;
}

type AcquisitionData = Awaited<ReturnType<typeof loader>>;

/**
 * The order-derived channel roll-up is useful without either an ad platform or
 * customer identity, so neither missing capability may blank this screen.
 * Customer and spend-dependent analysis is layered on only when both inputs
 * genuinely exist.
 */
export function AcquisitionView({ data }: { data: AcquisitionData }) {
  const [params, setParams] = useSearchParams();

  const hasSpend = data.blended.totalSpendCents > 0;
  const paidChannels = data.channels.filter((c) => c.spendCents > 0);
  const selectedKey = params.get("channel") ?? paidChannels[0]?.channel;
  const selected = paidChannels.find((c) => c.channel === selectedKey);

  return (
    <>
      {hasSpend && (
        <div className="grid cols-4">
          <Tile
            tone="var(--viz-teal)"
            icon={<IconChannels />}
            label="Blended CAC"
            value={
              data.blended.blendedCacCents === null ? (
                "—"
              ) : (
                <AnimatedMoney
                  cents={data.blended.blendedCacCents}
                  currency={data.currency}
                />
              )
            }
            meta={
              <span>
                {data.hasCustomerData
                  ? `all paid spend ÷ ${data.blended.newCustomers.toLocaleString()} new customers`
                  : "customer access required"}
              </span>
            }
          />
          <Tile
            tone="var(--viz-pink)"
            icon={<IconOrders />}
            label="Paid spend"
            value={
              <AnimatedMoney
                cents={data.blended.totalSpendCents}
                currency={data.currency}
                compact
                decimals={false}
              />
            }
            meta={<span>last {data.rangeLabel}</span>}
          />
          <Tile
            tone="var(--viz-mint)"
            icon={<IconOverview />}
            label="Marketing efficiency"
            value={
              data.blended.merRatio === null
                ? "—"
                : `${data.blended.merRatio.toFixed(2)}×`
            }
            meta={<span>store revenue ÷ paid spend</span>}
          />
          <Tile
            tone="var(--viz-amber)"
            icon={<IconAlert />}
            label="Platform over-claim"
            value={
              <AnimatedMoney
                cents={data.blended.overclaimCents}
                currency={data.currency}
                compact
                decimals={false}
              />
            }
            meta={
              <span>
                {data.blended.overclaimPct === null
                  ? "—"
                  : `${formatPercent(data.blended.overclaimPct, 0)} more than measured`}
              </span>
            }
          />
        </div>
      )}

      {!data.hasCustomerData && (
        <Banner tone="warn">
          <strong style={{ color: "var(--ink-primary)" }}>
            Customer-level acquisition metrics are unavailable.
          </strong>{" "}
          This installation does not have <code>read_customers</code>, so new
          customer counts, CAC, lifetime value and payback are left out rather
          than reported as zero. Meridian does not request that protected scope
          before it is approved.
          <br />
          The order count, net revenue and contribution profit below still work.
          Historical imports without customer access cannot read Shopify&rsquo;s
          customer-journey attribution and therefore fall back to Direct; new
          order webhooks retain landing and referring signals when Shopify sends
          them.
        </Banner>
      )}

      {!hasSpend && (
        <Banner>
          <strong style={{ color: "var(--ink-primary)" }}>
            No ad-spend source has completed a sync.
          </strong>{" "}
          Spend, CAC, ROAS, payback and marketing efficiency are unavailable —
          not zero. Meridian never infers spend from orders, because a guessed
          acquisition cost is worse than an absent one.
          <br />
          The channel table below is independent of an ad account: it groups the
          orders Meridian actually received, reports their recorded net revenue,
          and calculates contribution from the available cost inputs.
        </Banner>
      )}

      {(data.costQuality.missingCogsChannels > 0 ||
        data.costQuality.modeledCostChannels > 0) && (
        <Banner tone="warn">
          <strong style={{ color: "var(--ink-primary)" }}>
            Channel profit contains non-measured cost inputs.
          </strong>{" "}
          {data.costQuality.missingCogsChannels > 0 && (
            <>
              {data.costQuality.missingCogsChannels.toLocaleString()} channel
              {data.costQuality.missingCogsChannels === 1
                ? " has"
                : "s have"}{" "}
              sold units with missing Shopify COGS; their contribution and
              verdicts may be overstated and are labelled Needs COGS.{" "}
            </>
          )}
          {data.costQuality.modeledCostChannels > 0 && (
            <>
              {data.costQuality.modeledCostChannels.toLocaleString()} channel
              {data.costQuality.modeledCostChannels === 1
                ? " uses"
                : "s use"}{" "}
              configured fee or fulfilment models. Reviewing those inputs
              acknowledges them but does not make them measured.
            </>
          )}
        </Banner>
      )}

      {data.blended.overclaimCents > 0 && (
        <Banner tone="warn">
          Your ad platforms collectively claim{" "}
          <strong>
            <Money
              cents={data.blended.overclaimCents}
              currency={data.currency}
              decimals={false}
            />
          </strong>{" "}
          more revenue than Meridian can tie to orders. Every platform counts a
          conversion it merely touched, so the same sale gets claimed several
          times over. Budget against the measured figure, not the
          platform&rsquo;s.
        </Banner>
      )}

      <Card
        title="Revenue and profit by channel"
        hint="Net revenue comes from stored orders. Channel uses UTM and referring signals when Shopify supplied them; otherwise the order is classified as Direct. Contribution uses available COGS plus recorded or modeled fulfilment, payment-fee and ad-spend inputs, before overhead."
        flush
      >
        {data.channels.length === 0 ? (
          <Empty>No orders in this period.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="right">Orders</th>
                  <th className="right">Net revenue</th>
                  <th className="right">Contribution profit</th>
                  {hasSpend && <th className="right">Spend</th>}
                </tr>
              </thead>
              <tbody>
                {data.channels.map((row) => (
                  <tr
                    key={row.channel}
                    onClick={() => {
                      if (row.spendCents <= 0) return;
                      const next = new URLSearchParams(params);
                      next.set("channel", row.channel);
                      setParams(next, { preventScrollReset: true });
                    }}
                    style={{
                      cursor: row.spendCents > 0 ? "pointer" : undefined,
                    }}
                  >
                    <td className="primary-cell">
                      <span className="row">
                        <span
                          className="legend-swatch"
                          style={{
                            background: seriesColor(row.channel, CHANNEL_ORDER),
                          }}
                        />
                        {CHANNEL_LABELS[row.channel as Channel]}
                      </span>
                      {(row.hasMissingCogs || row.usesModeledCosts) && (
                        <div className="cell-sub">
                          {[
                            row.hasMissingCogs ? "missing COGS" : null,
                            row.usesModeledCosts ? "modeled costs" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    <td className="right num">{row.orders.toLocaleString()}</td>
                    <td className="right">
                      <Money
                        cents={row.netRevenueCents}
                        currency={data.currency}
                        decimals={false}
                      />
                    </td>
                    <td className="right" style={{ fontWeight: 600 }}>
                      <Money
                        cents={row.contributionProfitCents}
                        currency={data.currency}
                        decimals={false}
                      />
                    </td>
                    {hasSpend && (
                      <td className="right">
                        {row.spendCents > 0 ? (
                          <Money
                            cents={row.spendCents}
                            currency={data.currency}
                            decimals={false}
                          />
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {hasSpend && data.hasCustomerData && (
        <Card
          title="Paid acquisition detail"
          hint="CAC is spend divided by the customers a channel actually acquired. Lifetime value is measured before marketing cost, so comparing it with CAC does not charge the same ad twice."
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="right">New</th>
                  <th className="right">CAC</th>
                  <th className="right">90-day value</th>
                  <th className="right">LTV : CAC</th>
                  <th className="right">Payback</th>
                  <th className="right">ROAS · claimed</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {paidChannels.map((row) => (
                  <tr
                    key={row.channel}
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.set("channel", row.channel);
                      setParams(next, { preventScrollReset: true });
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="primary-cell">
                      <span className="row">
                        <span
                          className="legend-swatch"
                          style={{
                            background: seriesColor(row.channel, CHANNEL_ORDER),
                          }}
                        />
                        {CHANNEL_LABELS[row.channel as Channel]}
                      </span>
                    </td>
                    <td className="right num">
                      {row.newCustomers.toLocaleString()}
                    </td>
                    <td className="right">
                      {row.cacCents ? (
                        <Money cents={row.cacCents} currency={data.currency} />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="right">
                      {row.ltv90Measurable ? (
                        <Money
                          cents={row.ltv90Cents}
                          currency={data.currency}
                        />
                      ) : (
                        <span
                          className="muted"
                          title="No cohort has reached 90 days yet."
                        >
                          not yet
                        </span>
                      )}
                    </td>
                    <td className="right num">
                      {row.ltvToCacRatio === null ? (
                        <span className="muted">—</span>
                      ) : (
                        `${row.ltvToCacRatio.toFixed(2)}×`
                      )}
                    </td>
                    <td className="right num">
                      {row.paybackDays === null ? (
                        row.ltvCurve.some((point) => !point.measurable) ? (
                          <span className="muted">not yet</span>
                        ) : (
                          <Badge tone="critical">Never</Badge>
                        )
                      ) : row.paybackDays === 0 ? (
                        "first order"
                      ) : (
                        `${row.paybackDays} days`
                      )}
                    </td>
                    <td className="right num">
                      {row.measuredRoas === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <>
                          {row.measuredRoas.toFixed(2)}×
                          {row.platformRoas !== null && (
                            <span className="muted">
                              {" · "}
                              {row.platformRoas.toFixed(2)}×
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {row.hasMissingCogs ? (
                        <Badge tone="warning">Needs COGS</Badge>
                      ) : (
                        <VerdictBadge verdict={row.verdict} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {data.hasCustomerData && selected && (
        <Card
          title={`Payback — ${CHANNEL_LABELS[selected.channel as Channel]}`}
          hint="Cumulative contribution per acquired customer, before marketing cost. Where it crosses the CAC line is when this channel starts making money. Click any channel row above to switch."
          flush
        >
          <Legend
            items={[
              {
                label: `${CHANNEL_LABELS[selected.channel as Channel]} cohort value`,
                color: seriesColor(selected.channel, CHANNEL_ORDER),
              },
            ]}
          />
          <div style={{ padding: "4px 16px 14px" }}>
            <PaybackChart
              cacCents={selected.cacCents}
              series={[
                {
                  label: "Cumulative value per customer",
                  color: seriesColor(selected.channel, CHANNEL_ORDER),
                  points: selected.ltvCurve.map((point) => ({
                    day: point.day,
                    valueCents: point.cumulativeProfitPerCustomerCents,
                    measurable: point.measurable,
                  })),
                },
              ]}
            />
          </div>
          {selected.ltvCurve.some((point) => !point.measurable) && (
            <p className="card-hint" style={{ padding: "0 16px 14px" }}>
              Checkpoints past{" "}
              {selected.ltvCurve.filter((p) => p.measurable).at(-1)?.day ?? 0}{" "}
              days are not plotted yet — no customer in this cohort has been
              around that long. They are left out rather than drawn as zero,
              which would make the channel look worse than it is.
            </p>
          )}
        </Card>
      )}

      {hasSpend && data.hasCustomerData && (
        <Card
          title="Campaigns"
          hint="Judged on the orders they produced against what they cost. A campaign can be profitable inside an unprofitable channel, and is usually where the budget decision actually lives."
          flush
        >
          {data.campaigns.length === 0 ? (
            <Empty>No campaign-level spend in this period.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th className="right">Spend</th>
                    <th className="right">Orders</th>
                    <th className="right">New customers</th>
                    <th className="right">CAC</th>
                    <th className="right">ROAS</th>
                    <th className="right">Contribution</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((campaign) => (
                    <tr key={campaign.campaignId}>
                      <td className="primary-cell">
                        <span className="row">
                          <span
                            className="legend-swatch"
                            style={{
                              background: seriesColor(
                                campaign.channel,
                                CHANNEL_ORDER,
                              ),
                            }}
                          />
                          {campaign.campaignName}
                        </span>
                        <div className="cell-sub">
                          {CHANNEL_LABELS[campaign.channel as Channel]}
                        </div>
                      </td>
                      <td className="right">
                        <Money
                          cents={campaign.spendCents}
                          currency={data.currency}
                          decimals={false}
                        />
                      </td>
                      <td className="right num">
                        {campaign.orders.toLocaleString()}
                      </td>
                      <td className="right num">
                        {campaign.newCustomers.toLocaleString()}
                      </td>
                      <td className="right">
                        {campaign.cacCents ? (
                          <Money
                            cents={campaign.cacCents}
                            currency={data.currency}
                          />
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="right num">
                        {campaign.measuredRoas === null
                          ? "—"
                          : `${campaign.measuredRoas.toFixed(2)}×`}
                      </td>
                      <td className="right" style={{ fontWeight: 600 }}>
                        <Money
                          cents={campaign.contributionProfitCents}
                          currency={data.currency}
                          decimals={false}
                        />
                      </td>
                      <td>
                        {campaign.hasMissingCogs ? (
                          <Badge tone="warning">Needs COGS</Badge>
                        ) : (
                          <VerdictBadge verdict={campaign.verdict} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
