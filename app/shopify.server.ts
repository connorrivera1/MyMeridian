import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import prisma from "./db.server";
import {
  PLANS,
  TRIAL_DAYS,
  ANNUAL_SUFFIX,
  USAGE_CAP_AMOUNT,
  USAGE_TERMS,
} from "./lib/plans";
import { parseScopes } from "./lib/scopes";

/**
 * Plans live in `lib/plans.ts` so route components can render the price list
 * without dragging this module into the client bundle. Re-exported here
 * because `shopifyApp()`'s billing config is built from them just below.
 */
export {
  PLANS,
  TRIAL_DAYS,
  ANNUAL_SUFFIX,
  annualKey,
  basePlanId,
  type PlanId,
  type BillingKey,
} from "./lib/plans";

/**
 * The app is buildable and runnable before it has Shopify credentials, so that
 * the seeded demo store works on a fresh clone. `shopifyApp()` validates its
 * config eagerly, so it is only constructed when credentials actually exist.
 */
export const hasShopifyCredentials = Boolean(
  process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET,
);

function buildShopify() {
  return shopifyApp({
    apiKey: process.env.SHOPIFY_API_KEY!,
    apiSecretKey: process.env.SHOPIFY_API_SECRET!,
    apiVersion: ApiVersion.July26,
    // Shopify CLI configuration requires commas. Stored session values from
    // older installs have appeared in both forms, so runtime parsing remains
    // defensive rather than turning a legacy string into one invalid scope.
    scopes: [...parseScopes(process.env.SCOPES)],
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
    authPathPrefix: "/auth",
    sessionStorage: new PrismaSessionStorage(prisma),
    distribution: AppDistribution.AppStore,
    isEmbeddedApp: true,

    // Public apps created on or after 1 April 2026 must use expiring offline
    // access tokens; every public app must by 1 January 2027, after which
    // non-expiring tokens return authentication errors. Meridian is new, so
    // the first date applies and this is a submission requirement, not a
    // migration to schedule.
    //
    // This one flag does two things: token exchange sends `expiring: 1`
    // instead of `expiring: 0` (the library sends the parameter either way —
    // leaving the flag off actively requests a non-expiring token), and
    // `ensureValidOfflineSession` starts refreshing a session within five
    // minutes of expiry. It needs Session.refreshToken and
    // Session.refreshTokenExpires to exist, which they now do.
    future: {
      expiringOfflineAccessTokens: true,
    },

    /*
     * Two Billing API configurations per plan: the monthly one keyed by the
     * plan id, and the annual one keyed by `<id>-annual` (10x monthly — two
     * months free). Built from the catalogue rather than written out so a
     * price change in plans.ts cannot desync from what Shopify charges: these
     * three literals were exactly the kind of duplication that drifts.
     *
     * Both intervals carry the same trial. Shopify prorates a mid-cycle switch
     * between them and shows the merchant the amount before confirming.
     */
    billing: Object.fromEntries(
      Object.values(PLANS).flatMap((plan) => [
        [
          plan.id,
          {
            lineItems: [
              {
                amount: plan.price,
                currencyCode: "USD",
                interval: BillingInterval.Every30Days,
              },
              {
                amount: USAGE_CAP_AMOUNT,
                currencyCode: "USD",
                interval: BillingInterval.Usage,
                terms: USAGE_TERMS,
              },
            ],
            trialDays: TRIAL_DAYS,
          },
        ],
        [
          `${plan.id}${ANNUAL_SUFFIX}`,
          {
            lineItems: [
              {
                amount: plan.annualPrice,
                currencyCode: "USD",
                interval: BillingInterval.Annual,
              },
              {
                amount: USAGE_CAP_AMOUNT,
                currencyCode: "USD",
                interval: BillingInterval.Usage,
                terms: USAGE_TERMS,
              },
            ],
            trialDays: TRIAL_DAYS,
          },
        ],
      ]),
    ),

    webhooks: {
      APP_UNINSTALLED: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/app/uninstalled",
      },
      SHOP_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/shop/update",
      },
      ORDERS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/orders/create",
      },
      ORDERS_UPDATED: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/orders/create",
      },
      REFUNDS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/orders/create",
      },
      CHECKOUTS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/checkouts/create",
      },
      CHECKOUTS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/checkouts/create",
      },
      PRODUCTS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/products/update",
      },
      PRODUCTS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/products/update",
      },
      INVENTORY_ITEMS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/inventory-items/update",
      },
      FULFILLMENTS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/fulfillments/create",
      },
      FULFILLMENTS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/fulfillments/create",
      },
      APP_SUBSCRIPTIONS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/app-subscriptions/update",
      },
      APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/app-subscriptions/update",
      },
      APP_SCOPES_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/app/scopes-update",
      },
    },

    hooks: {
      afterAuth: async ({ session, admin }) => {
        // No registerWebhooks here. shopify.app.toml carries
        // [[webhooks.subscriptions]] and `include_config_on_deploy = true`, so
        // Shopify registers them app-wide at deploy. Registering again per shop
        // created a second, shop-specific subscription for the same topic from
        // a list that had drifted out of step with the toml — it was missing
        // products/create and fulfillments/update. Two subscriptions mean two
        // deliveries with different X-Shopify-Webhook-Id values, which the
        // idempotency check cannot suppress because it keys on that id.

        // Every install needs a Shop row and a starting set of cost rules,
        // otherwise the first dashboard load has nothing to reason about.
        const { ensureShopProvisioned, synchroniseShopifyShippingConnector } =
          await import("./lib/provision.server");
        const shop = await ensureShopProvisioned(session.shop);

        const hadAllOrders = parseScopes(shop.grantedScopes).has(
          "read_all_orders",
        );
        const hasAllOrders = parseScopes(session.scope).has("read_all_orders");
        const orderHistoryAccessChanged = hadAllOrders !== hasAllOrders;

        // Record what the store actually granted. The import gates its
        // GraphQL fields on this: asking for a field the app is not
        // authorised for fails the entire query, not just that field.
        const prismaClient = (await import("./db.server")).default;
        await prismaClient.shop.update({
          where: { id: shop.id },
          data: {
            grantedScopes: session.scope ?? null,
            // A completed 60-day import is not a completed lifetime import.
            // Likewise, a revoked lifetime scope must stop claiming full
            // history. Resetting the claim lets the backfill below rebuild
            // the merchant-facing boundary from the newly granted access.
            ...(orderHistoryAccessChanged
              ? {
                  syncStatus: "PENDING",
                  syncCompletedAt: null,
                  syncStage: "Order-history access changed",
                  hasAllOrdersScope: false,
                }
              : {}),
          },
        });
        await synchroniseShopifyShippingConnector(shop.id, session.scope);

        // Webhooks only describe what happens next, so without a historical
        // import the merchant's first view of Meridian is a wall of zeroes.
        // Started in the background: OAuth has to redirect into the app now,
        // and pulling a store's order history takes far longer than a redirect
        // can wait. Progress is polled from the Shop row.
        const { startBackfill, backfillIsStale } =
          await import("./lib/backfill.server");

        const alreadyImported =
          !orderHistoryAccessChanged &&
          (shop.syncStatus === "COMPLETE" || shop.syncStatus === "RUNNING");

        if (!alreadyImported || backfillIsStale(shop)) {
          // Wait only for the atomic claim, not the import. This keeps OAuth
          // fast while ensuring two callbacks cannot start overlapping walks.
          await startBackfill(shop.id, admin);
        }
      },
    },
  });
}

const shopify = hasShopifyCredentials
  ? buildShopify()
  : (null as unknown as ReturnType<typeof buildShopify>);

export default shopify;

export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = hasShopifyCredentials
  ? shopify.addDocumentResponseHeaders
  : () => {};
export const authenticate = hasShopifyCredentials ? shopify.authenticate : null;
export const unauthenticated = hasShopifyCredentials
  ? shopify.unauthenticated
  : null;
export const login = hasShopifyCredentials ? shopify.login : null;
export const sessionStorage = hasShopifyCredentials
  ? shopify.sessionStorage
  : null;
