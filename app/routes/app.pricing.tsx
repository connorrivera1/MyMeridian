import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
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
  UpgradeNotice,
} from "~/design/components";
import { formatPercent, toCents } from "~/engine/money";
import { requireShopContext } from "~/lib/auth.server";
import { planAllows, planFor, resolvePlan } from "~/lib/plan.server";
import { generatePricingRecommendations } from "~/lib/pricing.server";
import { PRICING_LOOKBACK_DAYS } from "~/lib/ranges";
import { loadDashboard } from "~/lib/route-data.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, rangeLabel, plan } = await loadDashboard(request);

  if (!planAllows(plan, "pricing")) {
    const required = planFor("pricing");
    return { locked: { name: required.name, price: required.price } };
  }

  const [recommendations, actioned] = await Promise.all([
    prisma.pricingRecommendation.findMany({
      where: { shopId: shop.id, status: RecStatus.PENDING },
      include: { variant: { include: { product: true } } },
      orderBy: { expectedProfitDelta: "desc" },
    }),
    // Accepted and dismissed suggestions were queried nowhere, and regeneration
    // permanently excludes an actioned variant — so after Accept there was no
    // screen anywhere showing what had been accepted, and an accidental
    // Dismiss could not be undone.
    prisma.pricingRecommendation.findMany({
      where: {
        shopId: shop.id,
        status: { in: [RecStatus.APPLIED, RecStatus.DISMISSED] },
      },
      include: { variant: { include: { product: true } } },
      orderBy: { actionedAt: "desc" },
      take: 20,
    }),
  ]);

  // The engine can protect a customer-acquisition product once customer
  // lifecycle access is approved, but the current app does not request that
  // scope. Keep those dormant records out of the merchant-facing route until
  // the permission and product promise ship together.
  const visibleRecommendations = recommendations.filter(
    (rec) => rec.method !== "STRATEGIC_HOLD",
  );

  const actionable = visibleRecommendations.filter(
    (rec) =>
      rec.method === "ELASTICITY_REGRESSION" || rec.method === "MARGIN_TARGET",
  );

  return {
    locked: null,
    rangeLabel,
    currency: shop.currency,
    timezone: shop.timezone,
    upsideCents: actionable.reduce(
      (sum, rec) => sum + toCents(rec.expectedProfitDelta),
      0,
    ),
    actionableCount: actionable.length,
    testableCount: visibleRecommendations.filter(
      (rec) => rec.method === "INSUFFICIENT_DATA",
    ).length,
    recommendations: visibleRecommendations.map((rec) => ({
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
    actioned: actioned.map((rec) => ({
      id: rec.id,
      productTitle: rec.variant.product.title,
      variantTitle: rec.variant.title,
      status: rec.status,
      currentPriceCents: toCents(rec.currentPrice),
      suggestedPriceCents: toCents(rec.suggestedPrice),
      actionedAt: rec.actionedAt,
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireShopContext(request);
  const { shop } = ctx;

  // The loader hides this screen below Growth, but a form post does not go
  // through the loader — without this check the gate is decoration.
  if (!planAllows(await resolvePlan(ctx), "pricing")) {
    throw new Response("Pricing recommendations need the Growth plan.", {
      status: 402,
      statusText: "Payment Required",
    });
  }

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "regenerate") {
    const count = await generatePricingRecommendations(shop.id);
    return {
      ok: true,
      message:
        `Recalculated. ${count} suggestion${count === 1 ? "" : "s"} from your ` +
        `current price history.`,
    };
  }

  const id = String(form.get("id") ?? "");
  if (!id) return { ok: false, message: "No recommendation was selected." };

  // Scoped to this shop so a crafted id cannot touch another merchant's data.
  const recommendation = await prisma.pricingRecommendation.findFirst({
    where: { id, shopId: shop.id },
    include: { variant: { include: { product: true } } },
  });

  // Previously this returned { ok: false } with a 200 and the route never read
  // useActionData, so a failed Accept was a button that did nothing and said
  // nothing. Every branch below now says what happened.
  if (!recommendation) {
    return {
      ok: false,
      message: "That recommendation no longer exists. Recalculate to refresh.",
    };
  }

  const label = recommendation.variant.product.title;

  if (intent === "dismiss") {
    await prisma.pricingRecommendation.update({
      where: { id },
      data: { status: RecStatus.DISMISSED, actionedAt: new Date() },
    });

    return { ok: true, message: `Dismissed the suggestion for ${label}.` };
  }

  if (intent === "restore") {
    // Regeneration permanently excludes actioned variants, so without this an
    // accidental Dismiss was unrecoverable and an Accept could never be
    // reconsidered.
    await prisma.pricingRecommendation.update({
      where: { id },
      data: { status: RecStatus.PENDING, actionedAt: null },
    });

    return { ok: true, message: `Restored the suggestion for ${label}.` };
  }

  if (intent === "apply") {
    // Recorded as accepted here. Writing the price back to Shopify needs the
    // write_products scope, which Meridian deliberately does not request yet —
    // an analytics app should not be able to silently change what customers pay.
    await prisma.pricingRecommendation.update({
      where: { id },
      data: { status: RecStatus.APPLIED, actionedAt: new Date() },
    });

    return {
      ok: true,
      message:
        `Accepted for ${label}. Meridian has recorded it — set the new price ` +
        `in Shopify to make it live. It has no permission to change prices ` +
        `itself, by design.`,
    };
  }

  return { ok: false, message: "Unrecognised action." };
}

const CONFIDENCE_TONE = {
  HIGH: "good",
  MEDIUM: "warning",
  LOW: "neutral",
} as const;

const METHOD_LABEL: Record<string, string> = {
  ELASTICITY_REGRESSION: "Fitted demand curve",
  MARGIN_TARGET: "Margin target",
  BELOW_COST: "Priced below cost",
  INSUFFICIENT_DATA: "Needs a price test",
};

export default function Pricing() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  if (data.locked) {
    return (
      <UpgradeNotice
        feature="Pricing recommendations"
        planName={data.locked.name}
        price={data.locked.price}
      >
        Meridian fits a demand curve only to price history observed after this
        app was installed, then solves for the price that maximises contribution profit — not a rule of
        thumb, and never a number invented for a variant that has never changed
        price.
      </UpgradeNotice>
    );
  }

  return (
    <>
      {result?.message && (
        <Banner tone={result.ok ? "neutral" : "warn"}>{result.message}</Banner>
      )}

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
          meta={<span>backed by post-install observed history</span>}
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
        Meridian fits a demand curve only to price history observed after this
        app was installed, then solves for the price that maximises contribution profit. Where a variant
        has never changed price there is nothing to fit, and it says so rather
        than inventing an elasticity. Every move is capped at 25% and floored at
        a 15% margin.
      </Banner>

      <Card
        title="Recommendations"
        hint={`Modelled over the last ${PRICING_LOOKBACK_DAYS} days of demand, whichever range is selected above.`}
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

      {data.actioned.length > 0 && (
        <Card
          title="Decided"
          hint="What you have accepted or dismissed. Regeneration leaves these alone, so this is the only record of them — restore one to put it back in the list above."
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="right">Was</th>
                  <th className="right">Suggested</th>
                  <th>Decision</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.actioned.map((rec) => (
                  <tr key={rec.id}>
                    <td className="primary-cell">
                      {rec.productTitle}
                      <div className="cell-sub">{rec.variantTitle}</div>
                    </td>
                    <td className="right">
                      <Money cents={rec.currentPriceCents} currency={data.currency} />
                    </td>
                    <td className="right">
                      <Money cents={rec.suggestedPriceCents} currency={data.currency} />
                    </td>
                    <td>
                      {rec.status === "APPLIED" ? (
                        <Badge tone="good">Accepted</Badge>
                      ) : (
                        <Badge tone="neutral">Dismissed</Badge>
                      )}
                      {rec.actionedAt && (
                        <div className="cell-sub">
                          {new Date(rec.actionedAt).toLocaleDateString("en-US", {
                            timeZone: data.timezone,
                            month: "short",
                            day: "numeric",
                          })}
                        </div>
                      )}
                    </td>
                    <td className="right">
                      <Form method="post">
                        <input type="hidden" name="id" value={rec.id} />
                        <button
                          className="btn sm ghost"
                          name="intent"
                          value="restore"
                          disabled={busy}
                        >
                          Restore
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
