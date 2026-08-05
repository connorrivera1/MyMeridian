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
  UpgradeNotice,
  seriesColor,
} from "~/design/components";
import { formatPercent } from "~/engine/money";
import { CHANNEL_LABELS, type Channel } from "~/engine/types";
import { planAllows, planFor } from "~/lib/plan.server";
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
  const { shop, analytics, rangeLabel, capabilities, plan } =
    await loadDashboard(request);

  const cohortPlan = planFor("cohorts");

  const paid = analytics.channels.filter((channel) => channel.spendCents > 0);

  const totalSpend = paid.reduce((sum, c) => sum + c.spendCents, 0);
  const totalNewCustomers = paid.reduce((sum, c) => sum + c.newCustomers, 0);
  const platformClaimed = paid.reduce(
    (sum, c) => sum + (c.platformRoas ?? 0) * c.spendCents,
    0,
  );
  const measured = paid.reduce((sum, c) => sum + c.netRevenueCents, 0);

  return {
    rangeLabel,
    currency: shop.currency,
    hasCustomerData: capabilities.customers,
    cohorts: {
      allowed: planAllows(plan, "cohorts"),
      planName: cohortPlan.name,
      planPrice: cohortPlan.price,
    },
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
    channels: analytics.channels.map((channel) => ({
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
      verdict: channel.verdict,
      ltvCurve: channel.ltvCurve,
    })),
    campaigns: analytics.campaigns.map((campaign) => ({
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
      verdict: campaign.verdict,
    })),
  };
}

