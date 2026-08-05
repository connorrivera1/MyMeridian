import { Channel, CostSource, SyncStatus } from "@prisma/client";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { deriveChannel, reconcileFirstOrdersForShop } from "~/lib/sync.server";
import { generatePricingRecommendations } from "~/lib/pricing.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";
import { capabilitiesForShop, type Capabilities } from "~/lib/scopes";
import { unauthenticated } from "~/shopify.server";

/**
 * Historical import from the Admin GraphQL API.
 *
 * Webhooks only ever describe what happens next, so a freshly installed store
 * would otherwise show a dashboard of zeroes until it happened to take an
 * order. This pulls the existing catalogue and order history once at install,
 * and can be re-run at any time.
 *
 * Deliberately paginated rather than using bulk operations: bulk adds async
 * polling and JSONL retrieval for a payoff that only matters above roughly a
 * hundred thousand orders. The page size and cost handling below are the part
 * that actually keeps this alive on a real store.
 */

/** Minimal shape of the adapter's admin client — avoids leaking its generics. */
interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const ORDER_PAGE_SIZE = 25;
const PRODUCT_PAGE_SIZE = 50;

/**
 * Page sizes for the collections nested inside a product or an order.
 *
 * These are first pages, not limits: anything past them is fetched by a
 * follow-up query. They were limits until now, which is the worst version of
 * this bug — a store with 120-variant products or 80-line wholesale orders lost
 * the overflow silently, and the missing cost showed up as margin.
 */
const VARIANTS_PER_PRODUCT = 100;
const LINE_ITEMS_PER_ORDER = 50;

/**
 * Safety valve so a dev run against a huge store cannot go on forever.
 *
 * Validated rather than coerced: `??` only catches undefined, so `Number("")`
 * gave 0 and capped the import at a single order while still reporting success,
 * and any non-numeric value gave NaN, which made `count >= MAX_ORDERS` always
 * false and removed the safety valve entirely.
 */
const MAX_ORDERS = (() => {
  const configured = Number(process.env.MERIDIAN_MAX_BACKFILL_ORDERS);
  return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
})();

const MAX_THROTTLE_RETRIES = 6;

// ---------------------------------------------------------------------------
// GraphQL plumbing
// ---------------------------------------------------------------------------

interface GraphQLError {
  message: string;
  extensions?: { code?: string };
}

export class ShopifyFieldError extends Error {}

/**
 * Pull the GraphQL errors out of whatever `admin.graphql` produced.
 *
 * This has to cope with a thrown error as well as a returned body, and the
 * thrown case is the one that actually happens. Shopify answers HTTP 200 for
 * both THROTTLED and access-denied, and the client library treats a 200 whose
 * body carries `errors` as a failure: `GraphqlClient.request` calls
 * `throwFailedRequest`, which raises `GraphqlQueryError` carrying
 * `body.errors.graphQLErrors`. The React Router wrapper re-throws it unchanged.
 *
 * So the response this function used to inspect never has an `errors` key —
 * it either resolves clean or throws. Reading only the resolved body left the
 * whole throttle-backoff and capability-probe path below unreachable.
 */
function graphQLErrorsFrom(error: unknown): GraphQLError[] {
  const body = (error as { body?: { errors?: { graphQLErrors?: GraphQLError[] } } })
    ?.body;
  const errors = body?.errors?.graphQLErrors;
  if (Array.isArray(errors) && errors.length) return errors;

  // HTTP 429 arrives as HttpThrottlingError with no GraphQL body at all.
  const name = (error as { constructor?: { name?: string } })?.constructor?.name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === "HttpThrottlingError" || /throttl/i.test(message)) {
    return [{ message, extensions: { code: "THROTTLED" } }];
  }

  return [{ message }];
}

/** Exported for test only — see backfill-gql.test.ts. */
export async function gql<T>(
  admin: AdminClient,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
    let errors: GraphQLError[];

    try {
      const response = await admin.graphql(query, { variables });
      const body = (await response.json()) as {
        data?: T;
        errors?: GraphQLError[];
      };

      if (!body.errors?.length) {
        if (!body.data) throw new Error("Shopify returned no data.");
        return body.data;
      }

      errors = body.errors;
    } catch (error) {
      // A no-data response is our own error, not Shopify's; do not retry it.
      if (error instanceof Error && error.message === "Shopify returned no data.") {
        throw error;
      }
      errors = graphQLErrorsFrom(error);
    }

    const throttled = errors.some(
      (error) => error.extensions?.code === "THROTTLED",
    );

    if (throttled && attempt < MAX_THROTTLE_RETRIES) {
      // The cost bucket refills at a fixed rate; backing off is the only
      // correct response. Exponential, because a busy store will throttle
      // repeatedly and hammering it just burns the bucket again.
      await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
      continue;
    }

    const message = errors.map((error) => error.message).join("; ");

    // A missing or unauthorised field is a capability difference, not a
    // failure — the caller can retry with a narrower query.
    if (/doesn't exist|Field .* doesn't|access denied|not approved/i.test(message)) {
      throw new ShopifyFieldError(message);
    }

    throw new Error(`Shopify GraphQL: ${message}`);
  }

  throw new Error("Shopify GraphQL: still throttled after retries.");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const money = (set: { shopMoney?: { amount?: string } } | null | undefined) =>
  set?.shopMoney?.amount ?? "0.00";

