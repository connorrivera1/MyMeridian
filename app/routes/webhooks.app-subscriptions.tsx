import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { planIdForSubscriptionName } from "~/lib/billing.server";
import { ANNUAL_SUFFIX } from "~/lib/plans";
import { handleWebhook } from "~/lib/webhooks.server";

/**
 * app_subscriptions/update.
 *
 * Meridian bills through the Billing API (see `app/lib/plan.server.ts` for why
 * not Shopify App Pricing), and this topic is still delivered for Billing API
 * charges. It is not the only path any more — `resolvePlan` re-reads the plan
 * from Shopify whenever the stored row is stale — but it is the fast one: a
 * merchant who upgrades sees the new plan on their next page load rather than
 * up to ten minutes later.
 *
 * Plan names come from `PLANS` in this build, which is also what the Billing
 * API charge is created from, so the two cannot drift the way they could under
 * managed pricing.
 */

const ACTIVE_STATUSES = new Set(["active", "accepted"]);

interface AppSubscriptionPayload {
  admin_graphql_api_id?: string;
  name?: string;
  status?: string;
  trial_ends_on?: string | null;
  billing_on?: string | null;
}

export async function action({ request }: ActionFunctionArgs) {
  return handleWebhook(request, async ({ shopDomain, payload }) => {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop) return;

    const sub = (payload.app_subscription ?? {}) as AppSubscriptionPayload;
    const status = (sub.status ?? "").toLowerCase();
    const isActive = ACTIVE_STATUSES.has(status);
    const planId = planIdForSubscriptionName(sub.name);

    if (isActive && !planId) {
      // An active charge for a plan this build does not know means a charge
      // created by an older deploy whose PLANS have since changed. Surface it
      // loudly rather than silently billing on one plan and gating on another.
      console.error(
        `[billing] active subscription "${sub.name}" for ${shopDomain} matches no known plan`,
      );
    }

    // The billing key carries the interval: "growth-annual" is an annual
    // charge, a bare plan id is monthly. Stored on the row because MRR is not
    // computable without it — an annual Growth subscriber contributes
    // 1490/12, not 149.
    const interval = (sub.name ?? "").trim().toLowerCase().endsWith(ANNUAL_SUFFIX)
      ? "annual"
      : "monthly";

    const data = {
      // Cancelled, expired, declined or frozen charges drop the store to no
      // plan rather than leaving it on one it no longer pays for. "none" and
      // not "trial": under the Billing API the free trial is a property of an
      // active subscription, not a state that precedes one.
      plan: isActive && planId ? planId : "none",
      interval,
      status: status || "unknown",
      shopifyChargeId: sub.admin_graphql_api_id ?? null,
      trialEndsAt: sub.trial_ends_on ? new Date(sub.trial_ends_on) : null,
      currentPeriodEnd: sub.billing_on ? new Date(sub.billing_on) : null,
    };

    await prisma.subscription.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, ...data },
      update: data,
    });

    // Append-only history. The upsert above answers "what plan is this store
    // on"; this row answers "what happened and when" — which is what MRR
    // over time, churn and trial conversion are computed from, and what the
    // audit asked for when it flagged plan changes overwriting their past.
    await prisma.subscriptionEvent.create({
      data: {
        shopId: shop.id,
        name: sub.name ?? "",
        plan: data.plan,
        interval,
        status: data.status,
      },
    });

    console.info(
      `[billing] ${shopDomain}: subscription "${sub.name}" -> plan=${data.plan} status=${data.status}`,
    );
  });
}

export const loader = () => new Response(null, { status: 405 });
