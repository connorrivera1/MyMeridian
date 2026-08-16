import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readShopifyBridgeSession,
  serializeShopifyBridgeSession,
} from "./shopify-bridge-session.server";

const previousKey = process.env.MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY;

beforeEach(() => {
  process.env.MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY = "k".repeat(32);
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY;
  else process.env.MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY = previousKey;
});

describe("Shopify embedded navigation fallback", () => {
  it("creates a partitioned, HttpOnly, short-lived cookie after verified auth", () => {
    const request = new Request("https://staging.mymeridian.io/app", {
      headers: { "x-forwarded-proto": "https" },
    });

    const cookie = serializeShopifyBridgeSession(
      { shop: "northwind.myshopify.com", id: "online-session" },
      request,
    );

    expect(cookie).toContain("__Host-mymeridian_shopify_bridge=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
    expect(cookie).toContain("Max-Age=300");
  });

  it("accepts only an untampered, unexpired signed identity", () => {
    const source = new Request("https://staging.mymeridian.io/app", {
      headers: { "x-forwarded-proto": "https" },
    });
    const serialized = serializeShopifyBridgeSession(
      { shop: "northwind.myshopify.com", id: "online-session" },
      source,
    )!;
    const pair = serialized.split(";", 1)[0]!;
    const request = new Request("https://staging.mymeridian.io/app.data", {
      headers: { "x-forwarded-proto": "https", cookie: pair },
    });

    expect(readShopifyBridgeSession(request)).toMatchObject({
      shop: "northwind.myshopify.com",
      sessionId: "online-session",
    });

    const tampered = new Request("https://staging.mymeridian.io/app.data", {
      headers: {
        "x-forwarded-proto": "https",
        cookie: `${pair.slice(0, -1)}x`,
      },
    });
    expect(readShopifyBridgeSession(tampered)).toBeNull();
  });
});
