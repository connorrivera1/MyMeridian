import { describe, expect, it } from "vitest";

import {
  minimizeWebhookPayload,
  payloadReferencesCustomer,
  scrubCustomerFromWebhookPayload,
} from "./webhook-payload.server";

describe("durable webhook payload minimization", () => {
  it("keeps a checkout token and economic line projection without customer data", () => {
    expect(
      minimizeWebhookPayload("checkouts/update", {
        token: "checkout-token",
        cart_token: "cart-token",
        email: "buyer@example.com",
        phone: "+1-555-0100",
        currency: "USD",
        total_price: "42.00",
        created_at: "2026-08-11T10:00:00Z",
        updated_at: "2026-08-11T10:01:00Z",
        line_items: [
          { variant_id: 7, quantity: 2, price: "21.00", properties: [{ value: "secret" }] },
        ],
      }),
    ).toEqual({
      token: "checkout-token",
      cart_token: "cart-token",
      currency: "USD",
      total_price: "42.00",
      created_at: "2026-08-11T10:00:00Z",
      updated_at: "2026-08-11T10:01:00Z",
      line_items: [{ variant_id: 7, quantity: 2, price: "21.00" }],
    });
  });

  it("acknowledges capped-amount warnings without retaining a billing payload", () => {
    expect(
      minimizeWebhookPayload("app_subscriptions/approaching_capped_amount", {
        app_subscription: { id: "private-billing-detail" },
      }),
    ).toEqual({});
  });

  it("keeps only the order fields the profit importer consumes", () => {
    const minimized = minimizeWebhookPayload("orders/create", {
      id: 101,
      name: "#1001",
      email: "root@example.com",
      phone: "+1-555-0100",
      browser_ip: "203.0.113.1",
      billing_address: { first_name: "Private", address1: "1 Hidden St" },
      shipping_address: { first_name: "Private", address1: "1 Hidden St" },
      customer: {
        id: 202,
        email: "buyer@example.com",
        first_name: "Private",
        last_name: "Person",
        phone: "+1-555-0100",
        addresses: [{ address1: "1 Hidden St" }],
        tags: "vip",
      },
      order_number: 1001,
      processed_at: "2026-08-10T10:00:00Z",
      created_at: "2026-08-10T09:59:00Z",
      updated_at: "2026-08-10T10:01:00Z",
      currency: "USD",
      subtotal_price: "100.00",
      total_discounts: "5.00",
      total_tax: "8.00",
      total_price: "113.00",
      financial_status: "paid",
      fulfillment_status: "fulfilled",
      landing_site: "/products/alpine?utm_source=google",
      referring_site: "https://google.example/search",
      total_shipping_price_set: {
        shop_money: { amount: "10.00", currency_code: "USD" },
        presentment_money: { amount: "10.00", currency_code: "USD" },
      },
      shipping_lines: [
        { price: "10.00", title: "Home address delivery", phone: "secret" },
      ],
      line_items: [
        {
          id: 303,
          variant_id: 404,
          product_id: 505,
          title: "Alpine Shell",
          name: "Alpine Shell / Navy",
          sku: "ALP-NVY",
          quantity: 1,
          price: "100.00",
          discount_allocations: [
            { amount: "5.00", discount_application_index: 0 },
          ],
          properties: [{ name: "Gift note", value: "Private message" }],
          tax_lines: [{ title: "Tax", price: "8.00" }],
        },
      ],
      refunds: [
        {
          transactions: [
            {
              status: "success",
              kind: "refund",
              amount: "20.00",
              gateway: "private-gateway-metadata",
            },
          ],
          refund_line_items: [
            { line_item_id: 303, quantity: 1, subtotal: "100.00" },
          ],
          note: "Private support note",
        },
      ],
    });

    expect(minimized).toEqual({
      id: 101,
      order_number: 1001,
      processed_at: "2026-08-10T10:00:00Z",
      created_at: "2026-08-10T09:59:00Z",
      updated_at: "2026-08-10T10:01:00Z",
      currency: "USD",
      subtotal_price: "100.00",
      total_discounts: "5.00",
      total_tax: "8.00",
      total_price: "113.00",
      financial_status: "paid",
      fulfillment_status: "fulfilled",
      landing_site: "/products/alpine?utm_source=google",
      referring_site: "https://google.example/search",
      customer: { id: 202, email: "buyer@example.com" },
      total_shipping_price_set: { shop_money: { amount: "10.00" } },
      shipping_lines: [{ price: "10.00", title: "Home address delivery" }],
      line_items: [
        {
          id: 303,
          variant_id: 404,
          product_id: 505,
          title: "Alpine Shell",
          name: "Alpine Shell / Navy",
          sku: "ALP-NVY",
          quantity: 1,
          price: "100.00",
          discount_allocations: [{ amount: "5.00" }],
          tax_lines: [{ title: "Tax", price: "8.00" }],
        },
      ],
      refunds: [
        {
          transactions: [
            { status: "success", kind: "refund", amount: "20.00" },
          ],
          refund_line_items: [{ line_item_id: 303, quantity: 1 }],
        },
      ],
    });

    const stored = JSON.stringify(minimized);
    for (const forbidden of [
      "Private",
      "Hidden St",
      "203.0.113.1",
      "+1-555",
      "Gift note",
      "support note",
      "gateway",
    ]) {
      expect(stored).not.toContain(forbidden);
    }
  });

  it.each(["products/create", "PRODUCTS_UPDATE"])(
    "%s keeps only catalog synchronization fields",
    (topic) => {
      expect(
        minimizeWebhookPayload(topic, {
          id: 1,
          title: "Alpine Shell",
          handle: "alpine-shell",
          product_type: "Outerwear",
          vendor: "Northwind",
          status: "active",
          updated_at: "2026-08-10T10:00:00Z",
          body_html: "tracking copy",
          image: { src: "https://cdn.example/image.jpg", alt: "unused" },
          variants: [
            {
              id: 2,
              sku: "ALP",
              title: "Navy",
              price: "100.00",
              compare_at_price: "120.00",
              inventory_quantity: 4,
              grams: 500,
              updated_at: "2026-08-10T09:59:00Z",
              barcode: "unused",
            },
          ],
          variant_gids: [
            {
              admin_graphql_api_id: "gid://shopify/ProductVariant/2",
              unused: true,
            },
            { admin_graphql_api_id: "gid://shopify/ProductVariant/3" },
          ],
        }),
      ).toEqual({
        id: 1,
        title: "Alpine Shell",
        handle: "alpine-shell",
        product_type: "Outerwear",
        vendor: "Northwind",
        status: "active",
        updated_at: "2026-08-10T10:00:00Z",
        image: { src: "https://cdn.example/image.jpg" },
        variants: [
          {
            id: 2,
            sku: "ALP",
            title: "Navy",
            price: "100.00",
            compare_at_price: "120.00",
            inventory_quantity: 4,
            grams: 500,
            updated_at: "2026-08-10T09:59:00Z",
          },
        ],
        variant_gids: [
          { admin_graphql_api_id: "gid://shopify/ProductVariant/2" },
          { admin_graphql_api_id: "gid://shopify/ProductVariant/3" },
        ],
      });
    },
  );

  it.each(["fulfillments/create", "FULFILLMENTS_UPDATE"])(
    "%s excludes tracking numbers and destination data",
    (topic) => {
      expect(
        minimizeWebhookPayload(topic, {
          id: 1,
          order_id: 2,
          created_at: "2026-08-10T10:00:00Z",
          updated_at: "2026-08-10T10:05:00Z",
          status: "success",
          tracking_company: "UPS",
          tracking_number: "1Z-PRIVATE",
          tracking_url: "https://tracking.example/private",
          service: "ground",
          location_id: 3,
          destination: { address1: "1 Hidden St" },
          line_items: [{ quantity: 2, title: "unused", customer: "private" }],
        }),
      ).toEqual({
        id: 1,
        order_id: 2,
        created_at: "2026-08-10T10:00:00Z",
        updated_at: "2026-08-10T10:05:00Z",
        status: "success",
        tracking_company: "UPS",
        service: "ground",
        location_id: 3,
        line_items: [{ quantity: 2 }],
      });
    },
  );

  it("projects billing and scope events", () => {
    expect(
      minimizeWebhookPayload("app_subscriptions/update", {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/1",
          name: "Growth",
          status: "ACTIVE",
          trial_ends_on: null,
          billing_on: "2026-09-10",
          return_url: "https://unused.example",
        },
        merchant_email: "must-not-persist@example.com",
      }),
    ).toEqual({
      app_subscription: {
        admin_graphql_api_id: "gid://shopify/AppSubscription/1",
        name: "Growth",
        status: "ACTIVE",
        trial_ends_on: null,
        billing_on: "2026-09-10",
      },
    });
    expect(
      minimizeWebhookPayload("app/scopes_update", {
        current: ["read_orders", 42, "read_products"],
        previous: ["write_products"],
      }),
    ).toEqual({ current: ["read_orders", "read_products"] });
  });

  it("retains only the inventory-item identity, source time and cost", () => {
    expect(
      minimizeWebhookPayload("inventory_items/update", {
        id: 91,
        cost: "37.50",
        updated_at: "2026-08-10T10:05:00Z",
        sku: "must-be-refetched",
        country_code_of_origin: "US",
      }),
    ).toEqual({
      id: 91,
      cost: "37.50",
      updated_at: "2026-08-10T10:05:00Z",
    });
  });

  it.each(["refunds/create", "app/uninstalled", "shop/update", "shop/redact"])(
    "%s retains no wire fields",
    (topic) => {
      expect(
        minimizeWebhookPayload(topic, {
          id: 1,
          email: "must-not-persist@example.com",
          address: { line1: "Hidden" },
        }),
      ).toEqual({});
    },
  );

  it.each(["customers/data_request", "CUSTOMERS_REDACT"])(
    "%s retains only the customer reference needed for compliance",
    (topic) => {
      expect(
        minimizeWebhookPayload(topic, {
          shop_id: 1,
          shop_domain: "store.myshopify.com",
          customer: {
            id: 202,
            email: "buyer@example.com",
            phone: "+1-555-0100",
            first_name: "Private",
          },
          orders_requested: [1, 2],
        }),
      ).toEqual({ customer: { id: 202, email: "buyer@example.com" } });
    },
  );

  it("fails closed for an unreviewed topic", () => {
    expect(() =>
      minimizeWebhookPayload("customers/update", {
        customer: { email: "private@example.com" },
      }),
    ).toThrow(/no minimized webhook payload contract/i);
  });
});

