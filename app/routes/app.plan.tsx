import { useState, type FormEvent } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { Badge, Banner, Money, Stat } from "~/design/components";
import { withShopContext } from "~/lib/auth.server";
import { logOperationalFailure } from "~/lib/operational-errors.server";
import {
  billingIsTestForShop,
  resolveBillingChargeMode,
  resolvePlan,
} from "~/lib/plan.server";
import {
  annualKey,
  billingKeyInfo,
  changeKey,
  foundingKey,
  nextCycleKey,
  PLANS,
  type BillingKey,
} from "~/lib/plans";
import {
  findFoundingMerchantEntitlementForShop,
  reserveFoundingMerchantEntitlement,
} from "~/lib/waitlist.server";
import { publicAppOrigin } from "~/lib/public-origin.server";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";
import { recordSensitiveAction } from "~/lib/security-audit.server";
import {
  navigateToShopifyBillingConfirmation,
  submitShopifyBillingForm,
} from "~/lib/shopify-billing.client";

/**
 * Plan selection, upgrade and downgrade.
 *
 * Shopify's App Store requirements are explicit that a merchant must be able to
 * change plans in both directions without contacting support, and that charge
 * approval must not open in a pop-up. `billing.request` satisfies both: it
 * returns a redirect to Shopify's own confirmation page. Upgrades use
 * Shopify's normal immediate/prorated replacement while a downgrade is sent
 * using the separate next-cycle billing key, so the merchant keeps their
 * current plan until the next billing cycle.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, async (ctx) => {
    const plan = await resolvePlan(ctx);
    const isTest = billingIsTestForShop(ctx.shop);
    const foundingOffer = plan.planId
      ? null
      : await findFoundingMerchantEntitlementForShop(ctx.shop.id);

    return {
      isDemo: plan.isDemo,
      currentPlan: plan.planId,
      status: plan.status,
      plans: Object.values(PLANS),
      // Only a verified owner whose waitlist email matches an unconsumed
      // publisher-side entitlement can see the discounted choice. The action
      // repeats the reservation check immediately before Shopify billing.
      foundingOffer: Boolean(foundingOffer),
      scheduledDowngrade: plan.pendingPlanId
        ? { name: PLANS[plan.pendingPlanId].name }
        : null,
      /** Surfaced so a reviewer can see the charge is a test one, not a real bill. */
      isTest,
    };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  return withShopContext(request, async (ctx) => {
    await requireRecentReauthentication(request, ctx.user);

    if (!ctx.billing) {
      return {
        error:
          "The seeded demo store has no Shopify billing session, so no plan can " +
          "be selected here. Install MyMeridian on a store to subscribe.",
      };
    }

    const form = await request.formData();
    const requested = String(form.get("plan") ?? "");

    // A billing key names a plan/interval and, for lower-tier changes, can
    // carry the next-cycle suffix. It must match one of the exact keys in the
    // server billing configuration — a crafted "starter-weekly" must never
    // resolve to a charge.
    const requestedPlan = billingKeyInfo(requested);
    if (!requestedPlan) {
      return { error: "That plan does not exist." };
    }

    // A plan-change key carries no trial days; an initial key does. Enforce
    // that distinction on the server rather than trusting the hidden form
    // field, so a merchant cannot manufacture a second trial or request an
    // immediate downgrade by editing the page.
    const current = await resolvePlan(ctx);
    if (current.planId) {
      const isDowngrade =
        PLANS[requestedPlan.planId].price < PLANS[current.planId].price;
      const expectedKind = isDowngrade ? "downgrade" : "change";

      if (requestedPlan.planId === current.planId) {
        return { error: "You are already on that plan." };
      }
      if (requestedPlan.kind !== expectedKind) {
        return {
          error: isDowngrade
            ? "Downgrades take effect at the next billing cycle."
            : "Plan changes must be confirmed through Shopify.",
        };
      }
    } else if (requestedPlan.kind !== "initial") {
      return { error: "Start with a plan before changing it." };
    }

    const limited = await firstDeniedRequestLimit({
      request,
      scope: "billing_plan_change",
      windowMs: 15 * 60 * 1_000,
      ipLimit: 10,
      subject: ctx.user?.id ?? ctx.shop.id,
      subjectLimit: 5,
    });
    if (limited) {
      return new Response(RATE_LIMIT_MESSAGE, {
        status: 429,
        headers: rateLimitHeaders(limited),
      });
    }

    let isTest: boolean;
    try {
      isTest = await resolveBillingChargeMode(ctx);
    } catch (error) {
      logOperationalFailure("billing store-type verification", error);
      return {
        error:
          "Could not verify whether this store can accept a real charge. " +
          "No charge was created; retry in a moment.",
      };
    }

    if (requestedPlan.founding) {
      // A founding plan key has no standalone value. It is valid only when
      // this exact store has a time-bounded reservation from a verified owner
      // email, made before Shopify opens its approval page.
      const entitlement = await reserveFoundingMerchantEntitlement(ctx.shop.id);
      if (!entitlement) {
        return {
          error:
            "Founding Merchant pricing is not available for this store. " +
            "Use an eligible verified waitlist account before choosing a plan.",
        };
      }
    }

    // Shopify sends the merchant back here after they approve or decline, so the
    // page they land on reflects the charge they just made.
    await recordSensitiveAction({
      shopId: ctx.shop.id,
      actorType: ctx.user ? "web_account" : "shopify_session",
      actorId: ctx.user?.id ?? ctx.session?.id ?? ctx.shop.id,
      request,
      action: "BILLING_PLAN_CHANGE_REQUESTED",
      resource: `plan:${requested}`,
    });
    return ctx.billing.request({
      plan: requested as BillingKey,
      isTest,
      returnUrl: `${publicAppOrigin(request)}/app/plan?shop=${encodeURIComponent(ctx.shop.domain)}`,
    });
  });
}

