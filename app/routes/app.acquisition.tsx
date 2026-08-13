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
import { loadShopCampaignsSource } from "~/lib/shop-campaigns-status.server";

import { VerdictBadge } from "./app.overview";

const CHANNEL_ORDER: Channel[] = [
  "FACEBOOK",
  "GOOGLE",
  "TIKTOK",
  "SHOP_CAMPAIGNS",
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
  // The ShopifyQL dataset is aggregate reporting. Its spend belongs in the
  // source card and in the P&L, but it cannot enter an order-derived blended
  // CAC denominator until Meridian has a real Shop Campaign-attributed order.
  const cohortPaid = paid.filter(
    (channel) =>
      channel.channel !== "SHOP_CAMPAIGNS" || channel.orders > 0,
  );
  const shopCampaignChannel = analytics.channels.find(
    (channel) => channel.channel === "SHOP_CAMPAIGNS",
  );
  const shopCampaigns = await loadShopCampaignsSource(
    shop.id,
    capabilities.reports,
    (shopCampaignChannel?.spendCents ?? 0) > 0,
    shopCampaignChannel !== undefined,
  );

  const totalSpend = cohortPaid.reduce((sum, c) => sum + c.spendCents, 0);
  const totalNewCustomers = cohortPaid.reduce(
    (sum, c) => sum + c.newCustomers,
    0,
  );
  const platformClaimed = cohortPaid.reduce(
    (sum, c) => sum + (c.platformRoas ?? 0) * c.spendCents,
    0,
  );
  const measured = cohortPaid.reduce((sum, c) => sum + c.netRevenueCents, 0);
  const channels = analytics.channels.map((channel) => ({
    channel: channel.channel,
    spendCents: channel.spendCents,
    orders: channel.orders,
    platformConversions: channel.platformConversions,
    platformRevenueCents: channel.platformRevenueCents,
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
  const campaigns = analytics.campaigns
    .filter(
      (campaign) =>
        campaign.channel !== "SHOP_CAMPAIGNS" || campaign.orders > 0,
    )
    .map((campaign) => ({
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
    hasAnyPaidSpend: paid.length > 0,
    shopCampaigns,
    channels,
    campaigns,
  };
}

export default function Acquisition() {
  const data = useLoaderData<typeof loader>();

  return <AcquisitionView data={data} />;
}

type AcquisitionData = Awaited<ReturnType<typeof loader>>;

function ShopCampaignsCard({ data }: { data: AcquisitionData }) {
  const row = data.channels.find((channel) => channel.channel === "SHOP_CAMPAIGNS");
  const state = data.shopCampaigns;
  const title = "Shop Campaigns";
  const hint =
    "Measured through ShopifyQL when approved. Shopify-reported campaign sales and customers remain separate from Meridian order attribution, so aggregate reporting cannot double-count an order already attributed to Meta, Google, TikTok, or another channel.";

  if (state === "needs_reports") {
    return (
      <Card title={title} hint={hint} actions={<Badge tone="warning">Reports Access Needed</Badge>}>
        <p className="card-hint">
          <code>read_reports</code> is not available for this installation. Shop Campaign spend is unavailable, not $0.
        </p>
      </Card>
    );
  }

  if (state === "needs_approval") {
    return (
      <Card title={title} hint={hint} actions={<Badge tone="warning">Shopify Approval Needed</Badge>}>
        <p className="card-hint">
          ShopifyQL also requires MyMeridian to hold Shopify Level 2 protected-customer-data approval. Shop Campaign spend is unavailable, not $0. Meridian does not query or store shopper identity here. Retry the source from Settings only after Shopify approves that access.
        </p>
      </Card>
    );
  }

  if (state === "syncing") {
    return (
      <Card title={title} hint={hint} actions={<Badge tone="neutral">Awaiting First Sync</Badge>}>
        <p className="card-hint">
          Shopify reports access is connected, but no Shop Campaign report has completed yet. Spend is unavailable, not $0.
        </p>
      </Card>
    );
  }

  if (state === "unavailable") {
    return (
      <Card title={title} hint={hint} actions={<Badge tone="neutral">Unavailable</Badge>}>
        <p className="card-hint">
          This store has no Shop Campaigns source yet. Meridian does not use MyMeridian&rsquo;s own Shopify App Store advertising as merchant spend.
        </p>
      </Card>
    );
  }

  if (state === "empty") {
    return (
      <Card title={title} hint={hint} actions={<Badge tone="good">Synced</Badge>}>
        <p className="card-hint">
          ShopifyQL completed a sync, but returned no Shop Campaign rows for this period. This is distinct from missing access.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title={title}
      hint={hint}
      actions={
        <Badge tone="good">
          {state === "zero" ? "Measured Zero" : "Measured By Shopify"}
        </Badge>
      }
    >
      <div className="grid cols-4">
        <Tile
          tone="var(--viz-teal)"
          label="Shop Campaign Spend"
          value={
            <AnimatedMoney
              cents={row?.spendCents ?? 0}
              currency={data.currency}
              compact
              decimals={false}
            />
          }
          meta={<span>Shopify-Reported</span>}
        />
        <Tile
          tone="var(--viz-blue)"
          label="Shopify-Reported Sales"
          value={
            <AnimatedMoney
              cents={row?.platformRevenueCents ?? 0}
              currency={data.currency}
              compact
              decimals={false}
            />
          }
          meta={<span>Refunds Excluded by Shopify</span>}
        />
        <Tile
          tone="var(--viz-purple)"
          label="Shopify-Reported Customers"
          value={(row?.platformConversions ?? 0).toLocaleString()}
          meta={<span>Not Meridian New-Customer Count</span>}
        />
        <Tile
          tone="var(--viz-amber)"
          label="Shopify ROAS"
          value={
            row?.platformRoas === null || row?.platformRoas === undefined
              ? "—"
              : `${row.platformRoas.toFixed(2)}×`
          }
          meta={<span>Shopify-Reported Sales ÷ Spend</span>}
        />
      </div>
      <p className="card-hint" style={{ marginTop: 12 }}>
        Meridian does not add Shopify&rsquo;s aggregate campaign sales or customers to order-derived revenue, orders, or CAC. When an order has an explicit paid Shop Campaign UTM, it can be shown under this channel; otherwise the aggregate stays source-reported only.
      </p>
    </Card>
  );
}

/**
 * The order-derived channel roll-up is useful without either an ad platform or
 * customer identity, so neither missing capability may blank this screen.
 * Customer and spend-dependent analysis is layered on only when both inputs
 * genuinely exist.
 */
export function AcquisitionView({ data }: { data: AcquisitionData }) {
  const [params, setParams] = useSearchParams();

  const hasSpend = data.blended.totalSpendCents > 0;
  const hasSourceOnlyShopCampaignSpend =
    data.shopCampaigns === "measured" &&
    data.channels.some(
      (channel) =>
        channel.channel === "SHOP_CAMPAIGNS" &&
        channel.spendCents > 0 &&
        channel.orders === 0,
    );
  const paidChannels = data.channels.filter(
    (channel) =>
      channel.spendCents > 0 &&
      // ShopifyQL is aggregate reporting, not an order-level attribution
      // feed. A source-only Shop Campaign appears in its own card instead of
      // pretending there is a Meridian cohort to judge.
      !(channel.channel === "SHOP_CAMPAIGNS" && channel.orders === 0),
  );
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
                  ? `order-attributable paid spend ÷ ${data.blended.newCustomers.toLocaleString()} new customers`
                  : "customer access required"}
              </span>
            }
          />
          <Tile
            tone="var(--viz-pink)"
            icon={<IconOrders />}
            label="Attributed Paid Spend"
            value={
              <AnimatedMoney
                cents={data.blended.totalSpendCents}
                currency={data.currency}
                compact
                decimals={false}
              />
            }
            meta={<span>Last {data.rangeLabel}</span>}
          />
          <Tile
          tone="var(--viz-mint)"
          valueTone={
            data.blended.merRatio !== null && data.blended.merRatio > 0
              ? "positive"
              : "neutral"
          }
            icon={<IconOverview />}
            label="Marketing Efficiency"
            value={
              data.blended.merRatio === null
                ? "—"
                : `${data.blended.merRatio.toFixed(2)}×`
            }
            meta={<span>Store Revenue ÷ Paid Spend</span>}
          />
          <Tile
          tone="var(--viz-amber)"
          valueTone={data.blended.overclaimCents > 0 ? "negative" : "neutral"}
            icon={<IconAlert />}
            label="Platform Over-Claim"
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
                  : `${formatPercent(data.blended.overclaimPct, 0)} More Than Measured`}
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

      {!hasSpend && !hasSourceOnlyShopCampaignSpend && (
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

      {!hasSpend && hasSourceOnlyShopCampaignSpend && (
        <Banner>
          <strong style={{ color: "var(--ink-primary)" }}>
            Shop Campaign spend is available as a separate Shopify-reported source.
          </strong>{" "}
          Meridian has no order-level Shop Campaign attribution in this period,
          so it does not combine that aggregate spend with order-derived CAC,
          ROAS, or platform-overclaim totals.
        </Banner>
      )}

      <ShopCampaignsCard data={data} />

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
              configured fee or fulfilment estimates. Confirming those inputs
              does not make them measured.
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
        title="Revenue And Profit By Channel"
        hint="Net revenue comes from stored orders. Channel uses UTM and referring signals when Shopify supplied them; otherwise the order is classified as Direct. Contribution uses available COGS plus measured or configured fulfilment, payment-fee and ad-spend inputs, before overhead."
        flush
      >
        {data.channels.length === 0 ? (
          <Empty>No Orders In This Period.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="right">Orders</th>
                  <th className="right">Net Revenue</th>
                  <th className="right">Contribution Profit</th>
                  {data.hasAnyPaidSpend && <th className="right">Spend</th>}
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
                            row.hasMissingCogs ? "Missing COGS" : null,
                            row.usesModeledCosts ? "Configured Estimates" : null,
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
                    {data.hasAnyPaidSpend && (
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

      {paidChannels.length > 0 && data.hasCustomerData && (
        <Card
          title="Paid Acquisition Detail"
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
                  <th className="right">90-Day Value</th>
                  <th className="right">LTV : CAC</th>
                  <th className="right">Payback</th>
                  <th className="right">ROAS · Claimed</th>
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
                          Not Yet
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
                          <span className="muted">Not Yet</span>
                        ) : (
                          <Badge tone="critical">Never</Badge>
                        )
                      ) : row.paybackDays === 0 ? (
                        "First Order"
                      ) : (
                        `${row.paybackDays} Days`
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
                label: `${CHANNEL_LABELS[selected.channel as Channel]} Cohort Value`,
                color: seriesColor(selected.channel, CHANNEL_ORDER),
              },
            ]}
          />
          <div style={{ padding: "4px 16px 14px" }}>
            <PaybackChart
              cacCents={selected.cacCents}
              series={[
                {
                  label: "Cumulative Value Per Customer",
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

      {data.campaigns.length > 0 && data.hasCustomerData && (
        <Card
          title="Campaigns"
          hint="Judged on the orders they produced against what they cost. A campaign can be profitable inside an unprofitable channel, and is usually where the budget decision actually lives."
          flush
        >
          {data.campaigns.length === 0 ? (
            <Empty>No Campaign-Level Spend In This Period.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th className="right">Spend</th>
                    <th className="right">Orders</th>
                    <th className="right">New Customers</th>
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
