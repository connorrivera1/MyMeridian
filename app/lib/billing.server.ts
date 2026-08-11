import { basePlanId, PLANS, type PlanId } from "~/lib/plans";

/**
 * Match a Shopify subscription name back to a plan this build knows about.
 *
 * This lives here rather than beside the webhook that uses it because a route
 * module may only export `loader`, `action`, `middleware` and `headers` if it
 * wants its server imports stripped from the client bundle. The catalogue is
 * client-safe, so this pure matcher does not initialize Shopify or session
 * storage merely to compare a plan name.
 */
export function planIdForSubscriptionName(
  name: string | undefined,
): PlanId | null {
  if (!name) return null;

  const wanted = name.trim().toLowerCase();

  // billing.request names the subscription after the billing key, so an
  // annual subscription comes back as "starter-annual". The interval is a
  // billing detail; the entitlement is the plan, so both keys resolve to it.
  const fromKey = basePlanId(wanted);
  if (fromKey) return fromKey;

  for (const plan of Object.values(PLANS)) {
    if (plan.name.toLowerCase() === wanted) return plan.id;
  }

  return null;
}
