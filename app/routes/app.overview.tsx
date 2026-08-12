import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import {
  ProfitBridge,
  TimeSeriesChart,
  type BridgeStep,
} from "~/design/charts";
import {
  Alert,
  AnimatedInt,
  AnimatedMoney,
  Badge,
  Banner,
  Card,
  Delta,
  Empty,
  IconChannels,
  IconFulfilment,
  IconOrders,
  IconPricing,
  IconProducts,
  Legend,
  Money,
  Tile,
  seriesColor,
} from "~/design/components";
import { formatPercent, ratio } from "~/engine/money";
import { CHANNEL_LABELS, type Channel } from "~/engine/types";
import { planAllows } from "~/lib/plan.server";
import { change, loadDashboard } from "~/lib/route-data.server";
import { bucketWeekly, dailySeries } from "~/lib/series";

export async function loader({ request }: LoaderFunctionArgs) {
  const dashboard = await loadDashboard(request);
  const {
    shop,
    analytics,
    previous,
    rangeLabel,
    preset,
    capabilities,
    plan,
    adSpendCoverage,
  } = dashboard;

  const p = analytics.period;
  const prior = previous.period;

  // The greeting is computed in the shop's own timezone, on the server, so it
  // is right for the merchant and identical on both sides of hydration.
  const hourInShopTz = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: shop.timezone,
    }).format(new Date()),
  );
  const greeting =
    hourInShopTz >= 5 && hourInShopTz < 12
      ? "Good morning,"
      : hourInShopTz >= 12 && hourInShopTz < 18
        ? "Good afternoon,"
        : hourInShopTz >= 18
          ? "Good evening,"
          : "Working late,";
  const kickerDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: shop.timezone,
  }).format(new Date());

  const daily = dailySeries(p.orders, analytics.range, shop.timezone);
  const series = bucketWeekly(daily);

  // Each KPI tile draws its own trend, so the row reads as instruments rather
  // than as a set of numbers with no shape.
  const spark = {
    profit: daily.map((d) => d.netProfitCents),
    revenue: daily.map((d) => d.netRevenueCents),
    contribution: daily.map((d) => d.contributionProfitCents),
    adSpend: daily.map((d) => d.adCostCents),
    orders: daily.map((d) => d.orders),
    perOrder: daily.map((d) =>
      d.orders ? Math.round(d.netProfitCents / d.orders) : 0,
    ),
    aov: daily.map((d) =>
      d.orders ? Math.round(d.netRevenueCents / d.orders) : 0,
    ),
  };

  const bridge: BridgeStep[] = [
    { label: "Net revenue", value: p.netRevenueCents, kind: "start" },
    { label: "COGS", value: -p.cogsCents, kind: "cost" },
    { label: "Shipping", value: -p.shippingCostCents, kind: "cost" },
    { label: "Pick & pack", value: -p.pickPackCents, kind: "cost" },
    { label: "Payment fees", value: -p.paymentFeeCents, kind: "cost" },
    ...(adSpendCoverage.mode === "unavailable" && p.totalAdCostCents === 0
      ? []
      : ([
          {
            label: "Recorded ad spend",
            value: -p.totalAdCostCents,
            kind: "cost",
          },
        ] satisfies BridgeStep[])),
    { label: "Overhead", value: -p.overheadCents, kind: "cost" },
    {
      label:
        adSpendCoverage.mode === "unavailable"
          ? "Profit before paid marketing"
          : "Profit after available costs",
      value: p.netProfitCents,
      kind: "total",
    },
  ];

  const ranked = [...analytics.products].sort(
    (a, b) => b.contributionProfitCents - a.contributionProfitCents,
  );
  const verdictReadyProducts = ranked.filter(
    (product) => !product.hasMissingCogs,
  );

  const missingCogsOrders = p.orders.filter((o) => o.hasMissingCogs).length;
  const modeledCostOrders = p.orders.filter((o) => o.usesModeledCosts).length;

  return {
    rangeLabel,
    preset,
    currency: shop.currency,
    timezone: shop.timezone,
    capabilities,
    adSpendCoverage,
    greeting,
    kickerDate,
    shopName: shop.name,
    // Cost access can be granted and still unused if the merchant never filled
    // in "Cost per item", so the check is on the data, not just the scope.
    missingCogs: missingCogsOrders > 0,
    kpi: {
      netProfitCents: p.netProfitCents,
      netProfitChange: change(p.netProfitCents, prior.netProfitCents),
      netMarginPct: p.netMarginPct,
      netMarginPrior: prior.netMarginPct,
      netRevenueCents: p.netRevenueCents,
      netRevenueChange: change(p.netRevenueCents, prior.netRevenueCents),
      contributionProfitCents: p.contributionProfitCents,
      contributionChange: change(
        p.contributionProfitCents,
        prior.contributionProfitCents,
      ),
      adCostCents: p.totalAdCostCents,
      adCostChange: change(p.totalAdCostCents, prior.totalAdCostCents),
      profitPerOrderCents: p.profitPerOrderCents,
      profitPerOrderChange: change(
        p.profitPerOrderCents,
        prior.profitPerOrderCents,
      ),
      orderCount: p.orderCount,
      orderChange: change(p.orderCount, prior.orderCount),
      aovCents: p.averageOrderValueCents,
      unattributedAdCents: p.unattributedAdCostCents,
      missingCogsOrders,
      modeledCostOrders,
    },
    bridge,
    spark,
    series: series.map((point) => ({
      date: point.date,
      profit: point.netProfitCents,
      revenue: point.netRevenueCents,
    })),
    winners: verdictReadyProducts
      .filter((product) => product.contributionProfitCents >= 0)
      .slice(0, 4)
      .map(compactProduct),
    losers: verdictReadyProducts
      .filter((product) => product.contributionProfitCents < 0)
      .slice(-4)
      .reverse()
      .map(compactProduct),
    channels: analytics.channels
      .filter((channel) => channel.spendCents > 0)
      .map((channel) => ({
        channel: channel.channel,
        spendCents: channel.spendCents,
        cacCents: channel.cacCents,
        ltvToCacRatio: channel.ltvToCacRatio,
        newCustomers: channel.newCustomers,
        verdict: channel.verdict,
      })),
    // Capacity is a Growth feature, so its alerts do not leak onto the
    // overview of a Starter store — the "View capacity" link beside them would
    // land on an upgrade notice.
    alerts: planAllows(plan, "capacity")
      ? analytics.capacity.alerts.slice(0, 2)
      : [],
  };
}

