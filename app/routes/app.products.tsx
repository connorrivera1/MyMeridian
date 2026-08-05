import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { HorizontalBars } from "~/design/charts";
import {
  AnimatedInt,
  Badge,
  Banner,
  Card,
  Empty,
  IconAlert,
  IconChannels,
  IconPricing,
  IconProducts,
  Money,
  Tile,
} from "~/design/components";
import { formatPercent } from "~/engine/money";
import type { ProductClass } from "~/engine/products";
import { loadDashboard } from "~/lib/route-data.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, analytics, rangeLabel, capabilities } = await loadDashboard(request);

  const products = analytics.products.map((product) => ({
    productId: product.productId,
    title: product.title,
    classification: product.classification,
    units: product.units,
    ordersContaining: product.ordersContaining,
    netRevenueCents: product.netRevenueCents,
    cogsCents: product.cogsCents,
    allocatedCostsCents:
      product.allocatedShippingCents +
      product.allocatedPaymentFeeCents +
      product.allocatedPickPackCents,
    allocatedAdCostCents: product.allocatedAdCostCents,
    contributionProfitCents: product.contributionProfitCents,
    marginPct: product.marginPct,
    profitPerUnitCents: product.profitPerUnitCents,
    acquiredCustomers: product.acquiredCustomers,
    downstreamProfitPerCustomerCents: product.downstreamProfitPerCustomerCents,
    attachRatePct: product.attachRatePct,
  }));

  const byClass = (target: ProductClass) =>
    products.filter((product) => product.classification === target);

  const bleeding = byClass("BLEEDING");

  return {
    rangeLabel,
    currency: shop.currency,
    hasCustomerData: capabilities.customers,
    products,
    counts: {
      profitable: byClass("PROFITABLE").length,
      thin: byClass("THIN_MARGIN").length,
      strategic: byClass("STRATEGIC_LOSS_LEADER").length,
      bleeding: bleeding.length,
    },
    bleedingTotalCents: bleeding.reduce(
      (sum, product) => sum + product.contributionProfitCents,
      0,
    ),
    strategic: byClass("STRATEGIC_LOSS_LEADER"),
  };
}

const CLASS_META: Record<
  ProductClass,
  { label: string; tone: "good" | "warning" | "serious" | "critical" | "neutral" }
> = {
  PROFITABLE: { label: "Profitable", tone: "good" },
  THIN_MARGIN: { label: "Thin margin", tone: "warning" },
  STRATEGIC_LOSS_LEADER: { label: "Strategic loss leader", tone: "neutral" },
  BLEEDING: { label: "Bleeding", tone: "critical" },
};

export default function Products() {
  const data = useLoaderData<typeof loader>();

  const chartData = data.products
    .slice()
    .sort((a, b) => b.contributionProfitCents - a.contributionProfitCents)
    .map((product) => ({
      label: product.title,
      value: product.contributionProfitCents,
      color:
        product.contributionProfitCents >= 0
          ? "var(--viz-mint)"
          : "var(--viz-rose)",
      sublabel: `${product.units.toLocaleString()} units`,
    }));

  return (
    <>
      {!data.hasCustomerData && (
        <Banner>
          Margins and contribution below are exact. The{" "}
          <strong>loss-leader distinction is not available</strong> — separating a
          product that is profitably buying customers from one that is simply
          losing money requires seeing repeat purchases, which needs the{" "}
          <code>read_customers</code> scope. Loss-making products are shown as
          bleeding by default.
        </Banner>
      )}

      <div className="grid cols-4">
        <Tile
          tone="var(--viz-mint)"
          icon={<IconProducts />}
          label="Profitable"
          value={<AnimatedInt value={data.counts.profitable} />}
          meta={<span>scale these</span>}
        />
        <Tile
          tone="var(--viz-amber)"
          icon={<IconPricing />}
          label="Thin margin"
          value={<AnimatedInt value={data.counts.thin} />}
          meta={<span>under 10% contribution</span>}
        />
        <Tile
          tone="var(--viz-violet)"
          icon={<IconChannels />}
          label="Strategic loss leaders"
          value={<AnimatedInt value={data.counts.strategic} />}
          meta={<span>losing money on purpose, and it works</span>}
        />
        <Tile
          tone="var(--viz-rose)"
          icon={<IconAlert />}
          label="Bleeding"
          value={<AnimatedInt value={data.counts.bleeding} />}
          meta={
            <>
              <Money cents={data.bleedingTotalCents} currency={data.currency} decimals={false} />
              <span>over the period</span>
            </>
          }
        />
      </div>

      {data.strategic.length > 0 && (
        <Card
          title="Losing money on purpose — and it's working"
          hint="These products lose money on the order they appear in, but the customers they bring in go on to be worth more than the store's average customer. Repricing them would break the funnel."
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="right">Loss on first order</th>
                  <th className="right">Customers acquired</th>
                  <th className="right">Later profit per customer</th>
                </tr>
              </thead>
              <tbody>
                {data.strategic.map((product) => (
                  <tr key={product.productId}>
                    <td className="primary-cell">{product.title}</td>
                    <td className="right">
                      <Money cents={product.contributionProfitCents} currency={data.currency} decimals={false} />
                    </td>
                    <td className="right num">
                      {product.acquiredCustomers.toLocaleString()}
                    </td>
                    <td className="right">
                      <Money cents={product.downstreamProfitPerCustomerCents} currency={data.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card
        title="Contribution profit by product"
        hint="After each product's share of shipping, payment fees, pick & pack and ad spend — allocated by its share of order revenue."
      >
        {chartData.length === 0 ? (
          <Empty>No product sales in this period.</Empty>
        ) : (
          <HorizontalBars data={chartData} maxRows={20} />
        )}
      </Card>

      <Card
        title="Full breakdown"
        hint="Sorted by contribution profit. A product can carry a healthy gross margin and still lose money once fulfilment and acquisition are charged to it."
        flush
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th></th>
                <th className="right">Units</th>
                <th className="right">Attach rate</th>
                <th className="right">Revenue</th>
                <th className="right">COGS</th>
                <th className="right">Fulfilment &amp; fees</th>
                <th className="right">Ads</th>
                <th className="right">Contribution</th>
                <th className="right">Margin</th>
                <th className="right">Per unit</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((product) => {
                const meta = CLASS_META[product.classification as ProductClass];
                return (
                  <tr key={product.productId}>
                    <td className="primary-cell">{product.title}</td>
                    <td>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </td>
                    <td className="right num">{product.units.toLocaleString()}</td>
                    <td className="right num">
                      {product.attachRatePct === null
                        ? "—"
                        : formatPercent(product.attachRatePct, 1)}
                    </td>
                    <td className="right">
                      <Money cents={product.netRevenueCents} currency={data.currency} decimals={false} />
                    </td>
                    <td className="right muted">
                      <Money cents={-product.cogsCents} currency={data.currency} decimals={false} />
                    </td>
                    <td className="right muted">
                      <Money cents={-product.allocatedCostsCents} currency={data.currency} decimals={false} />
                    </td>
                    <td className="right muted">
                      <Money cents={-product.allocatedAdCostCents} currency={data.currency} decimals={false} />
                    </td>
                    <td className="right" style={{ fontWeight: 600 }}>
                      <Money cents={product.contributionProfitCents} currency={data.currency} decimals={false} />
                    </td>
                    <td className="right num">
                      {product.marginPct === null
                        ? "—"
                        : formatPercent(product.marginPct, 0)}
                    </td>
                    <td className="right">
                      <Money cents={product.profitPerUnitCents} currency={data.currency} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
