/**
 * Bounded, read-only Admin GraphQL hydration for economic webhook ingestion.
 *
 * REST-shaped product webhooks are deliberately incomplete above 100
 * variants, and order webhooks contain only line-item references. These
 * helpers turn either signal into complete current GraphQL snapshots before a
 * database transaction is allowed to freeze links, prices, or COGS.
 */

import { unauthenticated } from "~/shopify.server";

type Payload = Record<string, any>;

export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** Re-acquire the offline client so durable retries also refresh its token. */
export async function adminClientForShop(
  shopDomain: string,
): Promise<AdminGraphqlClient> {
  if (!unauthenticated) {
    throw new Error("Shopify Admin API is unavailable for catalog hydration");
  }
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin;
}

const GRAPHQL_PAGE_SIZE = 250;
export const MAX_PRODUCT_VARIANTS = 2_048;

function asGid(kind: string, value: unknown): string {
  const text = String(value ?? "").trim();
  if (text.startsWith("gid://shopify/")) return text;
  return `gid://shopify/${kind}/${text}`;
}

function graphQLErrorsFrom(error: unknown): string[] {
  const errors = (
    error as {
      body?: { errors?: { graphQLErrors?: { message?: string }[] } };
    }
  )?.body?.errors?.graphQLErrors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((item) => item.message ?? "Unknown Shopify error");
  }
  return [error instanceof Error ? error.message : String(error)];
}

async function adminQuery<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  try {
    const response = await admin.graphql(query, { variables });
    const body = (await response.json()) as {
      data?: T;
      errors?: { message?: string }[];
    };
    if (body.errors?.length) {
      throw new Error(
        `Shopify GraphQL: ${body.errors
          .map((item) => item.message ?? "Unknown Shopify error")
          .join("; ")}`,
      );
    }
    if (!body.data) throw new Error("Shopify GraphQL returned no data");
    return body.data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Shopify GraphQL")) {
      throw error;
    }
    throw new Error(`Shopify GraphQL: ${graphQLErrorsFrom(error).join("; ")}`);
  }
}

interface InventorySnapshot {
  id: string;
  updatedAt: string;
  unitCost?: { amount: string } | null;
}

interface ProductSummary {
  id: string;
  title: string;
  handle: string;
  productType: string | null;
  vendor: string | null;
  status: string;
  updatedAt: string;
}

interface VariantSnapshot {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  updatedAt: string;
  inventoryItem: InventorySnapshot;
  product?: ProductSummary;
}

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

interface ProductSnapshot extends ProductSummary {
  variants: Connection<VariantSnapshot>;
}

function variantFields(includeCost: boolean): string {
  return `
    id
    sku
    title
    price
    compareAtPrice
    inventoryQuantity
    updatedAt
    inventoryItem {
      id
      updatedAt
      ${includeCost ? "unitCost { amount }" : ""}
    }
  `;
}

function productFields(): string {
  return `
    id
    title
    handle
    productType
    vendor
    status
    updatedAt
  `;
}

function productQuery(includeCost: boolean): string {
  return `#graphql
    query MeridianWebhookProduct($id: ID!, $cursor: String, $pageSize: Int!) {
      product(id: $id) {
        ${productFields()}
        variants(first: $pageSize, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ${variantFields(includeCost)} }
        }
      }
    }
  `;
}

function variantNodesQuery(includeCost: boolean): string {
  return `#graphql
    query MeridianOrderVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          ${variantFields(includeCost)}
          product { ${productFields()} }
        }
      }
    }
  `;
}

function inventoryItemQuery(includeCost: boolean): string {
  return `#graphql
    query MeridianInventoryItem($id: ID!, $cursor: String, $pageSize: Int!) {
      inventoryItem(id: $id) {
        id
        updatedAt
        ${includeCost ? "unitCost { amount }" : ""}
        variants(first: $pageSize, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            title
            price
            compareAtPrice
            inventoryQuantity
            updatedAt
            product { ${productFields()} }
          }
        }
      }
    }
  `;
}

function payloadForProduct(
  product: ProductSummary,
  variants: VariantSnapshot[],
  includeCost: boolean,
  original: Payload = {},
): Payload {
  return {
    ...original,
    id: product.id,
    title: product.title,
    handle: product.handle,
    product_type: product.productType,
    vendor: product.vendor,
    status: product.status,
    updated_at: product.updatedAt,
    variant_gids: variants.map((variant) => ({
      admin_graphql_api_id: variant.id,
    })),
    variants: variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      compare_at_price: variant.compareAtPrice,
      inventory_quantity: variant.inventoryQuantity ?? 0,
      updated_at: variant.updatedAt,
      inventory_item_gid: variant.inventoryItem.id,
      inventory_item_updated_at: variant.inventoryItem.updatedAt,
      unit_cost_known: includeCost,
      ...(includeCost
        ? { unit_cost: variant.inventoryItem.unitCost?.amount ?? null }
        : {}),
    })),
  };
}

