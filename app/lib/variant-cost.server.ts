import { CostSource } from "@prisma/client";

import prisma from "~/db.server";
import { capabilitiesForShop } from "~/lib/scopes";
import { hasShopifyCredentials, unauthenticated } from "~/shopify.server";

/**
 * Fetch unit cost for variants the webhooks could not supply it for.
 *
 * `products/create` and `products/update` carry price, sku and inventory but
 * not cost — cost lives on the InventoryItem, and Shopify does not put it in
 * the product payload. Until now nothing filled that gap: only the install-time
 * backfill ever read `inventoryItem.unitCost`, so a SKU added after install had
 * a null cost, showed a 100% gross margin, and sat at the top of the
 * most-profitable list until someone happened to run a manual re-import.
 *
 * So the webhook has to go and ask. This is a small, targeted follow-up query
 * on the variants that actually need one, not a re-import.
 */
export async function backfillVariantCosts(
  shopId: string,
  shopDomain: string,
  variantGids: string[],
): Promise<number> {
  if (!variantGids.length) return 0;
  if (!hasShopifyCredentials || !unauthenticated) return 0;

  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) return 0;

  // Without read_inventory the field is not merely null — asking for it fails
  // the whole query, so the request must not be made at all.
  if (!capabilitiesForShop(shop, process.env.SCOPES).inventoryCost) return 0;

  // Only the ones actually missing a measured cost. A variant whose cost is
  // already SHOPIFY-sourced is re-read only when its cost could have changed,
  // which a product webhook does not tell us, so leave it alone.
  const pending = await prisma.variant.findMany({
    where: {
      shopId,
      shopifyId: { in: variantGids },
      OR: [{ unitCost: null }, { costSource: { not: CostSource.SHOPIFY } }],
    },
    select: { id: true, shopifyId: true },
  });

  if (!pending.length) return 0;

  const { admin } = await unauthenticated.admin(shopDomain);

  const response = await admin.graphql(
    `#graphql
      query MeridianVariantCosts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryItem { unitCost { amount } }
          }
        }
      }
    `,
    { variables: { ids: pending.map((variant) => variant.shopifyId) } },
  );

  const body = (await response.json()) as {
    data?: {
      nodes: ({ id: string; inventoryItem: { unitCost: { amount: string } | null } | null } | null)[];
    };
  };

  const costByGid = new Map<string, string>();
  for (const node of body.data?.nodes ?? []) {
    const amount = node?.inventoryItem?.unitCost?.amount;
    if (node && amount) costByGid.set(node.id, amount);
  }

  let updated = 0;
  for (const variant of pending) {
    const unitCost = costByGid.get(variant.shopifyId);
    if (!unitCost) continue;

    await prisma.variant.update({
      where: { id: variant.id },
      data: { unitCost, costSource: CostSource.SHOPIFY },
    });
    updated += 1;
  }

  return updated;
}
