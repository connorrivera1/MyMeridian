import {
  Link,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LoaderFunctionArgs } from "react-router";

import { BarChart, OrderField } from "~/design/charts";
import { ORDER_PAGE_SIZE, type OrderSortKey } from "~/data/order-page";
import { loadOrderPage } from "~/data/order-page.server";
import {
  AnimatedInt,
  AnimatedMoney,
  Badge,
  Banner,
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
import { formatMoney, formatPercent, type Cents } from "~/engine/money";
import { CHANNEL_LABELS, type Channel } from "~/engine/types";
import { withShopContext } from "~/lib/auth.server";
import { change, loadDashboardForContext } from "~/lib/route-data.server";
import { dailySeries } from "~/lib/series";

const SORTS = {
  recent: "Most Recent",
  best: "Most Profitable",
  worst: "Least Profitable",
} as const;

type SortKey = OrderSortKey;
const PAGE_SIZE = ORDER_PAGE_SIZE;

/**
 * Sort, filter and paginate one page's worth of orders for the table.
 *
 * Pulled out of the loader because it is pure — no request, no Prisma — so it
 * can be tested directly against an in-memory array instead of a mocked
 * `loadDashboard`. `page` is 1-based and clamped into range rather than
 * trusted from the URL: an out-of-range `?page=` used to silently return an
 * empty table instead of the last real page or an error.
 */
export function paginateOrders<
  T extends { channel: string; netProfitCents: number; processedAt: Date },
>(
  orders: readonly T[],
  options: { sort: SortKey; channelFilter: string | null; page: number },
): { rows: T[]; total: number; page: number; pageCount: number } {
  const { sort, channelFilter, page: requestedPage } = options;

  const rows = channelFilter
    ? orders.filter((order) => order.channel === channelFilter)
    : orders;

  const sorted = [...rows].sort((a, b) => {
    if (sort === "best") return b.netProfitCents - a.netProfitCents;
    if (sort === "worst") return a.netProfitCents - b.netProfitCents;
    return b.processedAt.getTime() - a.processedAt.getTime();
  });

  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamp rather than trust: a stale bookmark or a hand-edited `?page=` after
  // the filter narrows the set must land somewhere real, not on a blank table.
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pageCount);

  return {
    rows: sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total,
    page,
    pageCount,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, async (ctx) => {
    const {
      shop,
      analytics,
      previous,
      rangeLabel,
      preset,
      range,
      adSpendCoverage,
    } = await loadDashboardForContext(request, ctx);

    const url = new URL(request.url);
    const requestedSort = url.searchParams.get("sort");
    const sort: SortKey =
      requestedSort && requestedSort in SORTS
        ? (requestedSort as SortKey)
        : "recent";
    const channelFilter = url.searchParams.get("channel");
    const requestedPage = Number(url.searchParams.get("page") ?? "1");

    const p = analytics.period;

    const fallbackPage = paginateOrders(p.orders, {
      sort,
      channelFilter,
      page: requestedPage,
    });
    const databasePage = await loadOrderPage({
      shopId: shop.id,
      range,
      sort,
      channelFilter,
      requestedPage,
      after: url.searchParams.get("after"),
      before: url.searchParams.get("before"),
    });
    const pageRows = databasePage?.rows ?? fallbackPage.rows;
    const total = databasePage?.total ?? fallbackPage.total;
    const page = databasePage?.page ?? fallbackPage.page;
    const pageCount = databasePage?.pageCount ?? fallbackPage.pageCount;

    const losers = p.orders.filter((order) => order.netProfitCents < 0);
    const lossTotal = losers.reduce(
      (sum, order) => sum + order.netProfitCents,
      0,
    );

    const daily = dailySeries(p.orders, analytics.range, shop.timezone);

    /*
     * The order field.
     *
     * One entry per order in the range so the whole month can be drawn at once —
     * the marketing page shows this and the product did not, which is backwards:
     * the field is the argument, and the argument belongs where the merchant can
     * act on it.
     *
     * Deliberately two flat arrays rather than an array of objects. At three
     * thousand orders the object form is ~60KB of repeated keys in the HTML
     * payload; this is a third of that and costs nothing to read.
     */
    const field = {
      numbers: p.orders.map((order) => order.orderNumber),
      profits: p.orders.map((order) => order.netProfitCents),
    };

    /*
     * Clicking a dot asks the server for that order rather than shipping every
     * order's full cost breakdown up front. One round trip, and the receipt is
     * the same computed object the table uses.
     */
    const requestedOrder = Number(url.searchParams.get("order"));
    const focused =
      Number.isFinite(requestedOrder) && requestedOrder > 0
        ? (p.orders.find((order) => order.orderNumber === requestedOrder) ??
          null)
        : null;

    return {
      rangeLabel,
      preset,
      sort,
      channelFilter,
      currency: shop.currency,
      timezone: shop.timezone,
      adSpendCoverage,
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
        missingCogsOrders: p.orders.filter((order) => order.hasMissingCogs)
          .length,
        modeledCostOrders: p.orders.filter((order) => order.usesModeledCosts)
          .length,
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
      total,
      page,
      pageCount,
      previousCursor: databasePage?.previousCursor ?? null,
      nextCursor: databasePage?.nextCursor ?? null,
      field,
      focusedOrder: focused
        ? {
            orderNumber: focused.orderNumber,
            processedAt: focused.processedAt,
            channel: focused.channel,
            units: focused.units,
            grossRevenueCents: focused.grossRevenueCents,
            discountCents: focused.discountCents,
            refundCents: focused.refundCents,
            shippingRevenueCents: focused.shippingRevenueCents,
            netRevenueCents: focused.netRevenueCents,
            cogsCents: focused.cogsCents,
            shippingCostCents: focused.shippingCostCents,
            paymentFeeCents: focused.paymentFeeCents,
            pickPackCents: focused.pickPackCents,
            adCostCents: focused.adCostCents,
            overheadCents: focused.overheadCents,
            contributionProfitCents: focused.contributionProfitCents,
            netProfitCents: focused.netProfitCents,
            marginPct: focused.netMarginPct,
            hasMissingCogs: focused.hasMissingCogs,
            usesModeledCosts: focused.usesModeledCosts,
          }
        : null,
      orders: pageRows.map((order) => ({
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
        hasMissingCogs: order.hasMissingCogs,
        usesModeledCosts: order.usesModeledCosts,
        usesEstimatedCosts: order.usesEstimatedCosts,
      })),
    };
  });
}

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

