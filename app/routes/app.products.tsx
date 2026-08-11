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
  IconPricing,
  IconProducts,
  Money,
  Tile,
} from "~/design/components";
import { formatPercent } from "~/engine/money";
import type { ProductClass } from "~/engine/products";
import { loadDashboard } from "~/lib/route-data.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, analytics, rangeLabel, capabilities, adSpendCoverage } =
    await loadDashboard(request);

  const products = analytics.products.map((product) => ({
    productId: product.productId,
    title: product.title,
    // Customer-lifecycle classification needs read_customers, which the app
    // deliberately does not request today. Keep the engine result dormant and
    // present every negative-contribution product by the fact we can prove.
    classification: product.hasMissingCogs
      ? ("MISSING_COGS" as const)
      : product.classification === "STRATEGIC_LOSS_LEADER"
        ? ("BLEEDING" as const)
        : product.classification,
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
    attachRatePct: product.attachRatePct,
    hasMissingCogs: product.hasMissingCogs,
    usesModeledCosts: product.usesModeledCosts,
  }));

  const byClass = (target: ProductDisplayClass) =>
    products.filter((product) => product.classification === target);

  const bleeding = byClass("BLEEDING");

  return {
    rangeLabel,
    currency: shop.currency,
    hasCustomerData: capabilities.customers,
    adSpendCoverage,
    products,
    counts: {
      profitable: byClass("PROFITABLE").length,
      thin: byClass("THIN_MARGIN").length,
      bleeding: bleeding.length,
      uncosted: byClass("MISSING_COGS").length,
    },
    bleedingTotalCents: bleeding.reduce(
      (sum, product) => sum + product.contributionProfitCents,
      0,
    ),
  };
}

type ProductDisplayClass = ProductClass | "MISSING_COGS";

const CLASS_META: Record<
  ProductDisplayClass,
  {
    label: string;
    tone: "good" | "warning" | "serious" | "critical" | "neutral";
  }
> = {
  PROFITABLE: { label: "Profitable", tone: "good" },
  THIN_MARGIN: { label: "Thin margin", tone: "warning" },
  STRATEGIC_LOSS_LEADER: { label: "Negative margin", tone: "critical" },
  BLEEDING: { label: "Bleeding", tone: "critical" },
  MISSING_COGS: { label: "Needs COGS", tone: "warning" },
};

export default function Products() {
  const data = useLoaderData<typeof loader>();

  return <ProductsView data={data} />;
}

type ProductsData = Awaited<ReturnType<typeof loader>>;