/** "#1042" -> 1042 */
function orderNumberFrom(name: string | null | undefined): number {
  const digits = (name ?? "").replace(/\D/g, "");
  return digits ? Number(digits) : 0;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const SHOP_QUERY = `#graphql
  query MeridianShop {
    shop {
      name
      email
      currencyCode
      ianaTimezone
      plan { displayName }
    }
  }
`;

/**
 * `inventoryItem.unitCost` is the real COGS and by far the most valuable field
 * in this import — but it needs `read_inventory`. Requesting it without the
 * scope fails the whole query rather than returning null for that one field,
 * so it is only asked for when the store granted it.
 */
function productsQuery(includeCost: boolean) {
  return `#graphql
    query MeridianProducts($cursor: String, $pageSize: Int!) {
      products(first: $pageSize, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          productType
          vendor
          status
          variants(first: ${VARIANTS_PER_PRODUCT}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ${variantFields(includeCost)}
            }
          }
        }
      }
    }
  `;
}

function variantFields(includeCost: boolean) {
  return `
    id
    sku
    title
    price
    compareAtPrice
    inventoryQuantity
    ${includeCost ? "inventoryItem { unitCost { amount } }" : ""}
  `;
}

/**
 * The rest of a product's variants, for the products that have more than one
 * page of them.
 *
 * Without this, a product with more than `VARIANTS_PER_PRODUCT` variants
 * imported only the first page and the rest got no `Variant` row at all. Their
 * line items then snapshotted a zero unit cost and reported a 100% margin,
 * which is wrong in the direction that looks like good news.
 */
function productVariantsQuery(includeCost: boolean) {
  return `#graphql
    query MeridianProductVariants($id: ID!, $cursor: String, $pageSize: Int!) {
      product(id: $id) {
        variants(first: $pageSize, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ${variantFields(includeCost)}
          }
        }
      }
    }
  `;
}

/**
 * The journey fragment is requested separately because
 * `customerJourneySummary` is not readable on every store or plan. If it comes
 * back as a field error the import drops to the narrow query and carries on
 * with referrer-based attribution rather than failing the whole run.
 */
const LINE_ITEM_FIELDS = `
  id
  title
  sku
  quantity
  originalUnitPriceSet { shopMoney { amount } }
  totalDiscountSet { shopMoney { amount } }
  variant { id }
  product { id }
`;

const ORDER_FIELDS = `
  id
  name
  processedAt
  createdAt
  currencyCode
  displayFinancialStatus
  displayFulfillmentStatus
  subtotalPriceSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  totalPriceSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  lineItems(first: ${LINE_ITEMS_PER_ORDER}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ${LINE_ITEM_FIELDS}
    }
  }
  refunds {
    id
    refundLineItems(first: ${LINE_ITEMS_PER_ORDER}) {
      pageInfo { hasNextPage endCursor }
      nodes { quantity lineItem { id } }
    }
  }
`;

/**
 * The rest of one order's line items.
 *
 * An order over `LINE_ITEMS_PER_ORDER` lines previously imported the first page
 * and dropped the remainder, so its cost of goods was understated by whatever
 * share those lines carried — around 40% of COGS on an 80-line wholesale order,
 * reported as profit.
 */
const ORDER_LINE_ITEMS_QUERY = `#graphql
  query MeridianOrderLineItems($id: ID!, $cursor: String, $pageSize: Int!) {
    order(id: $id) {
      lineItems(first: $pageSize, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${LINE_ITEM_FIELDS}
        }
      }
    }
  }
`;

/** The rest of one refund's line items, for the same reason. */
const REFUND_LINE_ITEMS_QUERY = `#graphql
  query MeridianRefundLineItems($id: ID!, $cursor: String, $pageSize: Int!) {
    refund: node(id: $id) {
      ... on Refund {
        refundLineItems(first: $pageSize, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { quantity lineItem { id } }
        }
      }
    }
  }
`;

/** Needs read_fulfillments. */
const FULFILLMENT_FIELDS = `
  fulfillments(first: 10) {
    id
    createdAt
    status
    trackingInfo(first: 1) { company }
  }
`;

/** Protected customer data — needs read_customers *and* an approved request. */
const CUSTOMER_FIELDS = `
  customer { id email }
`;

/**
 * Also protected customer data, and additionally not exposed on every store or
 * plan, so it stays behind its own capability probe even when customer access
 * is granted.
 */
const JOURNEY_FIELDS = `
  customerJourneySummary {
    lastVisit {
      landingPage
      referrerUrl
      source
      utmParameters { source medium campaign }
    }
  }
`;

interface OrderQueryShape {
  journey: boolean;
  customers: boolean;
  fulfillments: boolean;
}

function ordersQuery(shape: OrderQueryShape) {
  return `#graphql
    query MeridianOrders($cursor: String, $pageSize: Int!) {
      orders(
        first: $pageSize
        after: $cursor
        sortKey: PROCESSED_AT
        query: "status:any"
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${ORDER_FIELDS}
          ${shape.customers ? CUSTOMER_FIELDS : ""}
          ${shape.journey ? JOURNEY_FIELDS : ""}
          ${shape.fulfillments ? FULFILLMENT_FIELDS : ""}
        }
      }
    }
  `;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface BackfillResult {
  products: number;
  orders: number;
  usedJourneyAttribution: boolean;
  reachedOrderCap: boolean;
  earliestOrderAt: Date | null;
  durationMs: number;
}

/**
 * Kick the import off without blocking the caller.
 *
 * Install must redirect the merchant into the app immediately; an import that
 * takes a minute cannot sit in the OAuth callback. Progress is written to the
 * Shop row and the UI polls it.
 *
 * On a long-lived server this is fine. On a serverless platform the process may
 * not outlive the response, and this should become a real job queue.
 */
/**
 * Re-acquire the admin client before its access token can expire.
 *
 * Offline access tokens are expiring now (Shopify requires it of new public
 * apps from 1 April 2026) and live about an hour. The client passed into
 * `runBackfill` is built once, in `afterAuth`, around a frozen Session — so on
 * a store whose import runs longer than the token's life, every request after
 * the hour mark fails with an authentication error and the import stops
 * partway with a plausible-looking partial dataset.
 *
 * `unauthenticated.admin()` goes through `ensureValidOfflineSession`, which
 * refreshes a session within five minutes of expiry and stores the new tokens,
 * so re-acquiring here is enough. Forty minutes leaves a wide margin, and a
 * failed re-acquisition keeps the existing client rather than aborting an
 * import that may still have a valid token.
 */
const ADMIN_CLIENT_MAX_AGE_MS = 40 * 60 * 1000;

function refreshingAdminClient(
  shopDomain: string,
  initial: AdminClient,
): AdminClient {
  let current = initial;
  let acquiredAt = Date.now();

  return {
    async graphql(query, options) {
      if (unauthenticated && Date.now() - acquiredAt >= ADMIN_CLIENT_MAX_AGE_MS) {
        try {
          current = (await unauthenticated.admin(shopDomain)).admin;
          acquiredAt = Date.now();
        } catch (error) {
          console.error(
            `[backfill] could not refresh the admin session for ${shopDomain}`,
            error,
          );
          // Deliberately not fatal — the current token may still be valid, and
          // if it is not the request below fails with a clearer error anyway.
          acquiredAt = Date.now();
        }
      }

      return current.graphql(query, options);
    },
  };
}

export function startBackfill(shopId: string, admin: AdminClient): void {
  void runBackfill(shopId, admin).catch((error) => {
    console.error(`[backfill] ${shopId} failed`, error);
  });
}

export async function runBackfill(
  shopId: string,
  admin: AdminClient,
): Promise<BackfillResult> {
  const startedAt = Date.now();

  // Read before the reset, because the reset is what used to throw the resume
  // point away.
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const resume = resumePointFor(shop);

  await prisma.shop.update({
    where: { id: shopId },
    data: {
      syncStatus: SyncStatus.RUNNING,
      syncStartedAt: new Date(),
      syncStage: resume ? "Resuming order history" : "Reading store settings",
      syncError: null,
      // Products are re-imported either way — the cursor only covers orders —
      // so the product counter always restarts. The order counter carries over,
      // or MAX_ORDERS would be a per-attempt cap rather than a total one.
      syncedOrders: resume?.importedOrders ?? 0,
      syncedProducts: 0,
      syncCursor: resume?.cursor ?? null,
    },
  });

  try {
    const capabilities = capabilitiesForShop(shop, process.env.SCOPES);

    // Offline access tokens now expire after an hour. The client handed in
    // here closes over a single frozen Session and never re-checks it, so a
    // large store's import would start failing 401 partway through — exactly
    // the stores where the import takes longest. See refreshingAdminClient.
    const client = refreshingAdminClient(shop.domain, admin);

    await importShopProfile(shopId, client);

    await prisma.shop.update({
      where: { id: shopId },
      data: {
        syncStage: capabilities.inventoryCost
          ? "Importing products and costs"
          : "Importing products (no cost access)",
      },
    });
    const products = await importProducts(shopId, client, capabilities.inventoryCost);

    await prisma.shop.update({
      where: { id: shopId },
      data: { syncStage: "Importing order history" },
    });
    const orders = await importOrders(shopId, client, capabilities, resume);

    // Without fulfilment access there are no shipping records, and a capacity
    // series built from orders alone would show a backlog that only ever grows
    // and fire false "you are behind" alerts. Better to have no capacity data
    // and say so than to invent a crisis.
    if (capabilities.fulfillments) {
      await prisma.shop.update({
        where: { id: shopId },
        data: { syncStage: "Rebuilding fulfilment history" },
      });
      await rebuildCapacityDays(shopId);
    } else {
      await prisma.capacityDay.deleteMany({ where: { shopId } });
    }

    await prisma.shop.update({
      where: { id: shopId },
      data: { syncStage: "Computing profitability" },
    });
    await recomputeShopProfitability(shopId);
    await generatePricingRecommendations(shopId).catch(() => 0);

    invalidateAnalyticsCache();

    await prisma.shop.update({
      where: { id: shopId },
      data: {
        syncStatus: SyncStatus.COMPLETE,
        syncCompletedAt: new Date(),
        syncStage: null,
        // A finished walk has no resume point. Leaving the last page's cursor
        // behind would let a later run that dies before the order stage resume
        // from the end of the previous import and skip the whole store.
        syncCursor: null,
        lastSyncedAt: new Date(),
        earliestOrderAt: orders.earliestOrderAt,
        hasAllOrdersScope: orders.sawOrdersOlderThan60Days,
      },
    });

    return {
      products,
      orders: orders.count,
      usedJourneyAttribution: orders.usedJourney,
      reachedOrderCap: orders.reachedCap,
      earliestOrderAt: orders.earliestOrderAt,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await prisma.shop.update({
      where: { id: shopId },
      data: {
        syncStatus: SyncStatus.FAILED,
        syncStage: null,
        syncError: message.slice(0, 500),
      },
    });

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function importShopProfile(shopId: string, admin: AdminClient) {
  const data = await gql<{
    shop: {
      name: string;
      email: string | null;
      currencyCode: string;
      ianaTimezone: string;
      plan: { displayName: string } | null;
    };
  }>(admin, SHOP_QUERY);

  // Currency and timezone are not cosmetic: the engine buckets ad spend and
  // orders into the merchant's own days, and getting the zone wrong shifts
  // every evening order into the next day's CAC.
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      name: data.shop.name,
      email: data.shop.email,
      currency: data.shop.currencyCode,
      timezone: data.shop.ianaTimezone,
      planName: data.shop.plan?.displayName ?? null,
    },
  });
}

interface VariantNode {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryItem: { unitCost: { amount: string } | null } | null;
}

/**
 * Every variant after the first page, for one product.
 *
 * Only called for the products that actually overflow, so a catalogue of
 * single-variant products costs exactly what it did before.
 */
export async function remainingVariants(
  admin: AdminClient,
  includeCost: boolean,
  productId: string,
  after: string | null,
): Promise<VariantNode[]> {
  const collected: VariantNode[] = [];
  let cursor = after;

  for (;;) {
    const data: {
      product: {
        variants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: VariantNode[];
        };
      } | null;
    } = await gql(admin, productVariantsQuery(includeCost), {
      id: productId,
      cursor,
      pageSize: VARIANTS_PER_PRODUCT,
    });

    const page = data.product?.variants;
    if (!page) break;

    collected.push(...page.nodes);

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return collected;
}

async function importProducts(
  shopId: string,
  admin: AdminClient,
  includeCost: boolean,
): Promise<number> {
  let cursor: string | null = null;
  let imported = 0;

  for (;;) {
    const data: {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          title: string;
          handle: string;
          productType: string | null;
          vendor: string | null;
          status: string;
          variants: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: VariantNode[];
          };
        }[];
      };
    } = await gql(admin, productsQuery(includeCost), {
      cursor,
      pageSize: PRODUCT_PAGE_SIZE,
    });

    for (const node of data.products.nodes) {
      const product = await prisma.product.upsert({
        where: { shopId_shopifyId: { shopId, shopifyId: node.id } },
        create: {
          shopId,
          shopifyId: node.id,
          title: node.title,
          handle: node.handle,
          productType: node.productType,
          vendor: node.vendor,
          status: node.status,
        },
        update: {
          title: node.title,
          handle: node.handle,
          productType: node.productType,
          vendor: node.vendor,
          status: node.status,
        },
      });

      const variants = node.variants.pageInfo.hasNextPage
        ? [
            ...node.variants.nodes,
            ...(await remainingVariants(
              admin,
              includeCost,
              node.id,
              node.variants.pageInfo.endCursor,
            )),
          ]
        : node.variants.nodes;

      for (const variant of variants) {
        // This is the real COGS, and the single most valuable field in the
        // whole import — without it every margin in the product is fiction.
        const unitCost = variant.inventoryItem?.unitCost?.amount ?? null;

        await prisma.variant.upsert({
          where: { shopId_shopifyId: { shopId, shopifyId: variant.id } },
          create: {
            shopId,
            productId: product.id,
            shopifyId: variant.id,
            sku: variant.sku,
            title: variant.title,
            price: variant.price,
            compareAtPrice: variant.compareAtPrice,
            unitCost,
            costSource: unitCost ? CostSource.SHOPIFY : CostSource.ESTIMATED,
            inventoryQty: variant.inventoryQuantity ?? 0,
          },
          update: {
            sku: variant.sku,
            title: variant.title,
            price: variant.price,
            compareAtPrice: variant.compareAtPrice,
            unitCost,
            costSource: unitCost ? CostSource.SHOPIFY : CostSource.ESTIMATED,
            inventoryQty: variant.inventoryQuantity ?? 0,
          },
        });
      }

      imported += 1;
    }

    await prisma.shop.update({
      where: { id: shopId },
      data: { syncedProducts: imported },
    });

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  return imported;
}