function assertBoundedVariantPage(
  count: number,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  identity: string,
): void {
  if (
    count > MAX_PRODUCT_VARIANTS ||
    (count === MAX_PRODUCT_VARIANTS && pageInfo.hasNextPage)
  ) {
    throw new Error(
      `Shopify returned more than ${MAX_PRODUCT_VARIANTS} variants for ${identity}; refusing a truncated economic snapshot`,
    );
  }
  if (pageInfo.hasNextPage && !pageInfo.endCursor) {
    throw new Error(
      `Shopify omitted the next variant cursor for ${identity}; refusing a truncated economic snapshot`,
    );
  }
}

/** Complete the product snapshot omitted from a 100-variant webhook payload. */
export async function hydrateProductWebhook(
  admin: AdminGraphqlClient,
  payload: Payload,
  includeCost: boolean,
): Promise<Payload> {
  const productId = asGid("Product", payload.id);
  const variants: VariantSnapshot[] = [];
  let cursor: string | null = null;
  let product: ProductSnapshot | null = null;

  for (;;) {
    const data: { product: ProductSnapshot | null } = await adminQuery(
      admin,
      productQuery(includeCost),
      { id: productId, cursor, pageSize: GRAPHQL_PAGE_SIZE },
    );
    if (!data.product) {
      throw new Error(
        `Shopify product ${productId} was not found during webhook hydration`,
      );
    }
    product = data.product;
    variants.push(...data.product.variants.nodes);
    assertBoundedVariantPage(
      variants.length,
      data.product.variants.pageInfo,
      productId,
    );
    if (!data.product.variants.pageInfo.hasNextPage) break;
    cursor = data.product.variants.pageInfo.endCursor;
  }

  return payloadForProduct(product, variants, includeCost, payload);
}

/**
 * Hydrate every variant named by an order, including rows Meridian has never
 * seen. Missing nodes fail the durable delivery instead of freezing a zero-cost
 * anonymous line that a retry could have resolved.
 */
export async function hydrateOrderVariantProducts(
  admin: AdminGraphqlClient,
  variantIds: string[],
  includeCost: boolean,
): Promise<Payload[]> {
  const requested = [
    ...new Set(variantIds.map((id) => asGid("ProductVariant", id))),
  ];
  if (requested.length === 0) return [];

  const found = new Map<string, VariantSnapshot>();
  for (let offset = 0; offset < requested.length; offset += GRAPHQL_PAGE_SIZE) {
    const ids = requested.slice(offset, offset + GRAPHQL_PAGE_SIZE);
    const data: { nodes: (VariantSnapshot | null)[] } = await adminQuery(
      admin,
      variantNodesQuery(includeCost),
      { ids },
    );
    for (const node of data.nodes ?? []) {
      if (node?.id && node.product) found.set(node.id, node);
    }
  }

  const missing = requested.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Shopify did not return ${missing.length} referenced order variant(s): ${missing.join(", ")}`,
    );
  }

  const grouped = new Map<
    string,
    { product: ProductSummary; variants: VariantSnapshot[] }
  >();
  for (const id of requested) {
    const variant = found.get(id)!;
    const group = grouped.get(variant.product!.id) ?? {
      product: variant.product!,
      variants: [],
    };
    group.variants.push(variant);
    grouped.set(group.product.id, group);
  }

  return [...grouped.values()].map(({ product, variants }) =>
    payloadForProduct(product, variants, includeCost),
  );
}

/** Resolve an inventory-item edit to every current ProductVariant it serves. */
export async function hydrateInventoryItemProducts(
  admin: AdminGraphqlClient,
  inventoryItemId: string,
  includeCost: boolean,
): Promise<Payload[]> {
  const id = asGid("InventoryItem", inventoryItemId);
  const variants: VariantSnapshot[] = [];
  let cursor: string | null = null;
  let inventory: InventorySnapshot | null = null;

  for (;;) {
    const data: {
      inventoryItem:
        | (InventorySnapshot & {
            variants: Connection<Omit<VariantSnapshot, "inventoryItem">>;
          })
        | null;
    } = await adminQuery(admin, inventoryItemQuery(includeCost), {
      id,
      cursor,
      pageSize: GRAPHQL_PAGE_SIZE,
    });
    if (!data.inventoryItem) {
      throw new Error(
        `Shopify inventory item ${id} was not found during webhook hydration`,
      );
    }
    inventory = data.inventoryItem;
    variants.push(
      ...data.inventoryItem.variants.nodes.map((variant) => ({
        ...variant,
        inventoryItem: {
          id: inventory!.id,
          updatedAt: inventory!.updatedAt,
          ...(includeCost ? { unitCost: inventory!.unitCost ?? null } : {}),
        },
      })),
    );
    assertBoundedVariantPage(
      variants.length,
      data.inventoryItem.variants.pageInfo,
      id,
    );
    if (!data.inventoryItem.variants.pageInfo.hasNextPage) break;
    cursor = data.inventoryItem.variants.pageInfo.endCursor;
  }

  const grouped = new Map<
    string,
    { product: ProductSummary; variants: VariantSnapshot[] }
  >();
  for (const variant of variants) {
    if (!variant.product) continue;
    const group = grouped.get(variant.product.id) ?? {
      product: variant.product,
      variants: [],
    };
    group.variants.push(variant);
    grouped.set(group.product.id, group);
  }

  return [...grouped.values()].map(({ product, variants: productVariants }) =>
    payloadForProduct(product, productVariants, includeCost),
  );
}
