import prisma from "~/db.server";

interface AdminGraphqlClient {
  graphql: (query: string) => Promise<Response>;
}

interface ShopPlanResponse {
  data?: {
    shop?: {
      plan?: {
        displayName?: unknown;
        partnerDevelopment?: unknown;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

const SHOP_PLAN_QUERY = `#graphql
  query MeridianBillingStoreType {
    shop {
      plan {
        displayName
        partnerDevelopment
      }
    }
  }
`;

/**
 * Read Shopify's authoritative store-type signal and persist it for read-only
 * UI/billing checks. Charge creation calls this immediately before requesting
 * a subscription, so a development-to-paid conversion cannot inherit stale
 * test billing from a display label or an old import.
 */
export async function refreshShopPlanSignal(
  shopId: string,
  admin: AdminGraphqlClient,
): Promise<boolean> {
  const response = await admin.graphql(SHOP_PLAN_QUERY);
  if (!response.ok) {
    throw new Error(
      `Shopify store-type query failed with HTTP ${response.status}`,
    );
  }

  const body = (await response.json()) as ShopPlanResponse;
  if (body.errors?.length) {
    throw new Error(
      `Shopify store-type query failed: ${body.errors
        .map((error) => error.message ?? "unknown GraphQL error")
        .join("; ")}`,
    );
  }

  const plan = body.data?.shop?.plan;
  if (!plan || typeof plan.partnerDevelopment !== "boolean") {
    throw new Error(
      "Shopify store-type query omitted ShopPlan.partnerDevelopment",
    );
  }

  await prisma.shop.update({
    where: { id: shopId },
    data: {
      planName:
        typeof plan.displayName === "string" ? plan.displayName : null,
      partnerDevelopment: plan.partnerDevelopment,
    },
  });

  return plan.partnerDevelopment;
}