interface LineItemNode {
  id: string;
  title: string;
  sku: string | null;
  quantity: number;
  originalUnitPriceSet: never;
  totalDiscountSet: never;
  variant: { id: string } | null;
  product: { id: string } | null;
}

interface RefundLineItemNode {
  quantity: number;
  lineItem: { id: string } | null;
}

interface OrderNode {
  id: string;
  name: string;
  processedAt: string | null;
  createdAt: string;
  currencyCode: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  subtotalPriceSet: never;
  totalDiscountsSet: never;
  totalShippingPriceSet: never;
  totalTaxSet: never;
  totalPriceSet: never;
  totalRefundedSet: never;
  /** Absent entirely when customer access was not granted. */
  customer?: { id: string; email: string | null } | null;
  lineItems: {
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    nodes: LineItemNode[];
  };
  refunds: {
    id: string;
    refundLineItems: {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes: RefundLineItemNode[];
    };
  }[];
  /** Absent entirely when fulfilment access was not granted. */
  fulfillments?: {
    id: string;
    createdAt: string;
    status: string | null;
    trackingInfo: { company: string | null }[];
  }[];
  customerJourneySummary?: {
    lastVisit: {
      landingPage: string | null;
      referrerUrl: string | null;
      source: string | null;
      utmParameters: {
        source: string | null;
        medium: string | null;
        campaign: string | null;
      } | null;
    } | null;
  } | null;
}