function compactProduct(product: {
  productId: string;
  title: string;
  contributionProfitCents: number;
  marginPct: number | null;
  units: number;
  classification: string;
}) {
  return {
    productId: product.productId,
    title: product.title,
    contributionProfitCents: product.contributionProfitCents,
    marginPct: product.marginPct,
    units: product.units,
    classification: product.classification,
  };
}

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

export default function Overview() {
  const data = useLoaderData<typeof loader>();

  return <OverviewView data={data} />;
}

type OverviewData = Awaited<ReturnType<typeof loader>>;

export function OverviewView({ data }: { data: OverviewData }) {
  const { kpi } = data;
  const adSpendMeasured = data.adSpendCoverage.mode !== "unavailable";
  const profitBasis = adSpendMeasured
    ? "after available costs"
    : "before paid marketing";

  const seriesPoints = data.series.map((point) => ({
    date: new Date(point.date),
    values: { profit: point.profit, revenue: point.revenue },
  }));

  return (
    <>
      {/* The opening move, straight on the sky: the merchant is greeted by
          name, and the number they came for stands under it in sunlight. */}
      <section
        className="greet sky-text"
        aria-label={`Profit ${profitBasis} summary`}
      >
        <p className="greet-kicker">
          {data.kickerDate} · last {data.rangeLabel}
        </p>
        {/* The overview suppresses RouteTitle's h1 in favour of the greeting,
            so the greeting has to BE the h1 — otherwise this page starts at h2
            and has no top-level heading at all. */}
        <h1 className="greet-title">
          {data.greeting} <span className="greet-shop">{data.shopName}</span>
        </h1>
        <div className="greet-figure-row">
          <div className="greet-amount">
            <AnimatedMoney
              cents={kpi.netProfitCents}
              currency={data.currency}
              decimals={false}
            />
          </div>
          <Delta value={kpi.netProfitChange} />
          <span className="greet-caption">
            profit {profitBasis}
            , vs previous {data.rangeLabel}
          </span>
        </div>
        <div className="greet-meta">
          <span className="chip">
            {kpi.netMarginPct === null ? "—" : formatPercent(kpi.netMarginPct)}{" "}
            margin {profitBasis}
          </span>
          <span className="chip">
            <AnimatedInt value={kpi.orderCount} /> orders
          </span>
          <span className="chip">
            <Money cents={kpi.aovCents} currency={data.currency} /> average
            order
          </span>
          <a className="chip solid" href="#bridge">
            Where the money went
          </a>
        </div>
      </section>

      <Banner tone="warn">
          <strong style={{ color: "var(--ink-primary)" }}>
            {adSpendMeasured
              ? "Unconnected paid-marketing spend is excluded."
              : "Paid-marketing spend is not measured."}
          </strong>{" "}
          {adSpendMeasured ? (
            <>
              {data.adSpendCoverage.syncedSourceCount.toLocaleString()} paid
              marketing{" "}
              {data.adSpendCoverage.syncedSourceCount === 1
                ? "source has"
                : "sources have"}{" "}
              completed a sync. Every profit, contribution and margin figure
              includes recorded spend from synced sources only; spend from any
              unconnected account or platform remains outside the calculation.
            </>
          ) : (
            <>
              No paid-marketing source has completed a sync. If this store runs
              ads, every profit, contribution and margin figure excludes that
              cost and may be overstated. The headline is qualified as profit
              before paid marketing, and Ad spend is shown as a dash rather than
              a false zero.
            </>
          )}
      </Banner>

      {data.missingCogs && (
        <Banner tone="warn">
          <strong style={{ color: "var(--ink-primary)" }}>
            {kpi.missingCogsOrders === kpi.orderCount
              ? "Every order in this period is missing at least one COGS input."
              : `${kpi.missingCogsOrders.toLocaleString()} of ${kpi.orderCount.toLocaleString()} ${kpi.missingCogsOrders === 1 ? "order is" : "orders are"} missing at least one COGS input.`}
          </strong>{" "}
          Sold units without a Shopify <em>Cost per item</em> contribute zero
          COGS, so profit for those orders and every rollup containing them may
          be overstated.{" "}
          {data.capabilities.inventoryCost ? (
            <>
              Set <em>Cost per item</em> on the affected variants in Shopify.
              Future orders snapshot the new cost; an unknown historical cost is
              never invented.
            </>
          ) : (
            <>
              This app was installed without the <code>read_inventory</code>{" "}
              scope, which is what exposes cost per item. Contact{" "}
              <Link to="/support">support</Link> or re-authorise the app if
              Shopify prompts you after an approved permissions update.
            </>
          )}
        </Banner>
      )}

      {data.alerts.length > 0 && (
        <Card
          title="Needs Attention"
          actions={
            <Link
              className="btn sm"
              to={`/app/fulfilment?range=${data.preset}`}
            >
              View capacity
            </Link>
          }
          flush
        >
          {data.alerts.map((alert) => (
            <Alert
              key={alert.id}
              severity={alert.severity}
              title={alert.title}
              daysUntil={alert.daysUntil}
            >
              {alert.detail}
            </Alert>
          ))}
        </Card>
      )}

      {/* Six instruments in glass, three to a row. The headline profit lives
          in the greeting above, so no tile has to shout over the others. */}
      <div className="grid cols-3">
        <Tile
          tone="var(--mark-structure)"
          valueTone={
            kpi.netRevenueCents > 0
              ? "positive"
              : kpi.netRevenueCents < 0
                ? "negative"
                : "neutral"
          }
          icon={<IconOrders />}
          label="Net Revenue"
          value={
            <AnimatedMoney
              cents={kpi.netRevenueCents}
              currency={data.currency}
              compact
              decimals={false}
            />
          }
          spark={data.spark.revenue}
          meta={<Delta value={kpi.netRevenueChange} />}
        />
        <Tile
          tone="var(--series-2)"
          valueTone={
            kpi.profitPerOrderCents > 0
              ? "positive"
              : kpi.profitPerOrderCents < 0
                ? "negative"
                : "neutral"
          }
          icon={<IconPricing />}
          label="Profit Per Order"
          value={
            <AnimatedMoney
              cents={kpi.profitPerOrderCents}
              currency={data.currency}
            />
          }
          spark={data.spark.perOrder}
          meta={<Delta value={kpi.profitPerOrderChange} />}
        />
        <Tile
          tone="var(--series-4)"
          valueTone={
            kpi.contributionProfitCents > 0
              ? "positive"
              : kpi.contributionProfitCents < 0
                ? "negative"
                : "neutral"
          }
          icon={<IconProducts />}
          label="Contribution Profit"
          value={
            <AnimatedMoney
              cents={kpi.contributionProfitCents}
              currency={data.currency}
              compact
              decimals={false}
            />
          }
          spark={data.spark.contribution}
          meta={<Delta value={kpi.contributionChange} />}
        />
        <Tile
          tone="var(--series-3)"
          icon={<IconChannels />}
          label={adSpendMeasured ? "Recorded Ad Spend" : "Ad Spend"}
          value={
            adSpendMeasured ? (
              <AnimatedMoney
                cents={kpi.adCostCents}
                currency={data.currency}
                compact
                decimals={false}
              />
            ) : (
              "—"
            )
          }
          spark={adSpendMeasured ? data.spark.adSpend : undefined}
          meta={
            adSpendMeasured ? (
              <Delta value={kpi.adCostChange} invert />
            ) : (
              <span>no synced source</span>
            )
          }
        />
        <Tile
          tone="var(--series-5)"
          icon={<IconOrders />}
          label="Orders"
          value={<AnimatedInt value={kpi.orderCount} />}
          spark={data.spark.orders}
          meta={<Delta value={kpi.orderChange} />}
        />
        <Tile
          tone="var(--series-6)"
          icon={<IconFulfilment />}
          label="Average Order Value"
          value={
            <AnimatedMoney cents={kpi.aovCents} currency={data.currency} />
          }
          spark={data.spark.aov}
          meta={<span>net of discounts and refunds</span>}
        />
      </div>

      <Card
        id="bridge"
        title="Where the Money Went"
        hint="Available recorded and modeled costs between booked revenue and the profit shown above. Missing inputs and unconnected paid-marketing spend are excluded."
      >
        <ProfitBridge steps={data.bridge} />
        {(kpi.unattributedAdCents > 0 || kpi.modeledCostOrders > 0) && (
          <p className="card-hint" style={{ marginTop: 12 }}>
            {kpi.unattributedAdCents > 0 && (
              <>
                <Money
                  cents={kpi.unattributedAdCents}
                  currency={data.currency}
                  decimals={false}
                />{" "}
                of ad spend fell on days with no matching orders. It is real
                money, so it is charged against profit here rather than
                dropped.{" "}
              </>
            )}
            {kpi.modeledCostOrders > 0 && (
              <>
                {kpi.modeledCostOrders.toLocaleString()} orders use at least one
                configured fee, fulfilment fallback or overhead allocation.{" "}
                <Link to={`/app/settings?range=${data.preset}`}>
                  Review modeled inputs
                </Link>{" "}
                to acknowledge them. Review does not turn a model into measured
                order-level cost, so those orders remain marked amber.
              </>
            )}
          </p>
        )}
      </Card>

      <Card title="Profit and Revenue Over Time" flush>
        <Legend
          items={[
            {
              label: `Profit ${profitBasis}`,
              color: "var(--mark-result)",
            },
            { label: "Net revenue", color: "var(--mark-structure)" },
          ]}
        />
        <div style={{ padding: "4px 16px 14px" }}>
          <TimeSeriesChart
            data={seriesPoints}
            timeZone={data.timezone}
            zeroLine
            series={[
              {
                key: "profit",
                label: `Profit ${profitBasis}`,
                color: "var(--mark-result)",
                area: true,
              },
              {
                key: "revenue",
                label: "Net revenue",
                color: "var(--mark-structure)",
              },
            ]}
          />
        </div>
      </Card>

      <div className="grid cols-2">
        <Card
          title="Carrying the Business"
          hint="Highest non-negative contribution after available product-level costs. Overhead and unconnected spend are excluded."
          flush
        >
          <ProductList items={data.winners} currency={data.currency} />
        </Card>

        <Card
          title="Losing Money"
          hint="Negative contribution after available product-level costs; overhead is excluded. Products with missing COGS receive no verdict."
          flush
        >
          {data.losers.length === 0 ? (
            <Empty>No product is losing money in this period.</Empty>
          ) : (
            <ProductList items={data.losers} currency={data.currency} />
          )}
        </Card>
      </div>

      <Card
        title="Customer Acquisition Metrics"
        hint={
          data.capabilities.customers
            ? "Customer value is evaluated only at cohort ages old enough to answer."
            : "Unavailable in this release because read_customers is not requested."
        }
        actions={
          <Link className="btn sm" to={`/app/acquisition?range=${data.preset}`}>
            Full Breakdown
          </Link>
        }
        flush
      >
        {!data.capabilities.customers ? (
          <Empty>
            New-customer counts, CAC, lifetime value and payback are unavailable;
            order-derived channel revenue remains on Acquisition.
          </Empty>
        ) : data.channels.length === 0 ? (
          <Empty>
            {adSpendMeasured
              ? "No ad spend recorded in this period."
              : "Paid-channel metrics are unavailable until a spend source completes a sync."}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="right">Spend</th>
                  <th className="right">New Customers</th>
                  <th className="right">CAC</th>
                  <th
                    className="right"
                    title="90-day customer value against acquisition cost. Value is measured across every cohort old enough to answer, not just this window."
                  >
                    LTV : CAC
                  </th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {data.channels.map((row) => (
                  <tr key={row.channel}>
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
                    <td className="right">
                      <Money
                        cents={row.spendCents}
                        currency={data.currency}
                        decimals={false}
                      />
                    </td>
                    <td className="right num">
                      {row.newCustomers.toLocaleString()}
                    </td>
                    <td className="right">
                      {row.cacCents === null ? (
                        "—"
                      ) : (
                        <Money cents={row.cacCents} currency={data.currency} />
                      )}
                    </td>
                    <td className="right num">
                      {row.ltvToCacRatio === null
                        ? "—"
                        : `${row.ltvToCacRatio.toFixed(2)}×`}
                    </td>
                    <td>
                      <VerdictBadge verdict={row.verdict} />
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

function ProductList({
  items,
  currency,
}: {
  items: ReturnType<typeof compactProduct>[];
  currency: string;
}) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Product</th>
            <th className="right">Units</th>
            <th className="right">Margin</th>
            <th className="right">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.productId}>
              <td className="primary-cell">{item.title}</td>
              <td className="right num">{item.units.toLocaleString()}</td>
              <td className="right num">
                {item.marginPct === null
                  ? "—"
                  : formatPercent(item.marginPct, 0)}
              </td>
              <td className="right">
                <Money
                  cents={item.contributionProfitCents}
                  currency={currency}
                  decimals={false}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VerdictBadge({ verdict }: { verdict: string }) {
  switch (verdict) {
    case "PROFITABLE":
      return <Badge tone="good">Profitable</Badge>;
    case "MARGINAL":
      return <Badge tone="warning">Marginal</Badge>;
    case "UNPROFITABLE":
      return <Badge tone="critical">Losing money</Badge>;
    default:
      return <Badge tone="neutral">No spend</Badge>;
  }
}