export default function Acquisition() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  const paidChannels = data.channels.filter((c) => c.spendCents > 0);
  const selectedKey = params.get("channel") ?? paidChannels[0]?.channel;
  const selected = data.channels.find((c) => c.channel === selectedKey);

  if (!data.hasCustomerData) {
    return (
      <>
        <Banner tone="warn">
          <strong style={{ color: "var(--ink-primary)" }}>
            This screen needs customer access.
          </strong>{" "}
          Acquisition cost, lifetime value and payback are all measured per
          customer, and this app was installed without the{" "}
          <code>read_customers</code> scope — so Meridian cannot tell whether two
          orders came from the same person. Rather than show you a CAC of zero,
          it shows you nothing.
        </Banner>

        <Card title="What is still working without it">
          <ul
            className="secondary"
            style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9, fontSize: 13 }}
          >
            <li>
              <strong>Profit per order</strong> — revenue, COGS, fulfilment, fees
              and overhead are all order-level and unaffected.
            </li>
            <li>
              <strong>Product profitability</strong> — margins and contribution
              are intact. Only the loss-leader distinction, which depends on
              repeat behaviour, is unavailable.
            </li>
            <li>
              <strong>Pricing</strong> and <strong>fulfilment capacity</strong> —
              fully unaffected.
            </li>
          </ul>
          <p className="card-hint" style={{ marginTop: 14 }}>
            To enable this: add <code>read_customers</code> to{" "}
            <code>[access_scopes]</code> in <code>shopify.app.toml</code>, get a
            Protected Customer Data request approved in the Partner Dashboard
            under <em>App → API access</em>, then reinstall so the store
            re-approves.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="grid cols-4">
        <Tile
          tone="var(--viz-teal)"
          icon={<IconChannels />}
          label="Blended CAC"
          value={
            data.blended.blendedCacCents === null ? (
              "—"
            ) : (
              <AnimatedMoney cents={data.blended.blendedCacCents} currency={data.currency} />
            )
          }
          meta={
            <span>
              all paid spend ÷ {data.blended.newCustomers.toLocaleString()} new customers
            </span>
          }
        />
        <Tile
          tone="var(--viz-pink)"
          icon={<IconOrders />}
          label="Paid spend"
          value={<AnimatedMoney cents={data.blended.totalSpendCents} currency={data.currency} compact decimals={false} />}
          meta={<span>last {data.rangeLabel}</span>}
        />
        <Tile
          tone="var(--viz-mint)"
          icon={<IconOverview />}
          label="Marketing efficiency"
          value={
            data.blended.merRatio === null ? "—" : `${data.blended.merRatio.toFixed(2)}×`
          }
          meta={<span>store revenue ÷ paid spend</span>}
        />
        <Tile
          tone="var(--viz-amber)"
          icon={<IconAlert />}
          label="Platform over-claim"
          value={<AnimatedMoney cents={data.blended.overclaimCents} currency={data.currency} compact decimals={false} />}
          meta={
            <span>
              {data.blended.overclaimPct === null
                ? "—"
                : `${formatPercent(data.blended.overclaimPct, 0)} more than measured`}
            </span>
          }
        />
      </div>

      {data.blended.overclaimCents > 0 && (
        <Banner tone="warn">
          Your ad platforms collectively claim{" "}
          <strong>
            <Money cents={data.blended.overclaimCents} currency={data.currency} decimals={false} />
          </strong>{" "}
          more revenue than Meridian can tie to orders. Every platform counts a
          conversion it merely touched, so the same sale gets claimed several
          times over. Budget against the measured figure, not the platform&rsquo;s.
        </Banner>
      )}

      <Card
        title="Channels"
        hint="CAC is spend divided by the customers a channel actually acquired. LTV is measured before marketing cost, so comparing the two does not charge the same ad twice."
        flush
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="right">Spend</th>
                <th className="right">New</th>
                <th className="right">CAC</th>
                <th className="right" title="Contribution on the acquiring order, after its ad cost.">1st order net</th>
                <th className="right">90-day value</th>
                <th className="right">LTV : CAC</th>
                <th className="right">Payback</th>
                <th className="right" title="What Meridian measured, against what the ad platform claimed.">
                  ROAS · claimed
                </th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map((row) => (
                <tr
                  key={row.channel}
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.set("channel", row.channel);
                    setParams(next, { preventScrollReset: true });
                  }}
                  style={{ cursor: row.spendCents > 0 ? "pointer" : undefined }}
                >
                  <td className="primary-cell">
                    <span className="row">
                      <span
                        className="legend-swatch"
                        style={{ background: seriesColor(row.channel, CHANNEL_ORDER) }}
                      />
                      {CHANNEL_LABELS[row.channel as Channel]}
                    </span>
                  </td>
                  <td className="right">
                    {row.spendCents > 0 ? (
                      <Money cents={row.spendCents} currency={data.currency} decimals={false} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="right num">{row.newCustomers.toLocaleString()}</td>
                  <td className="right">
                    {row.cacCents ? (
                      <Money cents={row.cacCents} currency={data.currency} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="right">
                    <Money cents={row.firstOrderProfitPerCustomerCents} currency={data.currency} />
                  </td>
                  <td className="right">
                    {row.ltv90Measurable ? (
                      <Money cents={row.ltv90Cents} currency={data.currency} />
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
                      <Badge tone="critical">never</Badge>
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
                    <VerdictBadge verdict={row.verdict} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {!data.cohorts.allowed && (
        <UpgradeNotice
          feature="Cohort value and payback curves"
          planName={data.cohorts.planName}
          price={data.cohorts.planPrice}
        >
          The table above judges a channel on the customers it acquired. The
          payback curve shows <em>when</em> each cohort crosses its own
          acquisition cost — which is what tells you whether a channel is
          expensive or merely slow.
        </UpgradeNotice>
      )}

      {data.cohorts.allowed && selected && (
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
              {selected.ltvCurve.filter((p) => p.measurable).at(-1)?.day ?? 0} days
              are not plotted yet — no customer in this cohort has been around
              that long. They are left out rather than drawn as zero, which
              would make the channel look worse than it is.
            </p>
          )}
        </Card>
      )}

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
                            background: seriesColor(campaign.channel, CHANNEL_ORDER),
                          }}
                        />
                        {campaign.campaignName}
                      </span>
                      <div className="cell-sub">
                        {CHANNEL_LABELS[campaign.channel as Channel]}
                      </div>
                    </td>
                    <td className="right">
                      <Money cents={campaign.spendCents} currency={data.currency} decimals={false} />
                    </td>
                    <td className="right num">{campaign.orders.toLocaleString()}</td>
                    <td className="right num">
                      {campaign.newCustomers.toLocaleString()}
                    </td>
                    <td className="right">
                      {campaign.cacCents ? (
                        <Money cents={campaign.cacCents} currency={data.currency} />
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
                      <Money cents={campaign.contributionProfitCents} currency={data.currency} decimals={false} />
                    </td>
                    <td>
                      <VerdictBadge verdict={campaign.verdict} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