/**
 * Fill in any line items the order page truncated, in place.
 *
 * Runs only for the orders that actually overflow — the common single-page
 * order costs one `hasNextPage` check and no extra request. Mutating the node
 * rather than returning a copy keeps `importOneOrder` unchanged: it already
 * treats `node.lineItems.nodes` as the complete set, which is exactly what it
 * now is.
 */
export async function hydrateOrderOverflow(
  admin: AdminClient,
  node: OrderNode,
): Promise<void> {
  if (node.lineItems.pageInfo?.hasNextPage) {
    node.lineItems.nodes = [
      ...node.lineItems.nodes,
      ...(await pageThrough<LineItemNode>(
        admin,
        ORDER_LINE_ITEMS_QUERY,
        node.id,
        node.lineItems.pageInfo.endCursor,
        (data) => (data as OrderLineItemsPage).order?.lineItems ?? null,
      )),
    ];
  }

  for (const refund of node.refunds ?? []) {
    if (!refund.refundLineItems.pageInfo?.hasNextPage) continue;

    refund.refundLineItems.nodes = [
      ...refund.refundLineItems.nodes,
      ...(await pageThrough<RefundLineItemNode>(
        admin,
        REFUND_LINE_ITEMS_QUERY,
        refund.id,
        refund.refundLineItems.pageInfo.endCursor,
        (data) => (data as RefundLineItemsPage).refund?.refundLineItems ?? null,
      )),
    ];
  }
}

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