export default function Orders() {
  const data = useLoaderData<typeof loader>();

  return <OrdersView data={data} />;
}

type OrdersData = Awaited<ReturnType<typeof loader>>;

/*
 * One order, opened up.
 *
 * Every number survives as a separate row. The previous inline receipt merged
 * refunds into revenue and payment processing into fulfilment fees, which made
 * a merchant trust a total without being able to audit how it was reached.
 */
export function ProfitBreakdownDrawer({
  order,
  currency,
  adSpendMeasured,
  profitBasisTitle,
  timeZone,
  closeTo,
}: {
  order: NonNullable<OrdersData["focusedOrder"]>;
  currency: string;
  adSpendMeasured: boolean;
  profitBasisTitle: string;
  timeZone: string;
  closeTo: string;
}) {
  // The route content enters with a transform animation. A transformed
  // ancestor creates a containing block for `position: fixed`, turning a
  // viewport drawer into a document-height panel. Keep the server markup
  // deterministic, then lift the hydrated drawer directly under body.
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => setIsMounted(true), []);

  const money = (cents: number) => formatMoney(cents as Cents, currency);
  const deduction = (cents: number) => money(-cents);
  const formulaRow = (
    label: string,
    cents: number,
    options: { tone?: "add" | "subtract"; note?: string } = {},
  ) => (
    <div className="profit-drawer-line">
      <dt>
        <span className={`profit-drawer-symbol ${options.tone ?? "add"}`}>
          {options.tone === "subtract" ? "−" : "+"}
        </span>
        <span>{label}</span>
      </dt>
      <dd>
        {options.tone === "subtract" ? deduction(cents) : money(cents)}
        {options.note && <small>{options.note}</small>}
      </dd>
    </div>
  );

  const drawer = (
    <div className="profit-drawer-scrim">
      <section
        className="profit-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profit-drawer-title"
        aria-describedby="profit-drawer-description"
      >
        <header className="profit-drawer-head">
          <div>
            <p className="profit-drawer-eyebrow">Transparent Math</p>
            <h2 id="profit-drawer-title">Order #{order.orderNumber}</h2>
            <p id="profit-drawer-description" className="profit-drawer-meta">
              {new Date(order.processedAt).toLocaleDateString(undefined, {
                timeZone,
                month: "short",
                day: "numeric",
                year: "numeric",
              })}{" "}
              · {order.units} {order.units === 1 ? "item" : "items"} ·{" "}
              {CHANNEL_LABELS[order.channel as Channel] ?? order.channel}
            </p>
          </div>
          <Link
            className="profit-drawer-close"
            to={closeTo}
            aria-label="Close Profit Breakdown"
          >
            Close
          </Link>
        </header>

        <div className="profit-drawer-scroll">
          <p className="profit-drawer-intro">
            This is the exact order-level math used in MyMeridian&apos;s profit
            totals. Taxes are excluded because they are collected on behalf of
            the tax authority.
          </p>

          <section
            className="profit-drawer-section"
            aria-labelledby="profit-revenue-title"
          >
            <h3 id="profit-revenue-title">1. Revenue Kept</h3>
            <dl className="profit-drawer-lines">
              {formulaRow("Merchandise Subtotal", order.grossRevenueCents)}
              {formulaRow("Discounts", order.discountCents, {
                tone: "subtract",
              })}
              {formulaRow("Shipping Charged", order.shippingRevenueCents)}
              {formulaRow("Refunds (Excluding Tax)", order.refundCents, {
                tone: "subtract",
              })}
              <div className="profit-drawer-total">
                <dt>Net Revenue</dt>
                <dd>{money(order.netRevenueCents)}</dd>
              </div>
            </dl>
          </section>

          <section
            className="profit-drawer-section"
            aria-labelledby="profit-costs-title"
          >
            <h3 id="profit-costs-title">2. Costs Applied</h3>
            <dl className="profit-drawer-lines">
              {formulaRow("Cost of Goods", order.cogsCents, {
                tone: "subtract",
              })}
              {formulaRow("Shipping Cost", order.shippingCostCents, {
                tone: "subtract",
              })}
              {formulaRow("Payment Processing", order.paymentFeeCents, {
                tone: "subtract",
              })}
              {formulaRow("Pick & Pack", order.pickPackCents, {
                tone: "subtract",
              })}
              {adSpendMeasured
                ? formulaRow("Attributed Ad Spend", order.adCostCents, {
                    tone: "subtract",
                    note: "Recorded Source",
                  })
                : formulaRow("Paid Marketing", 0, {
                    note: "Not Included — No Synced Source",
                  })}
              <div className="profit-drawer-total">
                <dt>Contribution Profit</dt>
                <dd>{money(order.contributionProfitCents)}</dd>
              </div>
              {formulaRow("Allocated Overhead", order.overheadCents, {
                tone: "subtract",
              })}
              <div className="profit-drawer-result">
                <dt>
                  <span>3. Profit {profitBasisTitle}</span>
                  <small>
                    {order.marginPct === null
                      ? "No margin where revenue is zero"
                      : `${formatPercent(order.marginPct)} margin`}
                  </small>
                </dt>
                <dd>{money(order.netProfitCents)}</dd>
              </div>
            </dl>
          </section>

          {(order.hasMissingCogs || order.usesModeledCosts) && (
            <aside
              className="profit-drawer-caveat"
              aria-label="Cost Confidence"
            >
              <strong>Cost Confidence</strong>
              {order.hasMissingCogs && (
                <span>
                  Shopify COGS is missing, so this profit can be overstated.
                </span>
              )}
              {order.usesModeledCosts && (
                <span>
                  At least one fee, fulfilment cost, or overhead value is a
                  configured estimate rather than a measured order cost.
                </span>
              )}
            </aside>
          )}
        </div>
      </section>
    </div>
  );

  return isMounted ? createPortal(drawer, document.body) : drawer;
}

