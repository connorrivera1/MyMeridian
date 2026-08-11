import { ShippingCostSource } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  matchOrderReference,
  isShopifyShippingProtectedDataError,
  parseShipStationLabels,
  parseShipStationShipmentReferences,
  parseShopifyShippingRows,
  selectCarrierTotal,
} from "./shipping.server";

describe("shipping carrier reconciliation", () => {
  it("normalizes ShipStation label cost without retaining tracking or addresses", () => {
    const parsed = parseShipStationLabels({
      labels: [
        {
          label_id: "se-1",
          external_shipment_id: "#1001",
          shipment_cost: { amount: "8.37", currency: "usd" },
          carrier_code: "ups",
          service_code: "ups_ground",
          tracking_number: "secret-tracking",
          ship_to: { name: "Private", address_line1: "Private" },
          created_at: "2026-08-10T12:00:00Z",
        },
      ],
    });
    expect(parsed).toEqual([
      expect.objectContaining({
        externalId: "se-1",
        externalOrderRef: "#1001",
        amount: "8.37",
        currency: "USD",
      }),
    ]);
    expect(JSON.stringify(parsed)).not.toContain("secret-tracking");
    expect(JSON.stringify(parsed)).not.toContain("Private");
  });

  it("marks refunded labels as voided", () => {
    expect(
      parseShipStationLabels({
        labels: [
          {
            label_id: "se-2",
            shipment_cost: { amount: 10, currency: "USD" },
            refund_status: "approved",
          },
        ],
      })[0]!.voided,
    ).toBe(true);
  });

  it("joins the documented label shipment_id to a shipment order reference", () => {
    const references = parseShipStationShipmentReferences({
      shipments: [
        {
          shipment_id: "se-shipment-1",
          external_shipment_id: "#1001",
          ship_to: { name: "must not survive parsing" },
        },
      ],
    });
    const parsed = parseShipStationLabels(
      {
        labels: [
          {
            label_id: "se-label-1",
            shipment_id: "se-shipment-1",
            shipment_cost: { amount: "11.20", currency: "USD" },
            voided: true,
            voided_at: "2026-08-11T12:30:00Z",
          },
        ],
      },
      new Date("2026-08-11T13:00:00Z"),
      references,
    );

    expect(parsed[0]).toMatchObject({
      externalOrderRef: "#1001",
      voided: true,
      sourceUpdatedAt: new Date("2026-08-11T12:30:00Z"),
    });
    expect(JSON.stringify(parsed)).not.toContain("must not survive parsing");
  });

  it("turns ShopifyQL aggregates into stable order/day observations", () => {
    const parsed = parseShopifyShippingRows(
      {
        data: {
          shopifyqlQuery: {
            parseErrors: [],
            tableData: {
              rows: [
                {
                  order_id: "gid://shopify/Order/123",
                  day: "2026-08-10",
                  shipping_carrier: "UPS",
                  shipping_service: "Ground",
                  shipping_label_currency: "USD",
                  shipping_label_costs: "12.45",
                  shipping_labels: 2,
                },
              ],
            },
          },
        },
      },
      "USD",
    );
    expect(parsed[0]).toMatchObject({
      source: ShippingCostSource.SHOPIFY_SHIPPING,
      externalOrderRef: "gid://shopify/Order/123",
      amount: "12.45",
      currency: "USD",
      labelCount: 2,
    });
  });

  it("surfaces ShopifyQL parse errors", () => {
    expect(() =>
      parseShopifyShippingRows({
        data: {
          shopifyqlQuery: {
            parseErrors: ["read_reports missing"],
          },
        },
      }),
    ).toThrow(/read_reports missing/);
  });

  it("recognizes Shopify's protected-data approval failure without treating ordinary outages as permanent", () => {
    expect(
      isShopifyShippingProtectedDataError(
        new Error(
          "Access denied: request access to Level 2 protected customer data in the Partner Dashboard requirements.",
        ),
      ),
    ).toBe(true);
    expect(
      isShopifyShippingProtectedDataError(
        new Error("Shopify Admin API returned HTTP 503"),
      ),
    ).toBe(false);
  });

  it("matches GIDs and merchant-facing order numbers", () => {
    const orders = [
      {
        id: "o1",
        shopifyId: "gid://shopify/Order/123",
        orderNumber: 1001,
        currency: "USD",
      },
    ];
    expect(matchOrderReference("gid://shopify/Order/123", orders)?.id).toBe(
      "o1",
    );
    expect(matchOrderReference("123", orders)?.id).toBe("o1");
    expect(matchOrderReference("#1001", orders)?.id).toBe("o1");
    expect(matchOrderReference("#9999", orders)).toBeNull();
  });

  it("deduplicates equal cross-source totals and exposes real conflicts", () => {
    const at = new Date("2026-08-10T00:00:00Z");
    expect(
      selectCarrierTotal([
        {
          source: ShippingCostSource.SHIPSTATION,
          amount: "10.00",
          labelCount: 1,
          observedAt: at,
        },
        {
          source: ShippingCostSource.SHOPIFY_SHIPPING,
          amount: "10.00",
          labelCount: 1,
          observedAt: at,
        },
      ]),
    ).toEqual({
      selected: ShippingCostSource.SHIPSTATION,
      cents: 1000,
      conflict: false,
    });

    expect(
      selectCarrierTotal([
        {
          source: ShippingCostSource.SHIPSTATION,
          amount: "10.00",
          labelCount: 1,
          observedAt: at,
        },
        {
          source: ShippingCostSource.SHOPIFY_SHIPPING,
          amount: "22.00",
          labelCount: 2,
          observedAt: at,
        },
      ]),
    ).toEqual({
      selected: ShippingCostSource.SHOPIFY_SHIPPING,
      cents: 2200,
      conflict: true,
    });
  });
});
