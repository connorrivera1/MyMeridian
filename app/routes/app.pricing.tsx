import { Form, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { RecStatus } from "@prisma/client";

import prisma from "~/db.server";
import {
  AnimatedInt,
  AnimatedMoney,
  Badge,
  Banner,
  Card,
  Empty,
  IconCheck,
  IconInfo,
  IconPricing,
  Money,
  Tile,
} from "~/design/components";
import { formatPercent, toCents } from "~/engine/money";
import { requireShopContext } from "~/lib/auth.server";
import { generatePricingRecommendations } from "~/lib/pricing.server";
import { loadDashboard } from "~/lib/route-data.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, rangeLabel } = await loadDashboard(request);

  const recommendations = await prisma.pricingRecommendation.findMany({
    where: { shopId: shop.id, status: RecStatus.PENDING },
    include: { variant: { include: { product: true } } },
    orderBy: { expectedProfitDelta: "desc" },
  });

  const actionable = recommendations.filter(
    (rec) =>
      rec.method === "ELASTICITY_REGRESSION" || rec.method === "MARGIN_TARGET",
  );

  return {
    rangeLabel,
    currency: shop.currency,
    upsideCents: actionable.reduce(
      (sum, rec) => sum + toCents(rec.expectedProfitDelta),
      0,
    ),
    actionableCount: actionable.length,
    testableCount: recommendations.filter(
      (rec) => rec.method === "INSUFFICIENT_DATA",
    ).length,
    recommendations: recommendations.map((rec) => ({
      id: rec.id,
      productTitle: rec.variant.product.title,
      variantTitle: rec.variant.title,
      sku: rec.variant.sku,
      currentPriceCents: toCents(rec.currentPrice),
      suggestedPriceCents: toCents(rec.suggestedPrice),
      expectedProfitDeltaCents: toCents(rec.expectedProfitDelta),
      expectedUnitsDeltaPct: Number(rec.expectedUnitsDeltaPct),
      elasticity: rec.elasticity === null ? null : Number(rec.elasticity),
      confidence: rec.confidence,
      method: rec.method,
      rationale: rec.rationale,
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await requireShopContext(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "regenerate") {
    await generatePricingRecommendations(shop.id);
    return { ok: true };
  }

  const id = String(form.get("id") ?? "");
  if (!id) return { ok: false };

  // Scoped to this shop so a crafted id cannot touch another merchant's data.
  const recommendation = await prisma.pricingRecommendation.findFirst({
    where: { id, shopId: shop.id },
  });
  if (!recommendation) return { ok: false };

  if (intent === "dismiss") {
    await prisma.pricingRecommendation.update({
      where: { id },
      data: { status: RecStatus.DISMISSED, actionedAt: new Date() },
    });
  }

  if (intent === "apply") {
    // Recorded as accepted here. Writing the price back to Shopify needs the
    // write_products scope, which Meridian deliberately does not request yet —
    // an analytics app should not be able to silently change what customers pay.
    await prisma.pricingRecommendation.update({
      where: { id },
      data: { status: RecStatus.APPLIED, actionedAt: new Date() },
    });
  }

  return { ok: true };
}

const CONFIDENCE_TONE = {
  HIGH: "good",
  MEDIUM: "warning",
  LOW: "neutral",
} as const;

const METHOD_LABEL: Record<string, string> = {
  ELASTICITY_REGRESSION: "Fitted demand curve",
  MARGIN_TARGET: "Margin target",
  STRATEGIC_HOLD: "Hold — strategic loss leader",
  BELOW_COST: "Priced below cost",
  INSUFFICIENT_DATA: "Needs a price test",
};

export default function Pricing() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <>
      <div className="grid cols-3">
        <Tile
          tone="var(--viz-mint)"
          icon={<IconPricing />}
          label="Modelled monthly upside"
          value={<AnimatedMoney cents={data.upsideCents} currency={data.currency} decimals={false} />}
          meta={
            <span>
              across {data.actionableCount} actionable{" "}
              {data.actionableCount === 1 ? "change" : "changes"}
            </span>
          }
        />
        <Tile
          tone="var(--viz-teal)"
          icon={<IconCheck />}
          label="Ready to act on"
          value={<AnimatedInt value={data.actionableCount} />}
          meta={<span>backed by your own price history</span>}
        />
        <Tile
          tone="var(--viz-violet)"
          icon={<IconInfo />}
          label="Need a price test"
          value={<AnimatedInt value={data.testableCount} />}
          meta={<span>never changed price, so demand is unknown</span>}
        />
      </div>

      <Banner>
        Meridian fits a demand curve to each variant&rsquo;s own price history and
        solves for the price that maximises contribution profit. Where a variant
        has never changed price there is nothing to fit, and it says so rather
        than inventing an elasticity. Every move is capped at 25% and floored at
        a 15% margin.
      </Banner>

      <Card
        title="Recommendations"
        hint={`Modelled over the last ${data.rangeLabel} of demand.`}
        actions={
          <Form method="post">
            <button
              className="btn sm"
              name="intent"
              value="regenerate"
              disabled={busy}
            >
              {busy ? "Recalculating…" : "Recalculate"}
            </button>
          </Form>
        }
        flush
      >
        {data.recommendations.length === 0 ? (
          <Empty>
            No pricing recommendations yet — seed or sync some order history first.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="right">Now</th>
                  <th className="right">Suggested</th>
                  <th className="right">Units impact</th>
                  <th className="right">Monthly profit</th>
                  <th>Basis</th>
                  <th>Confidence</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.recommendations.map((rec) => {
                  const actionable =
                    rec.method === "ELASTICITY_REGRESSION" ||
                    rec.method === "MARGIN_TARGET";
                  const rising = rec.suggestedPriceCents > rec.currentPriceCents;

                  return (
                    <tr key={rec.id}>
                      <td className="primary-cell" style={{ maxWidth: 300 }}>
                        {rec.productTitle}
                        <div className="cell-sub">{rec.rationale}</div>
                      </td>
                      <td className="right">
                        <Money cents={rec.currentPriceCents} currency={data.currency} />
                      </td>
                      <td className="right" style={{ fontWeight: 600 }}>
                        {actionable ? (
                          <>
                            <Money cents={rec.suggestedPriceCents} currency={data.currency} />
                            <div className="cell-sub">
                              {rising ? "▲" : "▼"}{" "}
                              {formatPercent(
                                Math.abs(
                                  rec.suggestedPriceCents / rec.currentPriceCents - 1,
                                ),
                                0,
                              )}
                            </div>
                          </>
                        ) : (
                          <span className="muted">no change</span>
                        )}
                      </td>
                      <td className="right num">
                        {rec.expectedUnitsDeltaPct === 0 ? (
                          <span className="muted">unknown</span>
                        ) : (
                          formatPercent(rec.expectedUnitsDeltaPct, 0)
                        )}
                      </td>
                      <td className="right">
                        {rec.expectedProfitDeltaCents === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <Money
                            cents={rec.expectedProfitDeltaCents}
                            currency={data.currency}
                            decimals={false}
                            signed
                          />
                        )}
                      </td>
                      <td>
                        <span className="tiny">
                          {METHOD_LABEL[rec.method] ?? rec.method}
                        </span>
                        {rec.elasticity !== null && (
                          <div className="cell-sub num">
                            e = {rec.elasticity.toFixed(2)}
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge
                          tone={
                            CONFIDENCE_TONE[
                              rec.confidence as keyof typeof CONFIDENCE_TONE
                            ]
                          }
                        >
                          {rec.confidence.toLowerCase()}
                        </Badge>
                      </td>
                      <td>
                        {actionable && (
                          <Form method="post" className="row">
                            <input type="hidden" name="id" value={rec.id} />
                            <button
                              className="btn sm primary"
                              name="intent"
                              value="apply"
                              disabled={busy}
                            >
                              Accept
                            </button>
                            <button
                              className="btn sm ghost"
                              name="intent"
                              value="dismiss"
                              disabled={busy}
                            >
                              Dismiss
                            </button>
                          </Form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
