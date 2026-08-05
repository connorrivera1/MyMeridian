import type { ActionFunctionArgs } from "react-router";

import prisma from "~/db.server";
import { handleWebhook } from "~/lib/webhooks.server";
import { PLANS, type PlanId } from "~/shopify.server";

/**
 * app_subscriptions/update.
 *
 * Plan selection happens on Shopify's billing screen (managed pricing), so
 * this webhook is the only way the app learns which plan a merchant is on.
 * Without it the Subscription row is never written and Settings shows every
 * store as "trial" forever.
 *
 * Plans are matched by name against PLANS; the names configured in the
 * Partner Dashboard pricing page must match "Starter" / "Growth" / "Scale".
 */

const ACTIVE_STATUSES = new Set(["active", "accepted"]);

export function planIdForSubscriptionName(name: string | undefined): PlanId | null {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  for (const plan of Object.values(PLANS)) {
    if (plan.name.toLowerCase() === wanted || plan.id === wanted) return plan.id;
  }
  return null;
}

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
      // An active charge for a plan this build does not know is a config
      // mismatch between the Partner Dashboard and PLANS — surface it loudly
      // rather than silently billing on one plan and gating on another.
      console.error(
        `[billing] active subscription "${sub.name}" for ${shopDomain} matches no known plan`,
      );
    }

    const data = {
      // Cancelled, expired, declined or frozen charges drop the store back to
      // trial rather than leaving it on a plan it no longer pays for.
      plan: isActive && planId ? planId : "trial",
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

    console.info(
      `[billing] ${shopDomain}: subscription "${sub.name}" -> plan=${data.plan} status=${data.status}`,
    );
  });
}

export const loader = () => new Response(null, { status: 405 });