interface OrderLineItemsPage {
  order: { lineItems: Connection<LineItemNode> } | null;
}

interface RefundLineItemsPage {
  refund: { refundLineItems: Connection<RefundLineItemNode> } | null;
}

/** Walk one nested connection to exhaustion, starting after `cursor`. */
async function pageThrough<T>(
  admin: AdminClient,
  query: string,
  id: string,
  cursor: string | null,
  select: (data: unknown) => Connection<T> | null,
): Promise<T[]> {
  const collected: T[] = [];
  let after = cursor;

  for (;;) {
    const page = select(
      await gql(admin, query, { id, cursor: after, pageSize: LINE_ITEMS_PER_ORDER }),
    );
    if (!page) break;

    collected.push(...page.nodes);

    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  return collected;
}

/** Exported for test only — see backfill-resume.test.ts. */
export async function importOrders(
  shopId: string,
  admin: AdminClient,
  capabilities: Capabilities,
  resume: OrderResumePoint | null = null,
) {
  let cursor: string | null = resume?.cursor ?? null;
  let count = resume?.importedOrders ?? 0;
  // The journey is only worth probing for when customer access exists at all.
  let usedJourney = capabilities.customers;
  let reachedCap = false;
  let usingResumeCursor = resume !== null;

  const sixtyDaysAgo = Date.now() - 60 * 86_400_000;

  // Orders are walked oldest-first (`sortKey: PROCESSED_AT`, ascending), so the
  // oldest order the API will ever hand us is on page one — which a resumed run
  // is precisely the run that does not fetch. Both of these are read off the
  // orders already stored rather than recomputed from the pages still to come,
  // or resuming would report the store's history as starting wherever it was
  // interrupted and then claim, from `hasAllOrdersScope`, that the store simply
  // had no trading before that date.
  const resumed = await priorOrderHistory(resume ? shopId : null);
  let earliestOrderAt: Date | null = resumed;
  let sawOrdersOlderThan60Days = resumed ? resumed.getTime() < sixtyDaysAgo : false;

  // Customers seen in this run, so the first order per customer is flagged
  // correctly without a query per order. A resumed run starts this empty and
  // will over-flag; `reconcileFirstOrdersForShop` below settles it shop-wide.
  const customerIdByGid = new Map<string, string>();
  const firstOrderSeen = new Set<string>();

  for (;;) {
    let page: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: OrderNode[];
      };
    };

    try {
      page = await gql(
        admin,
        ordersQuery({
          journey: usedJourney,
          customers: capabilities.customers,
          fulfillments: capabilities.fulfillments,
        }),
        { cursor, pageSize: ORDER_PAGE_SIZE },
      );
    } catch (error) {
      if (error instanceof ShopifyFieldError && usedJourney) {
        // This store cannot expose the customer journey. Attribution falls
        // back to the referrer, which is weaker but honest.
        console.warn(
          `[backfill] customerJourneySummary unavailable, continuing without it: ${error.message}`,
        );
        usedJourney = false;
        continue;
      }

      // A stored cursor Shopify will not take back — expired, or from a
      // connection that no longer exists — would otherwise strand the import
      // for good: every later attempt resumes from the same bad page and fails
      // in the same place. Fall back to a full walk, once, and only for the
      // request that actually carried the stored cursor.
      if (usingResumeCursor && isInvalidCursorError(error)) {
        console.warn(
          `[backfill] stored resume cursor rejected, restarting the order import: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        usingResumeCursor = false;
        cursor = null;
        count = 0;
        earliestOrderAt = null;
        sawOrdersOlderThan60Days = false;
        continue;
      }

      throw error;
    }

    usingResumeCursor = false;

    for (const node of page.orders.nodes) {
      const processedAt = new Date(node.processedAt ?? node.createdAt);
      if (!earliestOrderAt || processedAt < earliestOrderAt) {
        earliestOrderAt = processedAt;
      }
      if (processedAt.getTime() < sixtyDaysAgo) sawOrdersOlderThan60Days = true;

      await hydrateOrderOverflow(admin, node);

      await importOneOrder(shopId, node, customerIdByGid, firstOrderSeen);
      count += 1;

      if (count >= MAX_ORDERS) {
        reachedCap = true;
        break;
      }
    }

    await prisma.shop.update({
      where: { id: shopId },
      data: {
        syncedOrders: count,
        syncCursor: page.orders.pageInfo.endCursor,
      },
    });

    if (reachedCap || !page.orders.pageInfo.hasNextPage) break;
    cursor = page.orders.pageInfo.endCursor;
  }

  // `firstOrderSeen` only knows this run. Webhooks may have written newer
  // orders before the import ever started, and an import that stops at
  // MAX_ORDERS or resumes from a cursor never sees the whole customer. Settle
  // the flag from everything stored rather than from what this pass happened
  // to walk past.
  await reconcileFirstOrdersForShop(shopId);

  return {
    count,
    usedJourney,
    reachedCap,
    earliestOrderAt,
    sawOrdersOlderThan60Days,
    capabilities,
  };
}

async function importOneOrder(
  shopId: string,
  node: OrderNode,
  customerIdByGid: Map<string, string>,
  firstOrderSeen: Set<string>,
) {
  const visit = node.customerJourneySummary?.lastVisit;

  const { channel, utm } = deriveChannel({
    landingSite: visit?.landingPage,
    referringSite: visit?.referrerUrl,
    utmSource: visit?.utmParameters?.source ?? visit?.source,
    utmMedium: visit?.utmParameters?.medium,
    utmCampaign: visit?.utmParameters?.campaign,
  });

  const processedAt = new Date(node.processedAt ?? node.createdAt);

  // --- customer ---
  let customerId: string | null = null;
  if (node.customer?.id) {
    const cached = customerIdByGid.get(node.customer.id);
    if (cached) {
      customerId = cached;
    } else {
      const customer = await prisma.customer.upsert({
        where: { shopId_shopifyId: { shopId, shopifyId: node.customer.id } },
        create: {
          shopId,
          shopifyId: node.customer.id,
          email: node.customer.email,
          acquisitionChannel: channel,
          acquisitionCampaignId: utm.campaign,
          firstOrderAt: processedAt,
        },
        update: { email: node.customer.email },
      });
      customerId = customer.id;
      customerIdByGid.set(node.customer.id, customer.id);
    }
  }

  // Orders arrive oldest-first, so the first one seen for a customer in this
  // run is genuinely their first.
  const isFirstOrder = customerId ? !firstOrderSeen.has(customerId) : false;
  if (customerId) firstOrderSeen.add(customerId);

  const refundedQtyByLineItem = new Map<string, number>();
  for (const refund of node.refunds ?? []) {
    for (const item of refund.refundLineItems?.nodes ?? []) {
      if (!item.lineItem?.id) continue;
      refundedQtyByLineItem.set(
        item.lineItem.id,
        (refundedQtyByLineItem.get(item.lineItem.id) ?? 0) + item.quantity,
      );
    }
  }

  const orderData = {
    orderNumber: orderNumberFrom(node.name),
    processedAt,
    customerId,
    currency: node.currencyCode,
    subtotal: money(node.subtotalPriceSet),
    discountTotal: money(node.totalDiscountsSet),
    shippingCharged: money(node.totalShippingPriceSet),
    taxTotal: money(node.totalTaxSet),
    total: money(node.totalPriceSet),
    refundedTotal: money(node.totalRefundedSet),
    financialStatus: (node.displayFinancialStatus ?? "PAID").toLowerCase(),
    fulfillmentStatus: (node.displayFulfillmentStatus ?? "UNFULFILLED").toLowerCase(),
    channel,
    campaignId: utm.campaign,
    campaignName: utm.campaign,
    utmSource: utm.source,
    utmMedium: utm.medium,
    utmCampaign: utm.campaign,
    landingSite: visit?.landingPage ?? null,
    isFirstOrder,
  };

  const order = await prisma.order.upsert({
    where: { shopId_shopifyId: { shopId, shopifyId: node.id } },
    create: { shopId, shopifyId: node.id, ...orderData },
    update: orderData,
  });

  // --- line items ---
  const variantGids = node.lineItems.nodes
    .map((item) => item.variant?.id)
    .filter((id): id is string => !!id);

  const variants = variantGids.length
    ? await prisma.variant.findMany({
        where: { shopId, shopifyId: { in: variantGids } },
        select: { id: true, shopifyId: true, productId: true, unitCost: true },
      })
    : [];
  const variantByGid = new Map(variants.map((v) => [v.shopifyId, v]));

  await prisma.orderLineItem.deleteMany({ where: { orderId: order.id } });

  if (node.lineItems.nodes.length > 0) {
    await prisma.orderLineItem.createMany({
      data: node.lineItems.nodes.map((item) => {
        const variant = item.variant?.id
          ? variantByGid.get(item.variant.id)
          : undefined;

        return {
          shopId,
          orderId: order.id,
          shopifyId: item.id,
          variantId: variant?.id ?? null,
          productId: variant?.productId ?? null,
          title: item.title,
          sku: item.sku,
          quantity: item.quantity,
          unitPrice: money(item.originalUnitPriceSet),
          discount: money(item.totalDiscountSet),
          // Snapshotted from the variant's current landed cost. Historical
          // costs are not retrievable from Shopify, so this is the best
          // available basis — and it is frozen here so later cost changes
          // cannot rewrite this order's profit.
          unitCost: String(variant?.unitCost ?? "0"),
          refundedQty: refundedQtyByLineItem.get(item.id) ?? 0,
        };
      }),
    });
  }

  // --- fulfilments ---
  await prisma.fulfillment.deleteMany({ where: { orderId: order.id } });

  if (node.fulfillments?.length) {
    const itemCount = node.lineItems.nodes.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    await prisma.fulfillment.createMany({
      data: node.fulfillments.map((fulfillment) => ({
        shopId,
        orderId: order.id,
        // Carried so a later fulfillments/update matches this row by identity
        // rather than by timestamp, which an update repeats verbatim.
        shopifyId: fulfillment.id,
        status: (fulfillment.status ?? "success").toLowerCase(),
        createdAt: new Date(fulfillment.createdAt),
        shippedAt: new Date(fulfillment.createdAt),
        carrier: fulfillment.trackingInfo?.[0]?.company ?? null,
        itemCount,
        // Shopify does not know what the carrier charged. Left at zero so the
        // engine falls back to the merchant's shipping cost rule rather than
        // claiming the shipment was free.
        shippingCost: "0.00",
        pickPackCost: "0.00",
      })),
    });
  }
}

// ---------------------------------------------------------------------------
// Derived fulfilment history
// ---------------------------------------------------------------------------

/**
 * Rebuild the daily capacity series from imported orders and fulfilments.
 *
 * Backlog is cumulative orders received minus cumulative orders shipped, which
 * is the only definition that stays correct when a store ships out of order.
 * The capacity ceiling is the best day the warehouse has actually had — a
 * merchant has no configured number to give us, and their own best day is a
 * more honest ceiling than a guess.
 */
export async function rebuildCapacityDays(shopId: string) {
  const [received, shipped] = await Promise.all([
    prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "processedAt") AS day, COUNT(*) AS count
      FROM "Order" WHERE "shopId" = ${shopId}
      GROUP BY 1 ORDER BY 1
    `,
    prisma.$queryRaw<{ day: Date; count: bigint; units: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day,
             COUNT(*) AS count,
             COALESCE(SUM("itemCount"), 0) AS units
      FROM "Fulfillment" WHERE "shopId" = ${shopId}
      GROUP BY 1 ORDER BY 1
    `,
  ]);

  if (received.length === 0) return;

  const receivedByDay = new Map(
    received.map((row) => [row.day.toISOString().slice(0, 10), Number(row.count)]),
  );
  const shippedByDay = new Map(
    shipped.map((row) => [
      row.day.toISOString().slice(0, 10),
      { orders: Number(row.count), units: Number(row.units) },
    ]),
  );

  const start = received[0]!.day;
  const end = new Date();
  const days: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }

  let cumulativeReceived = 0;
  let cumulativeShipped = 0;

  const rows = days.map((day) => {
    const inbound = receivedByDay.get(day) ?? 0;
    const out = shippedByDay.get(day) ?? { orders: 0, units: 0 };

    cumulativeReceived += inbound;
    cumulativeShipped += out.orders;

    return {
      shopId,
      date: new Date(`${day}T00:00:00.000Z`),
      location: "primary",
      ordersReceived: inbound,
      ordersFulfilled: out.orders,
      unitsFulfilled: out.units,
      backlogEnd: Math.max(0, cumulativeReceived - cumulativeShipped),
      staffedHours: "0",
      maxDailyCapacity: 0,
    };
  });

  const observedCeiling = Math.max(...rows.map((row) => row.ordersFulfilled), 0);
  for (const row of rows) row.maxDailyCapacity = observedCeiling;

  await prisma.capacityDay.deleteMany({ where: { shopId } });
  for (let i = 0; i < rows.length; i += 500) {
    await prisma.capacityDay.createMany({ data: rows.slice(i, i + 500) });
  }
}

// ---------------------------------------------------------------------------

export interface OrderResumePoint {
  /** Shopify's `endCursor` from the last page this shop actually imported. */
  cursor: string;
  /** Orders already written by the interrupted run, so the cap stays a total. */
  importedOrders: number;
}

/**
 * Where an interrupted import should pick the order walk up again.
 *
 * The cursor has been written after every page since the sync columns were
 * added; nothing ever read it, so an import killed 19,000 orders in — by a
 * deploy, a crash, or the hour-long staleness rule in `backfillIsStale` — began
 * again at the first order and cost the merchant the whole walk a second time.
 *
 * Only an attempt that did not finish may be resumed. COMPLETE means the walk
 * ended and the next run is a genuine re-import; PENDING is set by
 * `ensureShopProvisioned` when the granted scopes change, and those runs must
 * re-read the store from the beginning because the query itself is now asking
 * for different fields.
 */
export function resumePointFor(shop: {
  syncStatus: SyncStatus;
  syncCursor: string | null;
  syncedOrders: number;
}): OrderResumePoint | null {
  if (!shop.syncCursor) return null;
  if (shop.syncStatus !== SyncStatus.RUNNING && shop.syncStatus !== SyncStatus.FAILED) {
    return null;
  }

  return {
    cursor: shop.syncCursor,
    importedOrders: Math.max(0, shop.syncedOrders),
  };
}

/** Exported for test only — see backfill-resume.test.ts. */
export function isInvalidCursorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cursor/i.test(message);
}

/** Oldest order already stored for a shop, or null when not resuming. */
async function priorOrderHistory(shopId: string | null): Promise<Date | null> {
  if (!shopId) return null;

  const oldest = await prisma.order.aggregate({
    where: { shopId },
    _min: { processedAt: true },
  });

  return oldest._min.processedAt ?? null;
}

export function backfillIsStale(shop: {
  syncStatus: SyncStatus;
  syncStartedAt: Date | null;
}): boolean {
  // A RUNNING import whose process died would otherwise show a spinner for
  // ever. Anything still running after an hour is treated as abandoned.
  if (shop.syncStatus !== SyncStatus.RUNNING) return false;
  if (!shop.syncStartedAt) return true;
  return Date.now() - shop.syncStartedAt.getTime() > 3_600_000;
}

export { Channel };