describe("pending customer payload scrubbing", () => {
  const order = {
    id: 101,
    customer: { id: 202, email: "buyer@example.com" },
    total_price: "100.00",
    landing_site: "/products/alpine?utm_campaign=vip&email=buyer%40example.com",
    referring_site: "https://personal.example/customer/202",
  };

  it("matches raw/gid ids and normalized email", () => {
    expect(
      payloadReferencesCustomer(order, {
        id: "gid://shopify/Customer/202",
      }),
    ).toBe(true);
    expect(
      payloadReferencesCustomer(order, { email: " BUYER@example.com " }),
    ).toBe(true);
  });

  it("treats different stable ids as different customers even when email matches", () => {
    expect(
      payloadReferencesCustomer(order, {
        id: "gid://shopify/Customer/999",
        email: "buyer@example.com",
      }),
    ).toBe(false);
    expect(
      payloadReferencesCustomer(
        { id: 101, customer: { email: "buyer@example.com" } },
        { id: 999, email: "BUYER@example.com" },
      ),
    ).toBe(false);
    expect(
      payloadReferencesCustomer(
        { id: 101, customer: { email: "buyer@example.com" } },
        { email: "BUYER@example.com" },
      ),
    ).toBe(true);
  });

  it("removes identity while preserving an order's economics", () => {
    expect(
      scrubCustomerFromWebhookPayload("ORDERS_UPDATED", order, { id: 202 }),
    ).toEqual({ id: 101, total_price: "100.00" });
  });

  it("uses the stable id when a different customer shares the email", () => {
    expect(
      scrubCustomerFromWebhookPayload("ORDERS_UPDATED", order, {
        id: 999,
        email: "buyer@example.com",
      }),
    ).toBe(order);
  });

  it("does not touch another customer's delivery", () => {
    expect(
      scrubCustomerFromWebhookPayload("ORDERS_UPDATED", order, { id: 999 }),
    ).toBe(order);
  });
});
