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

export const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    price: 49,
    blurb: "Up to 1,000 orders / month",
    features: [
      "True profit per order",
      "Product margin analysis",
      "One ad channel connected",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    price: 149,
    blurb: "Up to 10,000 orders / month",
    features: [
      "Everything in Starter",
      "Unlimited ad channels + blended CAC",
      "Pricing recommendations",
      "Fulfilment capacity alerts",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    price: 399,
    blurb: "Unlimited orders",
    features: [
      "Everything in Growth",
      "Multi-location capacity modelling",
      "Cohort LTV and payback curves",
      "Priority support",
    ],
  },
} as const;

export type PlanId = keyof typeof PLANS;

const TRIAL_DAYS = 14;

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
    scopes: process.env.SCOPES?.split(",").map((s) => s.trim()),
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
    authPathPrefix: "/auth",
    sessionStorage: new PrismaSessionStorage(prisma),
    distribution: AppDistribution.AppStore,
    isEmbeddedApp: true,

    billing: {
      [PLANS.starter.id]: {
        lineItems: [
          {
            amount: PLANS.starter.price,
            currencyCode: "USD",
            interval: BillingInterval.Every30Days,
          },
        ],
        trialDays: TRIAL_DAYS,
      },
      [PLANS.growth.id]: {
        lineItems: [
          {
            amount: PLANS.growth.price,
            currencyCode: "USD",
            interval: BillingInterval.Every30Days,
          },
        ],
        trialDays: TRIAL_DAYS,
      },
      [PLANS.scale.id]: {
        lineItems: [
          {
            amount: PLANS.scale.price,
            currencyCode: "USD",
            interval: BillingInterval.Every30Days,
          },
        ],
        trialDays: TRIAL_DAYS,
      },
    },

    webhooks: {
      APP_UNINSTALLED: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/app/uninstalled",
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
      PRODUCTS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/products/update",
      },
      FULFILLMENTS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/fulfillments/create",
      },
      APP_SUBSCRIPTIONS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks/app-subscriptions/update",
      },
    },

    hooks: {
      afterAuth: async ({ session, admin }) => {
        await shopify.registerWebhooks({ session });

        // Every install needs a Shop row and a starting set of cost rules,
        // otherwise the first dashboard load has nothing to reason about.
        const { ensureShopProvisioned } = await import("./lib/provision.server");
        const shop = await ensureShopProvisioned(session.shop);

        // Record what the store actually granted. The import gates its
        // GraphQL fields on this: asking for a field the app is not
        // authorised for fails the entire query, not just that field.
        const prismaClient = (await import("./db.server")).default;
        await prismaClient.shop.update({
          where: { id: shop.id },
          data: { grantedScopes: session.scope ?? null },
        });

        // Webhooks only describe what happens next, so without a historical
        // import the merchant's first view of Meridian is a wall of zeroes.
        // Started in the background: OAuth has to redirect into the app now,
        // and pulling a store's order history takes far longer than a redirect
        // can wait. Progress is polled from the Shop row.
        const { startBackfill, backfillIsStale } = await import(
          "./lib/backfill.server"
        );

        const alreadyImported =
          shop.syncStatus === "COMPLETE" || shop.syncStatus === "RUNNING";

        if (!alreadyImported || backfillIsStale(shop)) {
          startBackfill(shop.id, admin);
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
