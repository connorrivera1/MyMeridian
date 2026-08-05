import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { Badge, Banner, Money, Stat } from "~/design/components";
import { requireShopContext } from "~/lib/auth.server";
import { billingIsTest, resolvePlan } from "~/lib/plan.server";
import { PLANS, type PlanId } from "~/lib/plans";

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

  return {
    isDemo: plan.isDemo,
    currentPlan: plan.planId,
    status: plan.status,
    plans: Object.values(PLANS),
    /** Surfaced so a reviewer can see the charge is a test one, not a real bill. */
    isTest: billingIsTest,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await requireShopContext(request);

  if (!ctx.billing) {
    return {
      error:
        "The seeded demo store has no Shopify billing session, so no plan can " +
        "be selected here. Install Meridian on a store to subscribe.",
    };
  }

  const form = await request.formData();
  const requested = String(form.get("plan") ?? "");

  if (!(requested in PLANS)) {
    return { error: "That plan does not exist." };
  }

  const url = new URL(request.url);

  // Shopify sends the merchant back here after they approve or decline, so the
  // page they land on reflects the charge they just made.
  return ctx.billing.request({
    plan: requested as PlanId,
    isTest: billingIsTest,
    returnUrl: `${url.origin}/app/plan?shop=${encodeURIComponent(ctx.shop.domain)}`,
  });
}

export default function Plan() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

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
          Meridian needs an active plan before it can show your store&rsquo;s
          figures. Every plan starts with a 14-day free trial, and Shopify does
          not charge anything until the trial ends.
        </Banner>
      )}

      {data.isTest && (
        <Banner>
          Test mode: charges created from this build are Shopify test charges
          and take no money.
        </Banner>
      )}

      <div className="grid cols-3">
        {data.plans.map((plan) => {
          const current = data.currentPlan === plan.id;

          return (
            <div className="card" key={plan.id}>
              <Stat
                label={plan.name}
                value={
                  <>
                    <Money cents={plan.price * 100} currency="USD" decimals={false} />
                    <span className="muted tiny"> /month</span>
                  </>
                }
                meta={<span>{plan.blurb}</span>}
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
                    <input type="hidden" name="plan" value={plan.id} />
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
        invoice. Meridian never sees a card number. Cancelling the app from your
        Shopify admin cancels the subscription with it.
      </p>
    </>
  );
}