export default function Plan() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  // Which interval the three cards are quoting. Purely presentational until
  // the form is submitted, so plain component state is the right home for it.
  const [yearly, setYearly] = useState(false);

  async function submitBilling(event: FormEvent<HTMLFormElement>) {
    // Calling preventDefault after an await is too late: the browser has
    // already begun the document navigation. Check synchronously so only a
    // real App Bridge session takes the authenticated fetch path.
    if (!window.shopify?.idToken) return;
    event.preventDefault();

    const form = event.currentTarget;
    setBillingError(null);
    setBillingBusy(true);
    const result = await submitShopifyBillingForm(form);
    try {
      if (result.kind === "redirect") {
        navigateToShopifyBillingConfirmation(result.url);
        return;
      }
      if (result.kind === "error") setBillingError(result.message);
    } finally {
      setBillingBusy(false);
    }
  }

  return (
    <>
      {(billingError ?? result?.error) && (
        <Banner tone="warn">{billingError ?? result?.error}</Banner>
      )}

      {data.isDemo ? (
        <Banner>
          This is the seeded demo, shown on the Scale plan so every screen is
          reachable. On a real store this page is where a merchant subscribes,
          upgrades and downgrades.
        </Banner>
      ) : data.currentPlan ? (
        <Banner>
          You are on <strong>{PLANS[data.currentPlan].name}</strong>. Choosing a
          higher plan takes effect after Shopify confirms it. A downgrade takes
          effect at your next billing cycle, so you keep your current plan until
          then. Shopify shows the timing and amount before you confirm.
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
          Test mode: charges created for this development store are Shopify test
          charges and take no money.
        </Banner>
      )}

      {data.scheduledDowngrade && (
        <Banner>
          Your change to <strong>{data.scheduledDowngrade.name}</strong> is
          scheduled for the next billing cycle. You keep your current plan
          until then.
        </Banner>
      )}

      {/* Billed monthly / billed yearly. A group of two buttons rather than a
          switch: "which price list am I looking at" is a choice between two
          named things, and a switch hides one of the names. */}
      <div
        className="interval-toggle"
        role="group"
        aria-label="Billing Interval"
      >
        <button
          type="button"
          className="btn sm"
          aria-pressed={!yearly}
          onClick={() => setYearly(false)}
        >
          Billed Monthly
        </button>
        <button
          type="button"
          className="btn sm"
          aria-pressed={yearly}
          onClick={() => setYearly(true)}
        >
          Billed Yearly · Two Months Free
        </button>
      </div>

      <div className="grid cols-3">
        {data.plans.map((plan) => {
          const current = data.currentPlan === plan.id;
          const isDowngrade = Boolean(
            data.currentPlan &&
              plan.price < (PLANS[data.currentPlan].price ?? 0),
          );
          const selectedKey = yearly ? annualKey(plan.id) : plan.id;
          const founding = Boolean(
            data.foundingOffer && !data.currentPlan && !yearly,
          );
          const billingKey = isDowngrade
            ? nextCycleKey(selectedKey)
            : data.currentPlan
              ? changeKey(selectedKey)
              : founding
                ? foundingKey(plan.id)
                : selectedKey;

          return (
            <div className="card plan-card" key={plan.id}>
              <Stat
                label={plan.name}
                value={
                  <>
                    <Money
                      cents={
                        (yearly
                          ? plan.annualPrice
                          : founding
                            ? plan.price * 0.85
                            : plan.price) * 100
                      }
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
                    {founding && (
                      <> · Founding Merchant price for the first 12 months</>
                    )}
                    {yearly && (
                      <>
                        {" "}
                        · effective{" "}
                        <Money
                          cents={Math.round((plan.annualPrice * 100) / 12)}
                          currency="USD"
                        />
                        /month · saves{" "}
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
              <div className="plan-card-body">
                <ul
                  className="tiny secondary plan-features"
                  style={{ paddingLeft: 16, lineHeight: 1.7 }}
                >
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>

                {/* Billing confirmation always leaves the iframe for Shopify's
                    own approval screen. Embedded submissions add a fresh
                    App Bridge token and deliberately handle Shopify's 401
                    handoff; an older/non-embedded browser keeps the secure
                    document-submission fallback. */}
                {current ? (
                  <Badge tone="good">Current Plan</Badge>
                ) : (
                  <Form method="post" reloadDocument onSubmit={submitBilling}>
                    <input
                      type="hidden"
                      name="plan"
                      value={billingKey}
                    />
                    <button
                      className={data.currentPlan ? "btn sm" : "btn primary sm"}
                      disabled={busy || billingBusy}
                    >
                      {!data.currentPlan
                        ? founding
                          ? `Claim Founding Merchant Price`
                          : `Start 14-Day Trial`
                        : isDowngrade
                          ? `Downgrade To ${plan.name}`
                          : plan.price > (PLANS[data.currentPlan].price ?? 0)
                          ? `Upgrade To ${plan.name}`
                          : `Switch To ${plan.name}`}
                    </button>
                    {isDowngrade && (
                      <p className="tiny muted plan-change-note">
                        Takes effect next billing cycle.
                      </p>
                    )}
                  </Form>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="tiny muted" style={{ maxWidth: "72ch", lineHeight: 1.7 }}>
        Billing is handled entirely by Shopify and appears on your Shopify
        invoice. MyMeridian never sees a card number. Cancelling the app from
        your Shopify admin cancels the subscription with it.
      </p>
    </>
  );
}
