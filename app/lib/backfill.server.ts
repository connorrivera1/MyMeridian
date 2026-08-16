import { Channel, CostSource, Prisma, SyncStatus } from "@prisma/client";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import {
  backfillIsStale,
  claimBackfill,
  completeBackfill,
  failBackfill,
  resumePointFor,
  startBackfillHeartbeat,
  updateBackfillProgress,
  type BackfillClaim,
  type BackfillOwner,
  type OrderResumePoint,
} from "~/lib/backfill-claim.server";
import {
  deriveChannel,
  fulfillmentDidShip,
  reconcileFirstOrdersForShop,
  syncFulfillmentFromShopify,
  syncOrderFromShopify,
} from "~/lib/sync.server";
import { seedOpeningCostBasis } from "~/lib/cost-history.server";
import { toMicros } from "~/engine/money";
import { generatePricingRecommendations } from "~/lib/pricing.server";
import { withProductLock } from "~/lib/product-lock.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";
import {
  capabilitiesForShop,
  parseScopes,
  type Capabilities,
} from "~/lib/scopes";
import { unauthenticated } from "~/shopify.server";

export { backfillIsStale, resumePointFor };
export type { OrderResumePoint };

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
 * Fulfilments asked for on the order page, and the ceiling for the follow-up.
 *
 * Almost every order has one shipment, so the page asks for few and pays a
 * scalar `fulfillmentsCount` to know when it was wrong. 250 is the Admin API's
 * standard truncation ceiling and is above any real order: a fulfilment covers
 * at least one line item, and an order cannot hold more line items than that.
 */
const FULFILLMENTS_PER_ORDER = 10;
const FULFILLMENTS_MAX_PER_ORDER = 250;

/**
 * Optional development safety valve.
 *
 * Production has no implicit order ceiling: silently stopping at 20,000 while
 * marking the import complete omitted a large store's newest orders and made
 * an incomplete ledger look current. Operators may still set an explicit
 * ceiling for a local diagnostic run, but reaching it is a visible FAILED
 * state with the resume cursor preserved — never a successful partial import.
 */
export function parseBackfillOrderLimit(
  raw: string | undefined,
): number | null {
  if (raw === undefined || raw.trim() === "") return null;

  const configured = Number(raw);
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error(
      "MERIDIAN_MAX_BACKFILL_ORDERS must be a positive integer when set",
    );
  }

  return configured;
}

const MAX_ORDERS = parseBackfillOrderLimit(
  process.env.MERIDIAN_MAX_BACKFILL_ORDERS,
);

const MAX_THROTTLE_RETRIES = 6;

/**
 * Errors that deserve another attempt even though Shopify did not say
 * THROTTLED.
 *
 * Retrying only on THROTTLED meant a single 502 from Shopify's edge, or one
 * dropped socket, marked the whole shop FAILED — and nothing in the app ever
 * retries a failed import on its own. A merchant who installed during a
 * Shopify blip got a partial store and a banner, and had to notice the banner
 * to recover. Shopify's own guidance is to retry 5xx.
 *
 * Deliberately narrow: 5xx, and the transport-level failures that mean the
 * request never landed. A 4xx other than 429 is a request we got wrong, and
 * repeating it verbatim would just fail six more times.
 *
 * The status is read from structured fields only, never matched out of the
 * message. A first attempt at this scanned the message for a 5xx-shaped
 * number, which is far too eager — an error quoting an order name, a variant
 * id or a price could contain "502" and buy itself a minute of backoff before
 * failing anyway. Only the phrases below, which have no other meaning, are
 * matched textually.
 */
function isTransient(error: unknown): boolean {
  const candidate = error as {
    response?: { status?: number; code?: number };
    status?: number;
    statusCode?: number;
    code?: string | number;
  };

  const status =
    candidate?.response?.status ??
    candidate?.response?.code ??
    candidate?.status ??
    candidate?.statusCode ??
    (typeof candidate?.code === "number" ? candidate.code : undefined);
  if (typeof status === "number" && status >= 500 && status <= 599) return true;

  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (
    /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH)$/.test(
      code,
    )
  ) {
    return true;
  }

  // The Shopify client's own retriable classes.
  const name = (error as { constructor?: { name?: string } })?.constructor
    ?.name;
  if (name === "HttpInternalError" || name === "HttpRetriableError")
    return true;

  const message = error instanceof Error ? error.message : "";
  return /socket hang up|network error|fetch failed|ECONNRESET|ETIMEDOUT/i.test(
    message,
  );
}

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
  const body = (
    error as { body?: { errors?: { graphQLErrors?: GraphQLError[] } } }
  )?.body;
  const errors = body?.errors?.graphQLErrors;
  if (Array.isArray(errors) && errors.length) return errors;

  // HTTP 429 arrives as HttpThrottlingError with no GraphQL body at all.
  const name = (error as { constructor?: { name?: string } })?.constructor
    ?.name;
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
    let transient = false;

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
      if (
        error instanceof Error &&
        error.message === "Shopify returned no data."
      ) {
        throw error;
      }
      errors = graphQLErrorsFrom(error);
      transient = isTransient(error);
    }

    const throttled = errors.some(
      (error) => error.extensions?.code === "THROTTLED",
    );

    if ((throttled || transient) && attempt < MAX_THROTTLE_RETRIES) {
      // The cost bucket refills at a fixed rate; backing off is the only
      // correct response. Exponential, because a busy store will throttle
      // repeatedly and hammering it just burns the bucket again.
      await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
      continue;
    }

    const message = errors.map((error) => error.message).join("; ");

    // A missing or unauthorised field is a capability difference, not a
    // failure — the caller can retry with a narrower query.
    if (
      /doesn't exist|Field .* doesn't|access denied|not approved/i.test(message)
    ) {
      throw new ShopifyFieldError(message);
    }

    throw new Error(`Shopify GraphQL: ${message}`);
  }

  throw new Error("Shopify GraphQL: still failing after retries.");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const money = (set: { shopMoney?: { amount?: string } } | null | undefined) =>
  set?.shopMoney?.amount ?? "0.00";

