import { describe, expect, it } from "vitest";

import {
  ALL_CAPABILITIES,
  capabilitiesForShop,
  capabilitiesFrom,
  parseScopes,
  scopeReport,
} from "./scopes";

describe("parseScopes", () => {
  it("accepts both separators Shopify uses", () => {
    // Session scope strings come back comma-separated; shopify.app.toml uses
    // spaces. Both reach this function.
    expect([...parseScopes("read_orders,read_products")]).toEqual([
      "read_orders",
      "read_products",
    ]);
    expect([...parseScopes("read_orders read_products")]).toEqual([
      "read_orders",
      "read_products",
    ]);
    expect([...parseScopes("read_orders, read_products")]).toEqual([
      "read_orders",
      "read_products",
    ]);
  });

  it("treats absent scopes as an empty set rather than throwing", () => {
    expect(parseScopes(null).size).toBe(0);
    expect(parseScopes(undefined).size).toBe(0);
    expect(parseScopes("").size).toBe(0);
  });
});

describe("capabilitiesFrom", () => {
  it("maps the reduced dev scope set correctly", () => {
    const capabilities = capabilitiesFrom(
      "read_orders read_products read_fulfillments read_refunds",
    );

    expect(capabilities.orders).toBe(true);
    expect(capabilities.products).toBe(true);
    expect(capabilities.fulfillments).toBe(true);
    // The two that change what the dashboard can honestly claim.
    expect(capabilities.customers).toBe(false);
    expect(capabilities.inventoryCost).toBe(false);
  });

  it("treats a write scope as implying its read", () => {
    expect(capabilitiesFrom("write_products").products).toBe(true);
    expect(capabilitiesFrom("write_customers").customers).toBe(true);
  });

  it("accepts read_all_orders in place of read_orders", () => {
    expect(capabilitiesFrom("read_all_orders").orders).toBe(true);
  });

  it("grants nothing for an empty scope string", () => {
    const capabilities = capabilitiesFrom("");
    expect(Object.values(capabilities).every((v) => v === false)).toBe(true);
  });
});

describe("capabilitiesForShop", () => {
  it("gives the seeded demo everything — its data is complete by construction", () => {
    expect(
      capabilitiesForShop({ grantedScopes: null, isDemo: true }),
    ).toEqual(ALL_CAPABILITIES);
  });

  it("falls back to the app's configured scopes when none were recorded", () => {
    // A store installed before scopes were recorded must not be reported as
    // having granted nothing — that would splash false warnings over a
    // perfectly working install.
    const capabilities = capabilitiesForShop(
      { grantedScopes: null, isDemo: false },
      "read_orders,read_products,read_customers,read_inventory",
    );

    expect(capabilities.customers).toBe(true);
    expect(capabilities.inventoryCost).toBe(true);
  });

  it("prefers what the store actually granted over what the app asked for", () => {
    const capabilities = capabilitiesForShop(
      { grantedScopes: "read_orders", isDemo: false },
      "read_orders,read_customers,read_inventory",
    );

    expect(capabilities.orders).toBe(true);
    expect(capabilities.customers).toBe(false);
    expect(capabilities.inventoryCost).toBe(false);
  });
});

describe("scopeReport", () => {
  it("flags the two gaps in the reduced dev scope set", () => {
    const report = scopeReport(
      "read_orders read_products read_fulfillments read_refunds",
    );

    const missing = report.filter((entry) => !entry.granted).map((e) => e.scope);
    expect(missing).toEqual(["read_inventory", "read_customers"]);

    // Neither is essential — the app still tracks profit without them.
    expect(report.filter((e) => !e.granted && e.essential)).toHaveLength(0);
  });

  it("marks customer access as protected data so the UI can explain the extra step", () => {
    const customers = scopeReport("read_orders").find(
      (entry) => entry.scope === "read_customers",
    );

    expect(customers?.protectedData).toBe(true);
  });

  it("treats orders and products as essential", () => {
    const essential = scopeReport("")
      .filter((entry) => entry.essential)
      .map((entry) => entry.scope);

    expect(essential).toEqual(["read_orders", "read_products"]);
  });
});