export function OrdersView({ data }: { data: OrdersData }) {
  const [params] = useSearchParams();
  const adSpendMeasured = data.adSpendCoverage.mode !== "unavailable";
  const profitBasisTitle =
    data.adSpendCoverage.mode === "unavailable"
      ? "Before Paid Marketing"
      : "After Available Costs";
  const dailyProfitLabel = `Profit ${profitBasisTitle}`;
  const tableProfitLabel = `Profit ${profitBasisTitle}`;
  const tableMarginLabel = `Margin ${profitBasisTitle}`;

  const navigate = useNavigate();

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
      {(data.summary.missingCogsOrders > 0 ||
        data.summary.modeledCostOrders > 0) && (
        <Banner tone="warn">
          {data.summary.missingCogsOrders > 0 && (
            <>
              {data.summary.missingCogsOrders.toLocaleString()} order
              {data.summary.missingCogsOrders === 1 ? " has" : "s have"} missing
              Shopify COGS, so those profit figures and rollups may be
              overstated.{" "}
            </>
          )}
          {data.summary.modeledCostOrders > 0 && (
            <>
              {data.summary.modeledCostOrders.toLocaleString()} order
              {data.summary.modeledCostOrders === 1 ? " uses" : "s use"}{" "}
              configured fee, fulfilment or overhead estimates; confirming an
              estimate does not make it measured.
            </>
          )}
        </Banner>
      )}
      <div className="grid cols-4">
        <Tile
          tone="var(--viz-mint)"
          valueTone={
            data.summary.profitPerOrderCents > 0
              ? "positive"
              : data.summary.profitPerOrderCents < 0
                ? "negative"
                : "neutral"
          }
          icon={<IconPricing />}
          label={`Profit Per Order ${profitBasisTitle}`}
          value={
            <AnimatedMoney
              cents={data.summary.profitPerOrderCents}
              currency={data.currency}
            />
          }
          spark={data.spark}
          meta={
            <>
              <Delta value={data.summary.profitPerOrderChange} />
              <span>{profitBasisTitle}</span>
            </>
          }
        />
        <Tile
          tone="var(--viz-blue)"
          icon={<IconOrders />}
          label="Average Order Value"
          value={
            <AnimatedMoney
              cents={data.summary.aovCents}
              currency={data.currency}
            />
          }
          meta={<Delta value={data.summary.aovChange} />}
        />
        <Tile
          tone="var(--viz-teal)"
          valueTone={
            data.summary.marginPct === null
              ? "neutral"
              : data.summary.marginPct > 0
                ? "positive"
                : data.summary.marginPct < 0
                  ? "negative"
                  : "neutral"
          }
          icon={<IconOverview />}
          label={`Margin ${profitBasisTitle}`}
          value={
            data.summary.marginPct === null
              ? "—"
              : formatPercent(data.summary.marginPct)
          }
          meta={
            <span>
              {data.adSpendCoverage.mode === "unavailable"
                ? "paid marketing is not measured"
                : "includes recorded spend only"}
            </span>
          }
        />
        <Tile
          tone="var(--viz-rose)"
          valueTone={data.summary.lossMakingCount > 0 ? "negative" : "neutral"}
          icon={<IconAlert />}
          label={`Orders Losing Money ${profitBasisTitle}`}
          value={<AnimatedInt value={data.summary.lossMakingCount} />}
          meta={
            <>
              <span>
                {formatPercent(data.summary.lossMakingShare, 1)} of orders
              </span>
              <span className="muted">·</span>
              <Money
                cents={data.summary.lossTotalCents}
                currency={data.currency}
                decimals={false}
              />
              <span>{profitBasisTitle}</span>
            </>
          }
        />
      </div>

      <Card
        title={`Daily Profit ${profitBasisTitle}`}
        hint={
          data.adSpendCoverage.mode === "unavailable"
            ? "Includes fixed overhead but excludes paid marketing because no spend source has completed a sync."
            : "Includes recorded ad spend and fixed overhead. Spend from unconnected sources remains excluded."
        }
      >
        <BarChart data={data.daily} label={dailyProfitLabel} />
      </Card>

      {data.field.numbers.length > 0 && (
        <Card
        title="Every Order In The Range"
          hint="One mark per order; the solid marks lost money. Point at any mark to read it, click to open its receipt. The same engine and the same window as the table below."
        >
          <div className="order-field-layout">
            <OrderField
              numbers={data.field.numbers}
              profits={data.field.profits}
              focused={data.focusedOrder?.orderNumber ?? null}
              onPick={(orderNumber) => {
                navigate(linkWith({ order: String(orderNumber) }), {
                  preventScrollReset: true,
                });
              }}
            />
            <p className="order-receipt-empty">
              Pick an order from the field to open its step-by-step profit math
              — revenue, each cost, and what the order kept.
            </p>
          </div>
        </Card>
      )}

      <Card
        title="Orders"
        hint={`${data.total.toLocaleString()} ${data.total === 1 ? "order" : "orders"} in the last ${data.rangeLabel}. Showing ${
          data.orders.length === 0 ? 0 : (data.page - 1) * PAGE_SIZE + 1
        }–${((data.page - 1) * PAGE_SIZE + data.orders.length).toLocaleString()}${
          data.pageCount > 1 ? ` (page ${data.page} of ${data.pageCount})` : ""
        }.${
          data.adSpendCoverage.mode === "unavailable"
            ? " Profit and margin are before paid marketing; unavailable Ads cells show a dash."
            : " Profit and margin are after available measured costs and configured estimates; missing inputs and unconnected paid-marketing spend are excluded."
        }`}
        actions={
          <>
            <div className="segmented">
              {(Object.keys(SORTS) as SortKey[]).map((key) => (
                <Link
                  key={key}
                  to={linkWith({
                    sort: key,
                    page: null,
                    after: null,
                    before: null,
                  })}
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
        <div className="channel-filter">
          <label htmlFor="orders-channel-filter">Channel</label>
          <select
            id="orders-channel-filter"
            value={data.channelFilter ?? ""}
            onChange={(event) => {
              navigate(
                linkWith({
                  channel: event.currentTarget.value || null,
                  page: null,
                  after: null,
                  before: null,
                }),
                { preventScrollReset: true },
              );
            }}
          >
            <option value="">All Channels</option>
            {data.channels.map((channel) => (
              <option key={channel} value={channel}>
                {CHANNEL_LABELS[channel as Channel]}
              </option>
            ))}
          </select>
        </div>

        {data.orders.length === 0 ? (
          <Empty>No Orders Match This Filter.</Empty>
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
                  <th className="right">
                    {data.adSpendCoverage.mode === "connected"
                      ? "Recorded Ads"
                      : "Ads"}
                  </th>
                  <th className="right">Overhead</th>
                  {/* The qualifier drops to a second line rather than sitting
                      inline. Spelled out inline it made these two headers 228px
                      each — 38% of the table for two numeric columns — which
                      squeezed Channel until "Facebook Ads" wrapped and pushed
                      every row to three lines. It stays in the header because a
                      merchant scanning a column should not have to look
                      elsewhere for what the number excludes. */}
                  <th className="right">
                    Profit
                    <span className="th-sub">{profitBasisTitle}</span>
                  </th>
                  <th className="right">
                    Margin
                    <span className="th-sub">{profitBasisTitle}</span>
                  </th>
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
                            title={[
                              order.hasMissingCogs
                                ? "Shopify COGS is missing"
                                : null,
                              order.usesModeledCosts
                                ? "configured cost models are used"
                                : null,
                            ]
                              .filter(Boolean)
                              .join("; ")}
                          />
                          <span className="sr-only">
                            {" "}
                            (uses estimated costs)
                          </span>
                        </>
                      )}
                      <div className="cell-sub">
                        {new Date(order.processedAt).toLocaleDateString(
                          "en-US",
                          {
                            timeZone: data.timezone,
                            month: "short",
                            day: "numeric",
                          },
                        )}
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
                            background: seriesColor(
                              order.channel,
                              CHANNEL_ORDER,
                            ),
                          }}
                        />
                        <span className="tiny">
                          {CHANNEL_LABELS[order.channel as Channel]}
                        </span>
                      </span>
                    </td>
                    <td className="right">
                      <Money
                        cents={order.netRevenueCents}
                        currency={data.currency}
                      />
                    </td>
                    <td className="right muted">
                      <Money
                        cents={-order.cogsCents}
                        currency={data.currency}
                      />
                    </td>
                    <td className="right muted">
                      <Money
                        cents={-order.shippingCostCents}
                        currency={data.currency}
                      />
                    </td>
                    <td className="right muted">
                      <Money
                        cents={-order.feesCents}
                        currency={data.currency}
                      />
                    </td>
                    <td className="right muted">
                      {adSpendMeasured ? (
                        <Money
                          cents={-order.adCostCents}
                          currency={data.currency}
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="right muted">
                      <Money
                        cents={-order.overheadCents}
                        currency={data.currency}
                      />
                    </td>
                    <td className="right" style={{ fontWeight: 600 }}>
                      <Money
                        cents={order.netProfitCents}
                        currency={data.currency}
                      />
                    </td>
                    <td className="right">
                      {order.marginPct === null ? (
                        "—"
                      ) : order.marginPct < 0 ? (
                        <Badge tone="critical">
                          {formatPercent(order.marginPct, 0)}
                        </Badge>
                      ) : (
                        <span className="num">
                          {formatPercent(order.marginPct, 0)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.pageCount > 1 && (
          <div
            className="row"
            style={{
              justifyContent: "flex-end",
              gap: 8,
              padding: "14px 20px",
            }}
          >
            {data.page > 1 ? (
              <Link
                className="btn sm"
                to={linkWith({
                  page: String(data.page - 1),
                  before: data.previousCursor,
                  after: null,
                })}
                preventScrollReset
              >
                Previous
              </Link>
            ) : (
              <span
                className="btn sm"
                aria-disabled="true"
                style={{ opacity: 0.45 }}
              >
                Previous
              </span>
            )}
            <span className="tiny muted">
              Page {data.page} of {data.pageCount}
            </span>
            {data.page < data.pageCount ? (
              <Link
                className="btn sm"
                to={linkWith({
                  page: String(data.page + 1),
                  after: data.nextCursor,
                  before: null,
                })}
                preventScrollReset
              >
                Next
              </Link>
            ) : (
              <span
                className="btn sm"
                aria-disabled="true"
                style={{ opacity: 0.45 }}
              >
                Next
              </span>
            )}
          </div>
        )}
      </Card>

      {data.focusedOrder && (
        <ProfitBreakdownDrawer
          order={data.focusedOrder}
          currency={data.currency}
          adSpendMeasured={adSpendMeasured}
          profitBasisTitle={profitBasisTitle}
          timeZone={data.timezone}
          closeTo={linkWith({ order: null })}
        />
      )}
    </>
  );
}
