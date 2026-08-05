import { PLANS, type PlanId } from "~/shopify.server";

/**
 * Match a Shopify subscription name back to a plan this build knows about.
 *
 * This lives here rather than beside the webhook that uses it because a route
 * module may only export `loader`, `action`, `middleware` and `headers` if it
 * wants its server imports stripped from the client bundle. Exporting a helper
 * that reaches into `~/shopify.server` alongside them drags the whole Shopify
 * server config into the browser build, and the production build fails outright
 * with "Server-only module referenced by client".
 */
export function planIdForSubscriptionName(
  name: string | undefined,
): PlanId | null {
  if (!name) return null;

  const wanted = name.trim().toLowerCase();
  for (const plan of Object.values(PLANS)) {
    if (plan.name.toLowerCase() === wanted || plan.id === wanted) return plan.id;
  }

  return null;
}
