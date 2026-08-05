import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  // Shop-domain entry form. Must precede the splat so it wins the match.
  route("auth/login", "routes/auth.login.tsx"),
  // Shopify OAuth entry and callback.
  route("auth/*", "routes/auth.splat.tsx"),

  route("app", "routes/app.layout.tsx", [
    index("routes/app.overview.tsx"),
    route("orders", "routes/app.orders.tsx"),
    route("products", "routes/app.products.tsx"),
    route("acquisition", "routes/app.acquisition.tsx"),
    route("pricing", "routes/app.pricing.tsx"),
    route("fulfilment", "routes/app.fulfilment.tsx"),
    route("settings", "routes/app.settings.tsx"),
  ]),

  // Shop webhooks.
  route("webhooks/app/uninstalled", "routes/webhooks.app-uninstalled.tsx"),
  route("webhooks/orders/create", "routes/webhooks.orders.tsx"),
  route("webhooks/products/update", "routes/webhooks.products.tsx"),
  route("webhooks/fulfillments/create", "routes/webhooks.fulfillments.tsx"),
  route("webhooks/app-subscriptions/update", "routes/webhooks.app-subscriptions.tsx"),

  // Mandatory GDPR compliance webhooks. Every public app must implement all
  // three or it fails Shopify's automated review.
  route("webhooks/gdpr/customers-data-request", "routes/webhooks.gdpr.data-request.tsx"),
  route("webhooks/gdpr/customers-redact", "routes/webhooks.gdpr.customers-redact.tsx"),
  route("webhooks/gdpr/shop-redact", "routes/webhooks.gdpr.shop-redact.tsx"),
] satisfies RouteConfig;
