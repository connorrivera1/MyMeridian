import { useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { Badge, Banner, Money, Stat } from "~/design/components";
import { requireShopContext } from "~/lib/auth.server";
import {
  billingIsTestForShop,
  resolveBillingChargeMode,
  resolvePlan,
} from "~/lib/plan.server";
import {
  annualKey,
  basePlanId,
  PLANS,
  type BillingKey,
} from "~/lib/plans";

/**
 * Plan selection, upgrade and downgrade.
 *
 * Shopify's App Store requirements are explicit that a merchant must be able to
 * change plans in both directions without contacting support, and that charge
 * approval must not open in a pop-up. `billing.request` satisfies both: it
 * returns a redirect to Shopify's own confirmation page, and requesting a
 * different plan replaces the existing subscription, so the same three buttons
 * serve as upgrade and downgrade.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireShopContext(request);
  const plan = await resolvePlan(ctx);
  const isTest = billingIsTestForShop(ctx.shop);

  return {
    isDemo: plan.isDemo,
    currentPlan: plan.planId,
    status: plan.status,
    plans: Object.values(PLANS),
    /** Surfaced so a reviewer can see the charge is a test one, not a real bill. */
    isTest,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireShopContext(request);

  if (!ctx.billing) {
    return {
      error:
        "The seeded demo store has no Shopify billing session, so no plan can " +
        "be selected here. Install MyMeridian on a store to subscribe.",
    };
  }

  const form = await request.formData();
  const requested = String(form.get("plan") ?? "");

  // `requested` is a billing key: a plan id, or a plan id with the annual
  // suffix. Validating via basePlanId accepts exactly those and nothing else —
  // a crafted "starter-weekly" resolves to null, not to a charge.
  if (!basePlanId(requested)) {
    return { error: "That plan does not exist." };
  }

  let isTest: boolean;
  try {
    isTest = await resolveBillingChargeMode(ctx);
  } catch (error) {
    console.error(
      `[billing] could not verify store type for ${ctx.shop.domain}:`,
      error,
    );
    return {
      error:
        "Could not verify whether this store can accept a real charge. " +
        "No charge was created; retry in a moment.",
    };
  }

  const url = new URL(request.url);

  // Shopify sends the merchant back here after they approve or decline, so the
  // page they land on reflects the charge they just made.
  return ctx.billing.request({
    plan: requested as BillingKey,
    isTest,
    returnUrl: `${url.origin}/app/plan?shop=${encodeURIComponent(ctx.shop.domain)}`,
  });
}

export default function Plan() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  // Which interval the three cards are quoting. Purely presentational until
  // the form is submitted, so plain component state is the right home for it.
  const [yearly, setYearly] = useState(false);

  return (
    <>
      {result?.error && <Banner tone="warn">{result.error}</Banner>}

      {data.isDemo ? (
        <Banner>
          This is the seeded demo, shown on the Scale plan so every screen is
          reachable. On a real store this page is where a merchant subscribes,
          upgrades and downgrades.
        </Banner>
      ) : data.currentPlan ? (
        <Banner>
          You are on <strong>{PLANS[data.currentPlan].name}</strong>. Choosing a
          different plan replaces your subscription — Shopify prorates the
          change and shows you the amount before you confirm.
        </Banner>
      ) : (
        <Banner tone="warn">
          MyMeridian needs an active plan before it can show your store&rsquo;s
          figures. Every plan starts with a 14-day free trial, and Shopify does
          not charge anything until the trial ends.
        </Banner>
      )}

      {data.isTest && (
        <Banner>
          Test mode: charges created for this development store are Shopify
          test charges and take no money.
        </Banner>
      )}

      {/* Billed monthly / billed yearly. A group of two buttons rather than a
          switch: "which price list am I looking at" is a choice between two
          named things, and a switch hides one of the names. */}
      <div className="interval-toggle" role="group" aria-label="Billing interval">
        <button
          type="button"
          className="btn sm"
          aria-pressed={!yearly}
          onClick={() => setYearly(false)}
        >
          Billed monthly
        </button>
        <button
          type="button"
          className="btn sm"
          aria-pressed={yearly}
          onClick={() => setYearly(true)}
        >
          Billed yearly · two months free
        </button>
      </div>

      <div className="grid cols-3">
        {data.plans.map((plan) => {
          const current = data.currentPlan === plan.id;

          return (
            <div className="card" key={plan.id}>
              <Stat
                label={plan.name}
                value={
                  <>
                    <Money
                      cents={(yearly ? plan.annualPrice : plan.price) * 100}
                      currency="USD"
                      decimals={false}
                    />
                    <span className="muted tiny">
                      {" "}
                      {yearly ? "/year" : "/month"}
                    </span>
                  </>
                }
                meta={
                  <span>
                    {plan.blurb}
                    {yearly && (
                      <>
                        {" "}
                        · saves{" "}
                        <Money
                          cents={(plan.price * 12 - plan.annualPrice) * 100}
                          currency="USD"
                          decimals={false}
                        />{" "}
                        a year
                      </>
                    )}
                  </span>
                }
              />
              <div style={{ padding: "0 16px 16px" }}>
                <ul
                  className="tiny secondary"
                  style={{ margin: "6px 0 14px", paddingLeft: 16, lineHeight: 1.7 }}
                >
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>

                {current ? (
                  <Badge tone="good">Current plan</Badge>
                ) : (
                  <Form method="post">
                    <input
                      type="hidden"
                      name="plan"
                      value={yearly ? annualKey(plan.id) : plan.id}
                    />
                    <button
                      className={
                        data.currentPlan ? "btn sm" : "btn primary sm"
                      }
                      disabled={busy || data.isDemo}
                    >
                      {!data.currentPlan
                        ? `Start 14-day trial`
                        : plan.price > (PLANS[data.currentPlan].price ?? 0)
                          ? `Upgrade to ${plan.name}`
                          : `Switch to ${plan.name}`}
                    </button>
                  </Form>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="tiny muted" style={{ maxWidth: "72ch", lineHeight: 1.7 }}>
        Billing is handled entirely by Shopify and appears on your Shopify
        invoice. MyMeridian never sees a card number. Cancelling the app from your
        Shopify admin cancels the subscription with it.
      </p>
    </>
  );
}