/** The customer-facing side of a Shopify money bag, when present. */
const presentmentMoney = (
  set:
    | { presentmentMoney?: { amount?: string; currencyCode?: string } }
    | null
    | undefined,
) => {
  const side = (
    set as
      | { presentmentMoney?: { amount?: string; currencyCode?: string } }
      | null
      | undefined
  )?.presentmentMoney;
  return side?.amount && side.currencyCode
    ? { amount: side.amount, currencyCode: side.currencyCode }
    : null;
};

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
      plan { displayName partnerDevelopment }
    }
    # Shopify defaults count queries to 10,000. Request an unbounded count so
    # an initial sync never presents that lower bound as a finished total.
    ordersCount(limit: null) {
      count
      precision
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
          updatedAt
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
    ${includeCost ? "inventoryItem { id updatedAt unitCost { amount } }" : ""}
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
const TAX_LINE_FIELDS = `
  title
  rate
  source
  channelLiable
  priceSet { shopMoney { amount } }
`;

const LINE_ITEM_FIELDS = `
  id
  title
  sku
  quantity
  originalUnitPriceSet { shopMoney { amount } }
  totalDiscountSet { shopMoney { amount } }
  variant { id }
  product { id }
  taxLines { ${TAX_LINE_FIELDS} }
`;

const REFUND_LINE_ITEM_FIELDS = `
  quantity
  lineItem { id }
  subtotalSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
`;

const ORDER_FIELDS = `
  id
  name
  processedAt
  createdAt
  updatedAt
  currencyCode
  presentmentCurrencyCode
  displayFinancialStatus
  displayFulfillmentStatus
  subtotalPriceSet { shopMoney { amount } }
  totalDiscountsSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  taxesIncluded
  taxLines { ${TAX_LINE_FIELDS} }
  shippingLines(first: 20) {
    nodes {
      title
      source
      discountedPriceSet { shopMoney { amount } }
      taxLines { ${TAX_LINE_FIELDS} }
    }
  }
  totalPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount } }
  lineItems(first: ${LINE_ITEMS_PER_ORDER}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ${LINE_ITEM_FIELDS}
    }
  }
  refunds {
    id
    totalRefundedSet { shopMoney { amount } }
    refundLineItems(first: ${LINE_ITEMS_PER_ORDER}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${REFUND_LINE_ITEM_FIELDS} }
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

const FULFILLMENT_NODE_FIELDS = `
  id
  createdAt
  updatedAt
  status
  totalQuantity
  trackingInfo(first: 1) { company }
`;

/**
 * Needs read_fulfillments.
 *
 * `Order.fulfillments` is a plain list, not a connection — its own
 * documentation calls `first` a truncation ("Truncate the array result to this
 * size") and there is no `pageInfo` to follow. So the overflow cannot be paged
 * the way line items and variants are; it has to be re-asked for. That is what
 * `fulfillmentsCount` is here for: a scalar that says how many there really
 * are, so a truncated order can be spotted and refetched rather than silently
 * losing every shipment past the tenth.
 */
const FULFILLMENT_FIELDS = `
  fulfillmentsCount { count precision }
  fulfillments(first: ${FULFILLMENTS_PER_ORDER}) {
    ${FULFILLMENT_NODE_FIELDS}
  }
`;

/** One order's fulfilments, re-asked for without the page query's truncation. */
const ORDER_FULFILLMENTS_QUERY = `#graphql
  query MeridianOrderFulfillments($id: ID!, $pageSize: Int!) {
    order(id: $id) {
      fulfillments(first: $pageSize) {
        ${FULFILLMENT_NODE_FIELDS}
      }
    }
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

/**
 * The optional groups in the order query, in the order they are given up.
 *
 * Shopify answers a request for a field it will not serve with HTTP 200 and an
 * access-denied error that *names the field* — "Access denied for
 * customerJourneySummary field." — and `gql` turns that into a
 * `ShopifyFieldError`. This table is how the import decides which field to stop
 * asking for, rather than assuming it knows which one failed.
 *
 * It has to be the message that decides, because the scopes a store grants and
 * the protected-customer-data request approved for the app are two different
 * permissions. `read_orders` is itself protected customer data, so a field can
 * be denied on a store that granted every scope Meridian asks for, and only the
 * error says which.
 *
 * `customerJourneySummary` is matched before `customer` deliberately: the
 * journey is the narrower loss, and `\bcustomer\b` does not match inside
 * `customerJourneySummary` anyway (the following `J` is a word character), so
 * neither pattern can steal the other's error.
 */
const OPTIONAL_ORDER_FIELDS: {
  key: keyof OrderQueryShape;
  /** What stops being imported once this group is dropped. */
  cost: string;
  implicated: RegExp;
}[] = [
  {
    key: "journey",
    cost: "attribution falls back to the referrer, which is weaker but honest",
    implicated: /customerJourneySummary|customer_journey/i,
  },
  {
    key: "customers",
    cost: "orders import without customer identity, so there is no CAC or lifetime value",
    implicated: /\bcustomers?\b|\bemail\b/i,
  },
  {
    key: "fulfillments",
    cost: "capacity forecasting and backlog alerts have nothing to read",
    implicated: /\bfulfillments?\b/i,
  },
];

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
      if (
        unauthenticated &&
        Date.now() - acquiredAt >= ADMIN_CLIENT_MAX_AGE_MS
      ) {
        try {
          current = (await unauthenticated.admin(shopDomain)).admin;
          acquiredAt = Date.now();
        } catch (error) {
          console.error(
            "[backfill] could not refresh the admin session for %s",
            shopDomain,
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

const activeBackfills = new Map<string, Promise<BackfillResult>>();

type BegunBackfill =
  | {
      started: true;
      resumed: boolean;
      task: Promise<BackfillResult>;
    }
  | { started: false; reason: "active" };

/** Claim in Postgres before scheduling any Shopify work. */
async function beginBackfill(
  shopId: string,
  admin: AdminClient,
): Promise<BegunBackfill> {
  // This is an inexpensive first line of defence for duplicate actions in one
  // Node process. The compare-and-set in claimBackfill is the authority across
  // tabs, processes and Fly machines.
  if (activeBackfills.has(shopId)) {
    return { started: false, reason: "active" };
  }

  const claim = await claimBackfill(shopId);
  if (!claim.claimed) return { started: false, reason: claim.reason };

  const task = runClaimedBackfill(shopId, admin, claim);
  activeBackfills.set(shopId, task);
  void task.then(
    () => {
      if (activeBackfills.get(shopId) === task) activeBackfills.delete(shopId);
    },
    () => {
      if (activeBackfills.get(shopId) === task) activeBackfills.delete(shopId);
    },
  );

  return { started: true, resumed: claim.resume !== null, task };
}

/** Claim and wait for completion. Used by tests and explicit maintenance. */
export async function runBackfill(
  shopId: string,
  admin: AdminClient,
): Promise<BackfillResult> {
  const begun = await beginBackfill(shopId, admin);
  if (!begun.started) {
    throw new Error("A historical import is already active for this shop.");
  }
  return begun.task;
}

async function runClaimedBackfill(
  shopId: string,
  admin: AdminClient,
  claim: Extract<BackfillClaim, { claimed: true }>,
): Promise<BackfillResult> {
  const startedAt = Date.now();
  const { shop, resume, owner } = claim;
  const heartbeat = startBackfillHeartbeat(shopId, owner);
  let heartbeatStopped = false;

  const stopHeartbeat = async () => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    await heartbeat.stop();
  };

  try {
    const capabilities = capabilitiesForShop(shop, process.env.SCOPES);

    // Offline access tokens now expire after an hour. The client handed in
    // here closes over a single frozen Session and never re-checks it, so a
    // large store's import would start failing 401 partway through — exactly
    // the stores where the import takes longest. See refreshingAdminClient.
    const client = refreshingAdminClient(shop.domain, admin);

    await importShopProfile(shopId, client, owner);

    await updateBackfillProgress(shopId, owner, {
      syncStage: capabilities.inventoryCost
        ? "Importing products and costs"
        : "Importing products (no cost access)",
    });
    const products = await importProducts(
      shopId,
      client,
      capabilities.inventoryCost,
      owner,
    );

    await updateBackfillProgress(shopId, owner, {
      syncStage: "Importing order history",
    });
    const orders = await importOrders(
      shopId,
      client,
      capabilities,
      resume,
      owner,
    );

    if (orders.reachedCap) {
      throw new Error(
        `Order import paused after ${orders.count.toLocaleString()} orders at ` +
          "MERIDIAN_MAX_BACKFILL_ORDERS. Remove or increase that diagnostic " +
          "limit, then retry from Settings; the resume cursor was preserved.",
      );
    }

    // Without fulfilment access there are no shipping records, and a capacity
    // series built from orders alone would show a backlog that only ever grows
    // and fire false "you are behind" alerts. Better to have no capacity data
    // and say so than to invent a crisis.
    if (capabilities.fulfillments) {
      await updateBackfillProgress(shopId, owner, {
        syncStage: "Rebuilding fulfilment history",
      });
      await rebuildCapacityDays(shopId);
    } else {
      await prisma.capacityDay.deleteMany({ where: { shopId } });
    }

    await updateBackfillProgress(shopId, owner, {
      syncStage: "Computing profitability",
    });
    await recomputeShopProfitability(shopId);
    await generatePricingRecommendations(shopId).catch(() => 0);

    invalidateAnalyticsCache();

    // Stop and await the timer before releasing its token. Otherwise an
    // in-flight renewal can race the terminal update and misreport lease loss.
    await stopHeartbeat();
    await completeBackfill(shopId, owner, {
      syncCompletedAt: new Date(),
      syncStage: null,
      // A finished walk has no resume point. Leaving the last page's cursor
      // behind would let a later run that dies before the order stage resume
      // from the end of the previous import and skip the whole store.
      syncCursor: null,
      lastSyncedAt: new Date(),
      earliestOrderAt: orders.earliestOrderAt,
      // This field describes authorization, not the shape of today's data.
      // A new store with zero old orders still has lifetime-history access;
      // seeing an old order is neither necessary nor a safe proxy for scope.
      hasAllOrdersScope: parseScopes(shop.grantedScopes).has("read_all_orders"),
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
    let failure: unknown = error;
    try {
      await stopHeartbeat();
    } catch (leaseError) {
      // The replacement owner's row must win. Lease loss is the useful error
      // even if the old worker was simultaneously failing for another reason.
      failure = leaseError;
    }

    const message =
      failure instanceof Error ? failure.message : String(failure);
    await failBackfill(shopId, owner, {
      syncStage: null,
      syncError: message.slice(0, 500),
    });

    throw failure;
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function importShopProfile(
  shopId: string,
  admin: AdminClient,
  owner: BackfillOwner,
) {
  const data = await gql<{
    shop: {
      name: string;
      email: string | null;
      currencyCode: string;
      ianaTimezone: string;
      plan: { displayName: string; partnerDevelopment: boolean } | null;
    };
    ordersCount?: { count: number; precision?: string | null } | null;
  }>(admin, SHOP_QUERY);

  // A lower-bound count cannot power a truthful percentage: "10,000 of
  // 10,000" could still mean a store has more history left. Keep only an exact
  // total and leave the UI indeterminate otherwise.
  const syncTotalOrders =
    data.ordersCount &&
    Number.isSafeInteger(data.ordersCount.count) &&
    data.ordersCount.count >= 0 &&
    (data.ordersCount.precision === undefined ||
      data.ordersCount.precision === null ||
      data.ordersCount.precision === "EXACT")
      ? data.ordersCount.count
      : null;

  // Currency and timezone are not cosmetic: the engine buckets ad spend and
  // orders into the merchant's own days, and getting the zone wrong shifts
  // every evening order into the next day's CAC.
  await updateBackfillProgress(shopId, owner, {
    name: data.shop.name,
    email: data.shop.email,
    currency: data.shop.currencyCode,
    timezone: data.shop.ianaTimezone,
    planName: data.shop.plan?.displayName ?? null,
    partnerDevelopment: data.shop.plan?.partnerDevelopment ?? null,
    syncTotalOrders,
  });
}

interface VariantNode {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryItem: {
    id: string;
    updatedAt: string;
    unitCost?: { amount: string } | null;
  } | null;
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

async function writePageProgress(
  shopId: string,
  owner: BackfillOwner | undefined,
  data: Prisma.ShopUpdateManyMutationInput,
): Promise<void> {
  if (owner) {
    await updateBackfillProgress(shopId, owner, data);
    return;
  }

  // importProducts/importOrders are exported so isolated stage tests can drive
  // Shopify pagination without manufacturing a Shop lease. A real runtime is
  // never allowed to take that unfenced test path.
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Historical import progress requires a run owner.");
  }
  await prisma.shop.update({ where: { id: shopId }, data });
}

export async function importProducts(
  shopId: string,
  admin: AdminClient,
  includeCost: boolean,
  /** Production orchestration always supplies the fencing owner. */
  owner?: BackfillOwner,
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
          updatedAt: string;
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

      // This is the first time Meridian can honestly say it observed every
      // price in this product, including variants fetched from overflow pages.
      // Product.updatedAt orders source state, but a title or inventory edit
      // can move it and therefore cannot prove the price existed any earlier.
      const observedAt = new Date();

      const sourceUpdatedAt = new Date(node.updatedAt);
      if (Number.isNaN(sourceUpdatedAt.getTime())) {
        throw new Error(
          `Shopify returned an invalid updatedAt for product ${node.id}.`,
        );
      }

      await withProductLock(shopId, node.id, async (tx) => {
        const existingProduct = await tx.product.findUnique({
          where: { shopId_shopifyId: { shopId, shopifyId: node.id } },
          select: { id: true, shopifyUpdatedAt: true },
        });

        // A webhook carrying a later Shopify mutation may have committed while
        // this product page was in flight. The advisory lock prevents the
        // writes from interleaving; the source watermark prevents the older
        // page from winning merely because it acquired the lock second.
        if (
          existingProduct?.shopifyUpdatedAt &&
          sourceUpdatedAt < existingProduct.shopifyUpdatedAt
        ) {
          return;
        }

        const product = await tx.product.upsert({
          where: { shopId_shopifyId: { shopId, shopifyId: node.id } },
          create: {
            shopId,
            shopifyId: node.id,
            title: node.title,
            handle: node.handle,
            productType: node.productType,
            vendor: node.vendor,
            status: node.status,
            shopifyUpdatedAt: sourceUpdatedAt,
          },
          update: {
            title: node.title,
            handle: node.handle,
            productType: node.productType,
            vendor: node.vendor,
            status: node.status,
            shopifyUpdatedAt: sourceUpdatedAt,
          },
        });

        for (const variant of variants) {
          // This is the real COGS, and the single most valuable field in the
          // whole import — without it every margin in the product is fiction.
          const unitCost = variant.inventoryItem?.unitCost?.amount ?? null;
          const inventoryItemShopifyId = variant.inventoryItem?.id ?? null;
          const inventoryItemUpdatedAt = variant.inventoryItem?.updatedAt
            ? new Date(variant.inventoryItem.updatedAt)
            : null;
          const price = new Prisma.Decimal(variant.price);
          const existingVariant = await tx.variant.findUnique({
            where: { shopId_shopifyId: { shopId, shopifyId: variant.id } },
            select: {
              id: true,
              price: true,
              _count: { select: { priceHistory: true } },
            },
          });

          const record = await tx.variant.upsert({
            where: { shopId_shopifyId: { shopId, shopifyId: variant.id } },
            create: {
              shopId,
              productId: product.id,
              shopifyId: variant.id,
              sku: variant.sku,
              title: variant.title,
              price,
              compareAtPrice: variant.compareAtPrice,
              unitCost: includeCost ? unitCost : null,
              costSource:
                includeCost && unitCost
                  ? CostSource.SHOPIFY
                  : CostSource.ESTIMATED,
              inventoryItemShopifyId,
              inventoryItemUpdatedAt,
              inventoryQty: variant.inventoryQuantity ?? 0,
            },
            update: {
              sku: variant.sku,
              title: variant.title,
              price,
              compareAtPrice: variant.compareAtPrice,
              ...(includeCost
                ? {
                    unitCost,
                    costSource: unitCost
                      ? CostSource.SHOPIFY
                      : CostSource.ESTIMATED,
                  }
                : {}),
              inventoryItemShopifyId,
              inventoryItemUpdatedAt,
              inventoryQty: variant.inventoryQuantity ?? 0,
            },
          });

          // Give the timeline a floor while the catalog is being read. Without
          // it a brand-new install has current costs but no cost history, and
          // the merchant's first backdated correction would have nothing to
          // supersede. Idempotent: only an empty timeline is seeded.
          if (includeCost && unitCost) {
            await seedOpeningCostBasis(
              {
                shopId,
                variantId: record.id,
                unitCostMicros: toMicros(unitCost),
                source: CostSource.SHOPIFY,
              },
              tx,
            );
          }

          const needsPriceFact =
            !existingVariant ||
            existingVariant._count.priceHistory === 0 ||
            !new Prisma.Decimal(existingVariant.price).equals(price);
          if (!needsPriceFact) continue;

          // The current price and its first honest observation are one fact.
          // A failed history insert rolls the variant update back with it.
          const duplicate = await tx.priceChange.findFirst({
            where: { variantId: record.id, price, effectiveAt: observedAt },
            select: { id: true },
          });
          if (!duplicate) {
            await tx.priceChange.create({
              data: {
                shopId,
                variantId: record.id,
                price,
                effectiveAt: observedAt,
              },
            });
          }
        }
      });

      imported += 1;
    }

    await writePageProgress(shopId, owner, { syncedProducts: imported });

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
  taxLines?: TaxLineNode[];
}

interface TaxLineNode {
  title: string;
  rate: number | null;
  source: string | null;
  channelLiable: boolean | null;
  priceSet: { shopMoney?: { amount?: string } };
}

interface RefundLineItemNode {
  quantity: number;
  lineItem: { id: string } | null;
  subtotalSet: never;
  totalTaxSet: never;
}

export interface FulfillmentNode {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status: string | null;
  /** "Sum of all line item quantities for the fulfillment." */
  totalQuantity: number | null;
  trackingInfo: { company: string | null }[];
}

interface OrderNode {
  id: string;
  name: string;
  processedAt: string | null;
  createdAt: string;
  updatedAt?: string;
  currencyCode: string;
  presentmentCurrencyCode?: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  subtotalPriceSet: never;
  totalDiscountsSet: never;
  totalShippingPriceSet: never;
  totalTaxSet: never;
  taxesIncluded?: boolean;
  taxLines?: TaxLineNode[];
  shippingLines?: {
    nodes: {
      title: string;
      source: string | null;
      discountedPriceSet: never;
      taxLines: TaxLineNode[];
    }[];
  };
  totalPriceSet: {
    shopMoney?: { amount?: string };
    presentmentMoney?: { amount?: string; currencyCode?: string };
  };
  totalRefundedSet: never;
  /** Absent entirely when customer access was not granted. */
  customer?: { id: string; email: string | null } | null;
  lineItems: {
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    nodes: LineItemNode[];
  };
  refunds: {
    id: string;
    totalRefundedSet: never;
    refundLineItems: {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes: RefundLineItemNode[];
    };
  }[];
  /** Absent entirely when fulfilment access was not granted. */
  fulfillments?: FulfillmentNode[];
  /** How many the order really has, so a truncated list can be spotted. */
  fulfillmentsCount?: { count: number; precision: string } | null;
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

  if (fulfillmentsWereTruncated(node)) {
    const refetched = (
      (await gql(admin, ORDER_FULFILLMENTS_QUERY, {
        id: node.id,
        pageSize: FULFILLMENTS_MAX_PER_ORDER,
      })) as OrderFulfillmentsPage
    ).order?.fulfillments;

    // A deleted order answers `order: null`. Keep the shipments the page did
    // give us rather than dropping the ones we already hold.
    if (refetched) node.fulfillments = refetched;
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

interface OrderFulfillmentsPage {
  order: { fulfillments: FulfillmentNode[] } | null;
}

/**
 * Whether the order page handed back fewer shipments than the order has.
 *
 * `fulfillmentsCount` is absent when fulfilment access was not granted, and
 * then there is nothing to refetch. A precision that is not exact is treated
 * as a possible undercount: the cost of being wrong is one extra request for
 * that order, against losing shipments the merchant paid to make.
 */
function fulfillmentsWereTruncated(node: OrderNode): boolean {
  const total = node.fulfillmentsCount;
  if (!total || !node.fulfillments) return false;
  if (total.precision && total.precision !== "EXACT") return true;
  return total.count > node.fulfillments.length;
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
      await gql(admin, query, {
        id,
        cursor: after,
        pageSize: LINE_ITEMS_PER_ORDER,
      }),
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
  /** Production orchestration always supplies the fencing owner. */
  owner?: BackfillOwner,
) {
  let cursor: string | null = resume?.cursor ?? null;
  let count = resume?.importedOrders ?? 0;
  // Which optional groups this run is still asking for. Narrowed in place by
  // the ShopifyFieldError handler below as Shopify refuses them one at a time.
  // The journey is only worth probing for when customer access exists at all.
  const shape: OrderQueryShape = {
    journey: capabilities.customers,
    customers: capabilities.customers,
    fulfillments: capabilities.fulfillments,
  };
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
  let sawOrdersOlderThan60Days = resumed
    ? resumed.getTime() < sixtyDaysAgo
    : false;

  for (;;) {
    let page: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: OrderNode[];
      };
    };

    try {
      page = await gql(admin, ordersQuery(shape), {
        cursor,
        pageSize: ORDER_PAGE_SIZE,
      });
    } catch (error) {
      if (error instanceof ShopifyFieldError) {
        // Give up the field Shopify actually named, not the one this code used
        // to guess at. Only a group still in the query can be the cause, and
        // each pass disables at least one, so this terminates: once nothing
        // optional is left the error is real and falls through to the throw.
        const refused = OPTIONAL_ORDER_FIELDS.find(
          (candidate) =>
            shape[candidate.key] && candidate.implicated.test(error.message),
        );

        if (refused) {
          console.warn(
            `[backfill] ${refused.key} unavailable, continuing without it — ` +
              `${refused.cost}: ${error.message}`,
          );
          shape[refused.key] = false;
          // Customer access denied takes the journey with it: the journey is a
          // property of the same shopper, so a second round trip to be told so
          // again buys nothing.
          if (refused.key === "customers") shape.journey = false;
          continue;
        }
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

      await importOneOrder(shopId, node);
      count += 1;
    }

    const progress = {
      syncedOrders: count,
      syncCursor: page.orders.pageInfo.endCursor,
    };
    await writePageProgress(shopId, owner, progress);

    // Stop only between complete GraphQL pages. Stopping in the middle and
    // saving the page's end cursor skipped the unprocessed tail forever on a
    // resume. A configured limit is therefore a page-granularity diagnostic
    // ceiling, and a reached ceiling is surfaced as a failed/paused import by
    // runBackfill rather than as COMPLETE.
    reachedCap =
      MAX_ORDERS !== null &&
      count >= MAX_ORDERS &&
      page.orders.pageInfo.hasNextPage;

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
    usedJourney: shape.journey,
    reachedCap,
    earliestOrderAt,
    sawOrdersOlderThan60Days,
    capabilities,
  };
}

async function importOneOrder(shopId: string, node: OrderNode) {
  const visit = node.customerJourneySummary?.lastVisit;

  const { channel, utm } = deriveChannel({
    landingSite: visit?.landingPage,
    referringSite: visit?.referrerUrl,
    utmSource: visit?.utmParameters?.source ?? visit?.source,
    utmMedium: visit?.utmParameters?.medium,
    utmCampaign: visit?.utmParameters?.campaign,
  });

  const refundEvents = (node.refunds ?? []).map((refund) => ({
    transactions: [
      {
        status: "success",
        kind: "refund",
        amount: money(refund.totalRefundedSet),
      },
    ],
    refund_line_items: (refund.refundLineItems?.nodes ?? [])
      .filter((item) => item.lineItem?.id)
      .map((item) => ({
        line_item_id: item.lineItem!.id,
        quantity: item.quantity,
        subtotal_set: { shop_money: { amount: money(item.subtotalSet) } },
        total_tax_set: { shop_money: { amount: money(item.totalTaxSet) } },
      })),
  }));
  const perRefundTotalCents = refundEvents.reduce(
    (sum, refund) =>
      sum + Math.round(Number(refund.transactions[0]!.amount) * 100),
    0,
  );
  const refundedTotal = money(node.totalRefundedSet);
  const orderPresentment = presentmentMoney(node.totalPriceSet);
  const totalLineItemsPrice = node.lineItems.nodes
    .reduce(
      (total, item) =>
        total.plus(
          new Prisma.Decimal(money(item.originalUnitPriceSet)).times(
            item.quantity,
          ),
        ),
      new Prisma.Decimal(0),
    )
    .toFixed(2);

  // Use the exact same source-watermarked, advisory-locked transaction as live
  // webhooks. A page fetched before a newer delivery can therefore finish
  // later without mixing its header with the newer delivery's children.
  await syncOrderFromShopify(shopId, {
    id: node.id,
    order_number: orderNumberFrom(node.name),
    processed_at: node.processedAt,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    currency: node.currencyCode,
    presentment_currency:
      node.presentmentCurrencyCode ?? orderPresentment?.currencyCode ?? null,
    subtotal_price: money(node.subtotalPriceSet),
    total_line_items_price: totalLineItemsPrice,
    total_discounts: money(node.totalDiscountsSet),
    total_shipping_price_set: {
      shop_money: { amount: money(node.totalShippingPriceSet) },
    },
    total_tax: money(node.totalTaxSet),
    taxes_included: Boolean(node.taxesIncluded),
    tax_lines: (node.taxLines ?? []).map((line) => ({
      title: line.title,
      rate: line.rate,
      source: line.source,
      channel_liable: line.channelLiable,
      price_set: { shop_money: { amount: money(line.priceSet) } },
    })),
    shipping_lines: (node.shippingLines?.nodes ?? []).map((line) => ({
      title: line.title,
      source: line.source,
      price: money(line.discountedPriceSet),
      tax_lines: line.taxLines.map((tax) => ({
        title: tax.title,
        rate: tax.rate,
        source: tax.source,
        channel_liable: tax.channelLiable,
        price_set: { shop_money: { amount: money(tax.priceSet) } },
      })),
    })),
    total_price: money(node.totalPriceSet),
    total_price_set: {
      shop_money: { amount: money(node.totalPriceSet) },
      ...(orderPresentment
        ? {
            presentment_money: {
              amount: orderPresentment.amount,
              currency_code: orderPresentment.currencyCode,
            },
          }
        : {}),
    },
    financial_status: (node.displayFinancialStatus ?? "PAID").toLowerCase(),
    fulfillment_status: (
      node.displayFulfillmentStatus ?? "UNFULFILLED"
    ).toLowerCase(),
    landing_site: visit?.landingPage ?? null,
    referring_site: visit?.referrerUrl ?? null,
    meridian_utm_source: utm.source,
    meridian_utm_medium: utm.medium,
    meridian_utm_campaign: utm.campaign,
    customer: node.customer
      ? { id: node.customer.id, email: node.customer.email }
      : undefined,
    line_items: node.lineItems.nodes.map((item) => ({
      id: item.id,
      variant_id: item.variant?.id,
      product_id: item.product?.id,
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
      price: money(item.originalUnitPriceSet),
      discount_allocations: [{ amount: money(item.totalDiscountSet) }],
      tax_lines: (item.taxLines ?? []).map((tax) => ({
        title: tax.title,
        rate: tax.rate,
        source: tax.source,
        channel_liable: tax.channelLiable,
        price_set: { shop_money: { amount: money(tax.priceSet) } },
      })),
    })),
    refunds:
      perRefundTotalCents > 0 ||
      refundEvents.some((refund) => refund.refund_line_items.length > 0)
        ? refundEvents
        : refundedTotal !== "0.00"
          ? [
              {
                transactions: [
                  { status: "success", kind: "refund", amount: refundedTotal },
                ],
                refund_line_items: [],
              },
            ]
          : [],
  });

  // Fulfilments have their own Shopify source clock. Each write and its
  // derived Order.fulfillmentStatus update still share the same order lock and
  // transaction; a delayed pre-cancellation import row cannot win.
  for (const fulfillment of node.fulfillments ?? []) {
    await syncFulfillmentFromShopify(shopId, {
      id: fulfillment.id,
      order_id: node.id,
      created_at: fulfillment.createdAt,
      updated_at: fulfillment.updatedAt ?? fulfillment.createdAt,
      status: fulfillment.status,
      tracking_company: fulfillment.trackingInfo?.[0]?.company ?? null,
      line_items: [{ quantity: fulfillment.totalQuantity ?? 0 }],
    });
  }
}

/**
 * One database row per shipment, from the shipments the order actually has.
 *
 * Exported for test only — the two things this gets right are both things the
 * import had wrong, and neither is visible through a mocked Prisma.
 *
 * `itemCount` is that shipment's own units, read from Shopify's
 * `totalQuantity`. It used to be the *whole order's* units written onto every
 * shipment of it, so a 12-unit order sent in three parcels recorded 36 units
 * shipped. `rebuildCapacityDays` sums this column for the warehouse's daily
 * throughput and takes the busiest day as the capacity ceiling, so a store
 * that splits shipments had both inflated by however many parcels it splits
 * into — and a ceiling set too high is one that no real day ever reaches,
 * which is exactly the alert the Fulfilment screen exists to raise.
 *
 * `shippedAt` is null for a cancelled or failed fulfilment, matching what
 * `syncFulfillmentFromShopify` has written since the webhook fix. The import
 * stamped it unconditionally, so a shipment that was cancelled and re-made
 * counted as two.
 */
export function fulfillmentRowsForOrder(
  shopId: string,
  orderId: string,
  fulfillments: readonly FulfillmentNode[],
) {
  return fulfillments.map((fulfillment) => {
    const status = String(fulfillment.status ?? "success").toLowerCase();
    const createdAt = new Date(fulfillment.createdAt);

    return {
      shopId,
      orderId,
      // Carried so a later fulfillments/update matches this row by identity
      // rather than by timestamp, which an update repeats verbatim.
      shopifyId: fulfillment.id,
      status,
      createdAt,
      shopifyUpdatedAt: new Date(
        fulfillment.updatedAt ?? fulfillment.createdAt,
      ),
      shippedAt: fulfillmentDidShip(status) ? createdAt : null,
      carrier: fulfillment.trackingInfo?.[0]?.company ?? null,
      itemCount: fulfillment.totalQuantity ?? 0,
      // Shopify does not know what the carrier charged. Left at zero so the
      // engine falls back to the merchant's shipping cost rule rather than
      // claiming the shipment was free.
      shippingCost: "0.00",
      pickPackCost: "0.00",
    };
  });
}

// ---------------------------------------------------------------------------
// Derived fulfilment history
// ---------------------------------------------------------------------------

/**
 * The zone to cut the warehouse's days on.
 *
 * Postgres throws on a zone name it does not recognise, and this runs at the
 * very end of an import — a store whose `timezone` is empty or malformed would
 * lose the whole walk to it. UTC is the wrong answer for such a store but it is
 * the answer the series already had, so falling back cannot make anything worse.
 */
function capacityZone(timezone: string | null | undefined): string {
  if (!timezone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

/**
 * Rebuild the daily capacity series from imported orders and fulfilments.
 *
 * Backlog is cumulative orders received minus cumulative orders shipped, which
 * is the only definition that stays correct when a store ships out of order.
 * The capacity ceiling is the best day the warehouse has actually had — a
 * merchant has no configured number to give us, and their own best day is a
 * more honest ceiling than a guess.
 *
 * Both halves of that subtraction have to count the same thing, and they did
 * not. Received counted orders; shipped counted *fulfilment rows*, so a store
 * that splits one order across three parcels retired three orders from a
 * backlog it had only ever added one to. `Math.max(0, ...)` then pinned the
 * backlog at zero for ever, and the screen whose entire purpose is to warn a
 * merchant before the warehouse falls behind could not report that it had.
 *
 * So an order is counted once, on the day its last shipment left — an order
 * still partly in the building has not been fulfilled — while units stay on
 * the day they physically shipped, because that is the throughput question.
 * Cancelled and failed fulfilments are excluded by `shippedAt IS NOT NULL`
 * rather than by naming statuses here, which keeps one definition of "shipped"
 * in `fulfillmentDidShip` instead of a second one written in SQL.
 *
 * Every day here is a day in the *shop's* zone. These columns are
 * `timestamp without time zone` holding UTC, so a bare `date_trunc('day', …)`
 * cuts the warehouse's week on UTC midnight: for a Los Angeles store that is
 * 4pm local, and every order placed in the merchant's evening — the busiest
 * hours of the day — was received on tomorrow's row. Backlog, throughput, the
 * capacity ceiling and the days-to-clear promise were all built on a day
 * boundary the warehouse does not work to, and one that disagreed with the day
 * every other screen buckets by, which uses the shop's zone via `dayKey`.
 *
 * The seeded demo store cannot show this: it only ever places orders between
 * 08:00 and 23:59 UTC, which is 00:00 to 15:59 in its own Los Angeles zone, so
 * no seeded order ever falls on the far side of a UTC midnight. Checked against
 * the demo database — 12,379 orders, none of them shifted.
 */
export async function rebuildCapacityDays(shopId: string) {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { timezone: true },
  });
  const zone = capacityZone(shop.timezone);

  // `AT TIME ZONE 'UTC'` reads the stored naive timestamp as the UTC instant it
  // is; the second `AT TIME ZONE` renders that instant as a naive local one.
  // `date_trunc` then cuts on local midnight, and the result comes back as a
  // naive date that names the shop's calendar day.
  const localDay = (column: Prisma.Sql) =>
    Prisma.sql`date_trunc('day', ${column} AT TIME ZONE 'UTC' AT TIME ZONE ${zone}::text)`;

  const [received, shippedOrders, shippedUnits] = await Promise.all([
    prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT ${localDay(Prisma.sql`"processedAt"`)} AS day, COUNT(*) AS count
      FROM "Order" WHERE "shopId" = ${shopId}
      GROUP BY 1 ORDER BY 1
    `,
    prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT ${localDay(Prisma.sql`last_shipped`)} AS day, COUNT(*) AS count
      FROM (
        SELECT "orderId", MAX("shippedAt") AS last_shipped
        FROM "Fulfillment"
        WHERE "shopId" = ${shopId} AND "shippedAt" IS NOT NULL
        GROUP BY "orderId"
      ) completed
      GROUP BY 1 ORDER BY 1
    `,
    prisma.$queryRaw<{ day: Date; units: bigint }[]>`
      SELECT ${localDay(Prisma.sql`"shippedAt"`)} AS day,
             COALESCE(SUM("itemCount"), 0) AS units
      FROM "Fulfillment"
      WHERE "shopId" = ${shopId} AND "shippedAt" IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `,
  ]);

  if (received.length === 0) return;

  const dayKey = (day: Date) => day.toISOString().slice(0, 10);

  const receivedByDay = new Map(
    received.map((row) => [dayKey(row.day), Number(row.count)]),
  );
  const ordersShippedByDay = new Map(
    shippedOrders.map((row) => [dayKey(row.day), Number(row.count)]),
  );
  const unitsShippedByDay = new Map(
    shippedUnits.map((row) => [dayKey(row.day), Number(row.units)]),
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
    const out = {
      orders: ordersShippedByDay.get(day) ?? 0,
      units: unitsShippedByDay.get(day) ?? 0,
    };

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

  const observedCeiling = Math.max(
    ...rows.map((row) => row.ordersFulfilled),
    0,
  );
  for (const row of rows) row.maxDailyCapacity = observedCeiling;

  await prisma.capacityDay.deleteMany({ where: { shopId } });
  for (let i = 0; i < rows.length; i += 500) {
    await prisma.capacityDay.createMany({ data: rows.slice(i, i + 500) });
  }
}

// ---------------------------------------------------------------------------

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

export { Channel };
