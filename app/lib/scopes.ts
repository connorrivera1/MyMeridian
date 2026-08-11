/**
 * What Meridian is actually allowed to read, and what each permission buys.
 *
 * Scopes are not all-or-nothing here. A store can grant order access without
 * customer access, and the difference decides whether half the product works or
 * quietly reports zeroes. Everything downstream branches on these flags rather
 * than assuming a field will be there.
 *
 * Plain module, not `.server` — the settings screen renders these labels.
 */

export interface Capabilities {
  /** Orders, line items, refunds. Without this there is no product at all. */
  orders: boolean;
  /** Product catalogue and prices. */
  products: boolean;
  /**
   * Customer identity on orders. Protected customer data — needs an approved
   * request in the Partner Dashboard, not just the scope.
   */
  customers: boolean;
  /** InventoryItem.unitCost — the real COGS behind every margin. */
  inventoryCost: boolean;
  /** Fulfilment records, for capacity and real shipping cost. */
  fulfillments: boolean;
  /** ShopifyQL reports, including Shopify Shipping label costs. */
  reports: boolean;
}

/** Session scope strings arrive comma-separated; the TOML uses spaces. */
export function parseScopes(scope: string | null | undefined): Set<string> {
  if (!scope) return new Set();
  return new Set(
    scope
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function capabilitiesFrom(
  scope: string | null | undefined,
): Capabilities {
  const granted = parseScopes(scope);
  const has = (name: string) =>
    granted.has(name) || granted.has(name.replace("read_", "write_"));

  return {
    orders: has("read_orders") || has("read_all_orders"),
    products: has("read_products"),
    customers: has("read_customers"),
    inventoryCost: has("read_inventory"),
    fulfillments: has("read_fulfillments"),
    reports: has("read_reports"),
  };
}

export const ALL_CAPABILITIES: Capabilities = {
  orders: true,
  products: true,
  customers: true,
  inventoryCost: true,
  fulfillments: true,
  reports: true,
};

/**
 * Capabilities for a shop, tolerating the cases where we do not know.
 *
 * The seeded demo has every field present by construction. A store installed
 * before scopes were recorded reports nothing, so the app's own configured
 * scopes are used as the fallback — treating "unknown" as "nothing granted"
 * would splash false warnings across a perfectly working install.
 */
export function capabilitiesForShop(
  shop: { grantedScopes: string | null; isDemo: boolean },
  configuredScopes?: string | null,
): Capabilities {
  if (shop.isDemo) return ALL_CAPABILITIES;
  return capabilitiesFrom(shop.grantedScopes ?? configuredScopes);
}

export interface ScopeImpact {
  scope: string;
  label: string;
  /** What stops working without it. */
  unlocks: string;
  /** Requires a Protected Customer Data request, not just the scope. */
  protectedData: boolean;
  /** Meridian is unusable without it. */
  essential: boolean;
}

export const SCOPE_IMPACTS: ScopeImpact[] = [
  {
    scope: "read_orders",
    label: "Orders",
    unlocks: "Everything. Revenue, order profit, product and channel analysis.",
    protectedData: true,
    essential: true,
  },
  {
    scope: "read_products",
    label: "Products",
    unlocks: "The catalogue, prices and price history behind pricing analysis.",
    protectedData: false,
    essential: true,
  },
  {
    scope: "read_inventory",
    label: "Inventory cost",
    unlocks:
      "Cost per item, which is the COGS in every margin. Without it gross margin reads as 100% and every profit figure is overstated.",
    protectedData: false,
    essential: false,
  },
  {
    scope: "read_customers",
    label: "Customers",
    unlocks:
      "Customer identity on orders. Without it there is no CAC, lifetime value, payback period, or customer-lifecycle product classification.",
    protectedData: true,
    essential: false,
  },
  {
    scope: "read_fulfillments",
    label: "Fulfilments",
    unlocks: "Shipping records behind capacity forecasting and backlog alerts.",
    protectedData: false,
    essential: false,
  },
  {
    scope: "read_reports",
    label: "Shopify reports",
    unlocks:
      "Shopify Shipping label costs by order, carrier and service for measured fulfilment profit.",
    protectedData: true,
    essential: false,
  },
];

/** Scopes granted, missing, and what the gaps cost. */
export function scopeReport(
  scope: string | null | undefined,
  requestedScopes?: string | null,
) {
  const granted = parseScopes(scope);
  const requested =
    requestedScopes === undefined ? null : parseScopes(requestedScopes);
  const has = (name: string) =>
    granted.has(name) || granted.has(name.replace("read_", "write_"));

  return SCOPE_IMPACTS.filter(
    (impact) =>
      requested === null ||
      requested.has(impact.scope) ||
      requested.has(impact.scope.replace("read_", "write_")),
  ).map((impact) => ({ ...impact, granted: has(impact.scope) }));
}
