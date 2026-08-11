import { ConnectorProvider, ConnectorStatus, Prisma, PrismaClient } from "@prisma/client";

import { encryptSecret } from "~/lib/crypto.server";
import { recordShippingAdjustments } from "~/lib/shipping-adjustments.server";
import { syncOrderFromShopify } from "~/lib/sync.server";

/**
 * Seeds a NON-demo debug shop for exercising the ad-ingestion queues and the
 * reconciliation math live, against scripts/dev/fake-ads-platform.mjs:
 *
 *   npx tsx scripts/dev/seed-ads-debug.ts
 *
 * Produces: a Meta connector for the fake EUR account, a week of FACEBOOK
 * orders that ad attribution can land on, one multi-currency order with a
 * converted refund, one order with a retained restocking fee, one carrier
 * reweigh and one return label. Idempotent: re-running rebuilds the shop.
 */

const prisma = new PrismaClient();
const DOMAIN = "ads-debug.myshopify.com";

function isoDay(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function main() {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });

  const shop = await prisma.shop.create({
    data: {
      domain: DOMAIN,
      name: "Ads Debug Store",
      currency: "USD",
      timezone: "America/New_York",
      isDemo: false,
      syncStatus: "COMPLETE",
      onboardingStep: "done",
    },
  });

  await prisma.connector.create({
    data: {
      shopId: shop.id,
      provider: ConnectorProvider.FACEBOOK_ADS,
      status: ConnectorStatus.CONNECTED,
      externalAccountId: "act_777",
      accessTokenEnc: encryptSecret("debug-token"),
      // accountCurrency deliberately unset: first ingestion must pin EUR from
      // the platform profile.
    },
  });

  // Pinned FX so MERIDIAN_FX_DISABLED=true still converts: €1 = $1.10.
  for (let offset = -40; offset <= 0; offset += 1) {
    const day = new Date(`${isoDay(offset)}T00:00:00.000Z`);
    await prisma.exchangeRate.upsert({
      where: { day_base_quote: { day, base: "EUR", quote: "USD" } },
      create: {
        day,
        base: "EUR",
        quote: "USD",
        rate: new Prisma.Decimal("1.1000000000"),
        source: "debug-seed",
      },
      update: {},
    });
  }

  // Orders ad spend can attribute onto: one per campaign per day, last 7 days.
  let orderNumber = 1000;
  for (let offset = -6; offset <= 0; offset += 1) {
    for (const campaign of ["cmp-alpha", "cmp-beta"]) {
      orderNumber += 1;
      await syncOrderFromShopify(shop.id, {
        id: 900000 + orderNumber,
        order_number: orderNumber,
        processed_at: `${isoDay(offset)}T16:00:00Z`,
        created_at: `${isoDay(offset)}T16:00:00Z`,
        updated_at: `${isoDay(offset)}T16:05:00Z`,
        currency: "USD",
        subtotal_price: "100.00",
        total_discounts: "0.00",
        total_tax: "8.00",
        total_price: "108.00",
        financial_status: "paid",
        meridian_utm_source: "facebook",
        meridian_utm_medium: "paid",
        meridian_utm_campaign: campaign,
        line_items: [
          {
            id: 800000 + orderNumber,
            title: "Debug Widget",
            quantity: 1,
            price: "100.00",
          },
        ],
      });
    }
  }

  // A multi-currency order: presented in EUR, settled by Shopify at $1.13/€,
  // with a €50 refund that must land as $56.50.
  await syncOrderFromShopify(shop.id, {
    id: 910001,
    order_number: 2001,
    processed_at: `${isoDay(-3)}T12:00:00Z`,
    created_at: `${isoDay(-3)}T12:00:00Z`,
    updated_at: `${isoDay(-3)}T12:05:00Z`,
    currency: "USD",
    presentment_currency: "EUR",
    subtotal_price: "113.00",
    total_discounts: "0.00",
    total_tax: "0.00",
    total_price: "113.00",
    total_price_set: {
      shop_money: { amount: "113.00", currency_code: "USD" },
      presentment_money: { amount: "100.00", currency_code: "EUR" },
    },
    financial_status: "partially_refunded",
    line_items: [
      { id: 810001, title: "Exported Widget", quantity: 2, price: "56.50" },
    ],
    refunds: [
      {
        transactions: [
          { kind: "refund", status: "success", amount: "50.00", currency: "EUR" },
        ],
        refund_line_items: [
          {
            line_item_id: 810001,
            quantity: 1,
            subtotal_set: { shop_money: { amount: "56.50" } },
            total_tax_set: { shop_money: { amount: "0.00" } },
          },
        ],
      },
    ],
  });

  // A return with a retained restocking fee: $110 of goods+tax came back,
  // $90 was paid out — the merchant kept $20, ex-tax.
  await syncOrderFromShopify(shop.id, {
    id: 910002,
    order_number: 2002,
    processed_at: `${isoDay(-2)}T12:00:00Z`,
    created_at: `${isoDay(-2)}T12:00:00Z`,
    updated_at: `${isoDay(-2)}T12:05:00Z`,
    currency: "USD",
    subtotal_price: "100.00",
    total_discounts: "0.00",
    total_tax: "10.00",
    total_price: "110.00",
    financial_status: "partially_refunded",
    line_items: [
      { id: 810002, title: "Returned Widget", quantity: 1, price: "100.00" },
    ],
    refunds: [
      {
        transactions: [
          { kind: "refund", status: "success", amount: "90.00" },
        ],
        refund_line_items: [
          {
            line_item_id: 810002,
            quantity: 1,
            subtotal_set: { shop_money: { amount: "100.00" } },
            total_tax_set: { shop_money: { amount: "10.00" } },
          },
        ],
      },
    ],
  });

  // Label economics: a carrier reweigh on 2001, a return label on 2002.
  const adjustments = await recordShippingAdjustments(shop.id, "USD", [
    {
      reference: "debug-invoice-1-line-1",
      kind: "CARRIER_ADJUSTMENT",
      source: "CARRIER_INVOICE",
      amount: "4.20",
      orderReference: "2001",
      reason: "reweigh 2.1kg → 3.4kg",
      occurredAt: new Date(`${isoDay(-1)}T00:00:00.000Z`),
    },
    {
      reference: "debug-invoice-1-line-2",
      kind: "RETURN_LABEL",
      source: "CARRIER_INVOICE",
      amount: "7.25",
      orderReference: "2002",
      reason: "prepaid return label",
      occurredAt: new Date(`${isoDay(-1)}T00:00:00.000Z`),
    },
  ]);

  const orders = await prisma.order.count({ where: { shopId: shop.id } });
  console.log(`seed-ads-debug: shop ${DOMAIN}`);
  console.log(`  orders: ${orders} (incl. multi-currency #2001, return-fee #2002)`);
  console.log(
    `  adjustments: ${adjustments.written} written, ${adjustments.duplicates} duplicates, ${adjustments.unmatched.length} unmatched`,
  );
  console.log("  connector: FACEBOOK_ADS → act_777 (currency pinned on first sync)");
}

main().finally(() => prisma.$disconnect());
