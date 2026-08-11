import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  // The marketing page, served by the app so the whole product is one origin.
  // A resource route: it returns the hand-written HTML document rather than
  // rendering a component. See routes/home.ts.
  index("routes/home.ts"),

  // Public, unauthenticated documents. Shopify's listing links to the privacy
  // policy and the reviewer opens both without a session, so neither may ever
  // be moved behind authentication.
  route("privacy", "routes/legal.privacy.tsx"),
  route("support", "routes/legal.support.tsx"),
  route("healthz", "routes/health.live.ts"),
  route("readyz", "routes/health.ready.ts"),

  // Shop-domain entry form. Must precede the splat so it wins the match.
  route("auth/login", "routes/auth.login.tsx"),
  // Shopify OAuth entry and callback.
  route("auth/*", "routes/auth.splat.tsx"),

  /*
   * Web accounts.
   *
   * Deliberately outside `auth/`, which is Shopify's namespace here: the splat
   * above would swallow anything added under it, and a merchant-facing sign-in
   * silently becoming a Shopify OAuth attempt is a hard failure to read.
   */
  route("login", "routes/login.tsx"),
  route("signup", "routes/signup.tsx"),
  route("logout", "routes/logout.tsx"),
  // Email entry, code entry and the confirmation are one path in three phases,
  // so the code goes in on the screen that announced it.
  route("forgot", "routes/forgot.tsx"),
  // Claims the one-time post-signup splash, then forwards.
  route("welcome", "routes/welcome.tsx"),
  // Where an account with no store connected is sent.
  route("connect", "routes/connect.tsx"),
  route("oauth/:provider", "routes/oauth.$provider.tsx"),
  route("oauth/:provider/callback", "routes/oauth.$provider.callback.tsx"),

  // Third-party data-source OAuth callbacks authenticate with one-use state;
  // they cannot require a Shopify iframe session because providers return in a
  // top-level browser context.
  route("connections/:provider/callback", "routes/connector-callback.ts"),

  route("app", "routes/app.layout.tsx", [
    index("routes/app.overview.tsx"),
    route("onboarding", "routes/app.onboarding.tsx"),
    route("orders", "routes/app.orders.tsx"),
    route("products", "routes/app.products.tsx"),
    route("acquisition", "routes/app.acquisition.tsx"),
    route("pricing", "routes/app.pricing.tsx"),
    route("fulfilment", "routes/app.fulfilment.tsx"),
    route("costs", "routes/app.costs.tsx"),
    route("settings", "routes/app.settings.tsx"),
    route("connections/:provider/start", "routes/app.connector-start.ts"),
    route("export/profit.csv", "routes/app.profit-export.ts"),
    // A merchant's privacy obligations survive subscription cancellation, so
    // authenticated export handoff remains reachable without an active plan.
    route("privacy-requests", "routes/app.privacy-requests.tsx"),
    route(
      "privacy-requests/:id/download",
      "routes/app.privacy-request-download.ts",
    ),
    // Plan selection, upgrade and downgrade is also entitlement-exempt.
    route("plan", "routes/app.plan.tsx"),
  ]),

  // Shop webhooks.
  route("webhooks/app/uninstalled", "routes/webhooks.app-uninstalled.tsx"),
  route("webhooks/shop/update", "routes/webhooks.shop-update.tsx"),
  route("webhooks/orders/create", "routes/webhooks.orders.tsx"),
  route("webhooks/checkouts/create", "routes/webhooks.checkouts.tsx"),
  route("webhooks/products/update", "routes/webhooks.products.tsx"),
  route(
    "webhooks/inventory-items/update",
    "routes/webhooks.inventory-items.tsx",
  ),
  route("webhooks/fulfillments/create", "routes/webhooks.fulfillments.tsx"),
  route(
    "webhooks/shipstation/:connectorId",
    "routes/webhooks.shipstation.tsx",
  ),
  route(
    "webhooks/app-subscriptions/update",
    "routes/webhooks.app-subscriptions.tsx",
  ),
  route("webhooks/app/scopes-update", "routes/webhooks.app-scopes-update.tsx"),

  // Mandatory GDPR compliance webhooks. Every public app must implement all
  // three or it fails Shopify's automated review.
  route(
    "webhooks/gdpr/customers-data-request",
    "routes/webhooks.gdpr.data-request.tsx",
  ),
  route(
    "webhooks/gdpr/customers-redact",
    "routes/webhooks.gdpr.customers-redact.tsx",
  ),
  route("webhooks/gdpr/shop-redact", "routes/webhooks.gdpr.shop-redact.tsx"),
] satisfies RouteConfig;