export function ProductsView({ data }: { data: ProductsData }) {
  const adSpendMeasured = data.adSpendCoverage.mode !== "unavailable";
  const missingCogsProducts = data.products.filter(
    (product) => product.hasMissingCogs,
  ).length;
  const modeledCostProducts = data.products.filter(
    (product) => product.usesModeledCosts,
  ).length;
  const profitBasis =
    data.adSpendCoverage.mode === "unavailable"
      ? "before paid marketing"
      : "after available costs";

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
      <Banner
        tone={
          data.adSpendCoverage.mode === "unavailable" ? "warn" : "neutral"
        }
      >
          Product contribution and margin are {profitBasis}.{" "}
          {data.adSpendCoverage.mode === "unavailable"
            ? "Paid-marketing spend is not measured, so these figures may be overstated and Ads cells show a dash."
            : "Only spend from synced sources is included; unconnected paid-marketing spend remains outside the figures."}{" "}
          {!data.hasCustomerData && (
            <>
              Customer-lifetime effects are intentionally omitted because
              Meridian does not request the <code>read_customers</code> scope.
              Every negative-contribution product is therefore classified only
              by its available order economics.
            </>
          )}
          {missingCogsProducts > 0 && (
            <>
              {" "}
              {missingCogsProducts.toLocaleString()} product
              {missingCogsProducts === 1 ? " has" : "s have"} sold units with no
              Shopify COGS. Those products are labelled Needs COGS instead of
              profitable or bleeding because their contribution may be
              overstated.
            </>
          )}
          {modeledCostProducts > 0 && (
            <>
              {" "}
              {modeledCostProducts.toLocaleString()} product
              {modeledCostProducts === 1 ? " uses" : "s use"} configured fee or
              fulfilment models. Reviewing those assumptions records
              acknowledgement; it does not make them measured costs.
            </>
          )}
      </Banner>

      <div className="grid cols-3">
        <Tile
          tone="var(--viz-mint)"
          icon={<IconProducts />}
          label="Profitable"
          value={<AnimatedInt value={data.counts.profitable} />}
          meta={<span>{profitBasis}</span>}
        />
        <Tile
          tone="var(--viz-amber)"
          icon={<IconPricing />}
          label="Thin margin"
          value={<AnimatedInt value={data.counts.thin} />}
          meta={
            <>
              <span>under 10% contribution</span>
              {profitBasis && <span>{profitBasis}</span>}
            </>
          }
        />
        <Tile
          tone="var(--viz-rose)"
          icon={<IconAlert />}
          label="Bleeding"
          value={<AnimatedInt value={data.counts.bleeding} />}
          meta={
            <>
              <Money
                cents={data.bleedingTotalCents}
                currency={data.currency}
                decimals={false}
              />
              <span>over the period</span>
              {profitBasis && <span>{profitBasis}</span>}
            </>
          }
        />
      </div>

      <Card
        title={`Contribution profit ${profitBasis} by product`}
        hint={
          data.adSpendCoverage.mode === "unavailable"
            ? "After available shipping, payment-fee and pick-and-pack inputs. Those inputs can be modeled, missing COGS is flagged, and paid-marketing spend is unavailable and excluded."
            : "After available recorded and modeled costs plus recorded ad spend. Missing COGS is flagged; spend from unconnected sources is excluded."
        }
      >
        {chartData.length === 0 ? (
          <Empty>No product sales in this period.</Empty>
        ) : (
          <HorizontalBars data={chartData} maxRows={20} />
        )}
      </Card>

      <Card
        title="Full breakdown"
        hint={
          data.adSpendCoverage.mode === "unavailable"
            ? "Sorted by contribution before paid marketing. Ads shows a dash; contribution, margin and per-unit profit exclude that unavailable cost."
            : "Sorted by contribution after available costs. Modeled costs and missing COGS are flagged; Ads includes synced-source spend only and unconnected paid-marketing spend is excluded."
        }
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
                <th className="right">
                  {data.adSpendCoverage.mode === "connected"
                    ? "Recorded ads"
                    : "Ads"}
                </th>
                <th className="right">
                  {`Contribution ${profitBasis}`}
                </th>
                <th className="right">
                  {`Margin ${profitBasis}`}
                </th>
                <th className="right">
                  {`Per unit ${profitBasis}`}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((product) => {
                const meta =
                  CLASS_META[product.classification as ProductDisplayClass];
                return (
                  <tr key={product.productId}>
                    <td className="primary-cell">
                      {product.title}
                      {(product.hasMissingCogs || product.usesModeledCosts) && (
                        <div className="cell-sub">
                          {[
                            product.hasMissingCogs ? "missing COGS" : null,
                            product.usesModeledCosts ? "modeled costs" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </td>
                    <td className="right num">
                      {product.units.toLocaleString()}
                    </td>
                    <td className="right num">
                      {product.attachRatePct === null
                        ? "—"
                        : formatPercent(product.attachRatePct, 1)}
                    </td>
                    <td className="right">
                      <Money
                        cents={product.netRevenueCents}
                        currency={data.currency}
                        decimals={false}
                      />
                    </td>
                    <td className="right muted">
                      <Money
                        cents={-product.cogsCents}
                        currency={data.currency}
                        decimals={false}
                      />
                    </td>
                    <td className="right muted">
                      <Money
                        cents={-product.allocatedCostsCents}
                        currency={data.currency}
                        decimals={false}
                      />
                    </td>
                    <td className="right muted">
                      {adSpendMeasured ? (
                        <Money
                          cents={-product.allocatedAdCostCents}
                          currency={data.currency}
                          decimals={false}
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="right" style={{ fontWeight: 600 }}>
                      <Money
                        cents={product.contributionProfitCents}
                        currency={data.currency}
                        decimals={false}
                      />
                    </td>
                    <td className="right num">
                      {product.marginPct === null
                        ? "—"
                        : formatPercent(product.marginPct, 0)}
                    </td>
                    <td className="right">
                      <Money
                        cents={product.profitPerUnitCents}
                        currency={data.currency}
                      />
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
