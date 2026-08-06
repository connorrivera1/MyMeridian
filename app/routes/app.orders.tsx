import { Link, useLoaderData, useSearchParams } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { BarChart } from "~/design/charts";
import {
  AnimatedInt,
  AnimatedMoney,
  Badge,
  Card,
  Delta,
  Empty,
  IconAlert,
  IconOrders,
  IconOverview,
  IconPricing,
  Money,
  Tile,
  seriesColor,
} from "~/design/components";
import { formatPercent } from "~/engine/money";
import { CHANNEL_LABELS, type Channel } from "~/engine/types";
import { change, loadDashboard } from "~/lib/route-data.server";
import { dailySeries } from "~/lib/series";

const SORTS = {
  recent: "Most recent",
  best: "Most profitable",
  worst: "Least profitable",
} as const;

type SortKey = keyof typeof SORTS;

const PAGE_SIZE = 60;

export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, analytics, previous, rangeLabel, preset } =
    await loadDashboard(request);

  const url = new URL(request.url);
  const sort = (url.searchParams.get("sort") ?? "recent") as SortKey;
  const channelFilter = url.searchParams.get("channel");

  const p = analytics.period;

  let rows = p.orders;
  if (channelFilter) {
    rows = rows.filter((order) => order.channel === channelFilter);
  }

  const sorted = [...rows].sort((a, b) => {
    if (sort === "best") return b.netProfitCents - a.netProfitCents;
    if (sort === "worst") return a.netProfitCents - b.netProfitCents;
    return b.processedAt.getTime() - a.processedAt.getTime();
  });

  const losers = p.orders.filter((order) => order.netProfitCents < 0);
  const lossTotal = losers.reduce((sum, order) => sum + order.netProfitCents, 0);

  const daily = dailySeries(p.orders, analytics.range, shop.timezone);

  return {
    rangeLabel,
    preset,
    sort,
    channelFilter,
    currency: shop.currency,
    channels: [...new Set(p.orders.map((order) => order.channel))].sort(),
    summary: {
      orderCount: p.orderCount,
      profitPerOrderCents: p.profitPerOrderCents,
      profitPerOrderChange: change(
        p.profitPerOrderCents,
        previous.period.profitPerOrderCents,
      ),
      aovCents: p.averageOrderValueCents,
      aovChange: change(
        p.averageOrderValueCents,
        previous.period.averageOrderValueCents,
      ),
      marginPct: p.netMarginPct,
      lossMakingCount: losers.length,
      lossMakingShare: p.orderCount ? losers.length / p.orderCount : 0,
      lossTotalCents: lossTotal,
    },
    // Rendered here, on the server, so the zone has to be stated. Without it
    // the label came out in whatever zone the server runs in while the bucket
    // itself was keyed in the shop's, which is how a day's profit ends up
    // captioned with the day before's date.
    daily: daily.map((day) => ({
      label: day.date.toLocaleDateString("en-US", {
        timeZone: shop.timezone,
        month: "short",
        day: "numeric",
      }),
      value: day.netProfitCents,
    })),
    spark: daily.map((day) =>
      day.orders ? Math.round(day.netProfitCents / day.orders) : 0,
    ),
    total: sorted.length,
    orders: sorted.slice(0, PAGE_SIZE).map((order) => ({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      processedAt: order.processedAt,
      channel: order.channel,
      isFirstOrder: order.isFirstOrder,
      netRevenueCents: order.netRevenueCents,
      cogsCents: order.cogsCents,
      shippingCostCents: order.shippingCostCents,
      feesCents: order.paymentFeeCents + order.pickPackCents,
      adCostCents: order.adCostCents,
      overheadCents: order.overheadCents,
      netProfitCents: order.netProfitCents,
      marginPct: order.netMarginPct,
      units: order.units,
      usesEstimatedCosts: order.usesEstimatedCosts,
    })),
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

export default function Orders() {
  const data = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  const linkWith = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return `?${next.toString()}`;
  };

  return (
    <>
      <div className="grid cols-4">
        <Tile
          tone="var(--viz-mint)"
          icon={<IconPricing />}
          label="Profit per order"
          value={<AnimatedMoney cents={data.summary.profitPerOrderCents} currency={data.currency} />}
          spark={data.spark}
          meta={<Delta value={data.summary.profitPerOrderChange} />}
        />
        <Tile
          tone="var(--viz-blue)"
          icon={<IconOrders />}
          label="Average order value"
          value={<AnimatedMoney cents={data.summary.aovCents} currency={data.currency} />}
          meta={<Delta value={data.summary.aovChange} />}
        />
        <Tile
          tone="var(--viz-teal)"
          icon={<IconOverview />}
          label="Net margin"
          value={
            data.summary.marginPct === null ? "—" : formatPercent(data.summary.marginPct)
          }
          meta={<span>after every allocated cost</span>}
        />
        <Tile
          tone="var(--viz-rose)"
          icon={<IconAlert />}
          label="Orders losing money"
          value={<AnimatedInt value={data.summary.lossMakingCount} />}
          meta={
            <>
              <span>{formatPercent(data.summary.lossMakingShare, 1)} of orders</span>
              <span className="muted">·</span>
              <Money cents={data.summary.lossTotalCents} currency={data.currency} decimals={false} />
            </>
          }
        />
      </div>

      <Card
        title="Daily net profit"
        hint="Includes each day's share of allocated ad spend and fixed overhead, so a quiet day can be genuinely negative."
      >
        <BarChart data={data.daily} label="Net profit" />
      </Card>

      <Card
        title="Orders"
        hint={`${data.total.toLocaleString()} orders in the last ${data.rangeLabel}. Showing ${Math.min(
          data.orders.length,
          data.total,
        ).toLocaleString()}.`}
        actions={
          <>
            <div className="segmented">
              {(Object.keys(SORTS) as SortKey[]).map((key) => (
                <Link
                  key={key}
                  to={linkWith({ sort: key })}
                  aria-current={key === data.sort ? "true" : undefined}
                  preventScrollReset
                >
                  {SORTS[key]}
                </Link>
              ))}
            </div>
          </>
        }
        flush
      >
        <div className="legend" style={{ paddingBottom: 10 }}>
          <span className="legend-item muted">Channel:</span>
          <Link
            to={linkWith({ channel: null })}
            style={{
              fontWeight: data.channelFilter ? 400 : 700,
              color: data.channelFilter ? undefined : "var(--ink-primary)",
            }}
          >
            All
          </Link>
          {data.channels.map((channel) => (
            <Link
              key={channel}
              to={linkWith({ channel })}
              className="legend-item"
              style={{
                fontWeight: data.channelFilter === channel ? 700 : 400,
                color:
                  data.channelFilter === channel ? "var(--ink-primary)" : undefined,
              }}
            >
              <span
                className="legend-swatch"
                style={{ background: seriesColor(channel, CHANNEL_ORDER) }}
              />
              {CHANNEL_LABELS[channel as Channel]}
            </Link>
          ))}
        </div>

        {data.orders.length === 0 ? (
          <Empty>No orders match this filter.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Channel</th>
                  <th className="right">Revenue</th>
                  <th className="right">COGS</th>
                  <th className="right">Shipping</th>
                  <th className="right">Fees</th>
                  <th className="right">Ads</th>
                  <th className="right">Overhead</th>
                  <th className="right">Profit</th>
                  <th className="right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((order) => (
                  <tr key={order.orderId}>
                    <td className="primary-cell">
                      #{order.orderNumber}
                      {order.usesEstimatedCosts && (
                        <>
                          <span
                            className="estimate-flag"
                            title="Some costs on this order are estimates from your cost rules, not measured figures."
                          />
                          <span className="sr-only">
                            {" "}
                            (uses estimated costs)
                          </span>
                        </>
                      )}
                      <div className="cell-sub">
                        {new Date(order.processedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                        {" · "}
                        {order.units} {order.units === 1 ? "item" : "items"}
                        {order.isFirstOrder && " · new customer"}
                      </div>
                    </td>
                    <td>
                      <span className="row">
                        <span
                          className="legend-swatch"
                          style={{
                            background: seriesColor(order.channel, CHANNEL_ORDER),
                          }}
                        />
                        <span className="tiny">
                          {CHANNEL_LABELS[order.channel as Channel]}
                        </span>
                      </span>
                    </td>
                    <td className="right">
                      <Money cents={order.netRevenueCents} currency={data.currency} />
                    </td>
                    <td className="right muted">
                      <Money cents={-order.cogsCents} currency={data.currency} />
                    </td>
                    <td className="right muted">
                      <Money cents={-order.shippingCostCents} currency={data.currency} />
                    </td>
                    <td className="right muted">
                      <Money cents={-order.feesCents} currency={data.currency} />
                    </td>
                    <td className="right muted">
                      <Money cents={-order.adCostCents} currency={data.currency} />
                    </td>
                    <td className="right muted">
                      <Money cents={-order.overheadCents} currency={data.currency} />
                    </td>
                    <td className="right" style={{ fontWeight: 600 }}>
                      <Money cents={order.netProfitCents} currency={data.currency} />
                    </td>
                    <td className="right">
                      {order.marginPct === null ? (
                        "—"
                      ) : order.marginPct < 0 ? (
                        <Badge tone="critical">
                          {formatPercent(order.marginPct, 0)}
                        </Badge>
                      ) : (
                        <span className="num">{formatPercent(order.marginPct, 0)}</span>
                      )}
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
