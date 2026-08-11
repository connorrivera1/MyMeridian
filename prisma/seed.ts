import {
  Channel,
  ConnectorProvider,
  ConnectorStatus,
  CostRuleKind,
  CostRuleOrigin,
  CostSource,
  PrismaClient,
  SyncStatus,
} from "@prisma/client";

import { recomputeShopProfitability } from "../app/lib/recompute.server";
import { generatePricingRecommendations } from "../app/lib/pricing.server";

/**
 * Seeds a demo store whose economics are internally consistent.
 *
 * The point is not to make the dashboard look busy. Demand actually responds to
 * price using each product's declared elasticity, loss leaders actually drive
 * the repeat purchases that make them strategic, and the warehouse actually
 * falls behind when demand outgrows it. Every insight the app surfaces is
 * therefore something the engine genuinely found, not something written into
 * the fixture.
 */

const prisma = new PrismaClient();

const DEMO_SHOP_DOMAIN = "meridian-demo.myshopify.com";
const PERIOD_START = new Date("2026-02-01T00:00:00Z");
const PERIOD_END = new Date("2026-08-03T00:00:00Z");
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Deterministic randomness — same database on every run.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x4d455249); // "MERI"

const between = (min: number, max: number) => min + rand() * (max - min);
const intBetween = (min: number, max: number) =>
  Math.floor(between(min, max + 1));
const jitter = (value: number, pct: number) => value * (1 + between(-pct, pct));

function pickWeighted<T>(items: readonly { item: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let roll = rand() * total;
  for (const entry of items) {
    roll -= entry.weight;
    if (roll <= 0) return entry.item;
  }
  return items[items.length - 1]!.item;
}

const money = (cents: number) => (cents / 100).toFixed(2);
const cost = (cents: number) => (cents / 100).toFixed(4);

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface SeedProduct {
  key: string;
  title: string;
  type: string;
  priceCents: number;
  costCents: number;
  /** True price elasticity. Demand below is generated from this. */
  elasticity: number;
  /** Relative purchase weight at the base price. */
  popularity: number;
  /** Only ever appears in a customer's first order. */
  acquisitionOffer?: boolean;
  /** Multiplier on the buyer's chance of ordering again. */
  repeatLift?: number;
  priceChanges?: { onIso: string; priceCents: number }[];
}

const CATALOGUE: SeedProduct[] = [
  {
    key: "alpine-shell",
    title: "Alpine Shell Jacket",
    type: "Outerwear",
    priceCents: 28_900,
    costCents: 9_600,
    elasticity: -1.4,
    popularity: 10,
    repeatLift: 1.2,
  },
  {
    key: "trail-runner",
    title: "Trail Runner GTX",
    type: "Footwear",
    priceCents: 16_500,
    costCents: 6_200,
    elasticity: -1.8,
    popularity: 14,
    repeatLift: 1.3,
  },
  {
    key: "merino-base",
    title: "Merino Base Layer",
    type: "Layers",
    priceCents: 8_900,
    costCents: 2_800,
    elasticity: -2.1,
    popularity: 18,
    repeatLift: 1.4,
    // Three genuine price points — enough for a high-confidence elasticity fit.
    priceChanges: [
      { onIso: "2026-04-15", priceCents: 7_900 },
      { onIso: "2026-06-15", priceCents: 8_400 },
    ],
  },
  {
    key: "summit-pack",
    title: "Summit Pack 32L",
    type: "Packs",
    priceCents: 18_900,
    costCents: 7_100,
    elasticity: -1.5,
    popularity: 9,
  },
  {
    key: "thermal-beanie",
    title: "Thermal Beanie",
    type: "Accessories",
    priceCents: 3_400,
    costCents: 900,
    elasticity: -2.4,
    popularity: 16,
    priceChanges: [{ onIso: "2026-05-01", priceCents: 2_900 }],
  },
  {
    key: "trekking-poles",
    title: "Carbon Trekking Poles",
    type: "Equipment",
    priceCents: 11_900,
    costCents: 5_200,
    elasticity: -1.9,
    popularity: 7,
  },
  {
    key: "down-bag",
    title: "Down Sleeping Bag −7°C",
    type: "Sleep",
    priceCents: 34_900,
    costCents: 15_500,
    elasticity: -1.3,
    popularity: 5,
  },
  {
    key: "camp-stove",
    title: "Ultralight Camp Stove",
    type: "Equipment",
    priceCents: 7_900,
    costCents: 3_800,
    elasticity: -1.7,
    popularity: 8,
  },
  {
    key: "starter-kit",
    title: "Trailhead Starter Kit",
    type: "Bundles",
    priceCents: 1_900,
    costCents: 2_400, // sold below cost on purpose
    elasticity: -2.8,
    popularity: 11,
    acquisitionOffer: true,
    repeatLift: 3.4, // this is what makes it a *strategic* loss leader
  },
  {
    key: "clearance-bottle",
    title: "Clearance Water Bottle",
    type: "Accessories",
    priceCents: 1_200,
    costCents: 1_400, // also below cost, but buys nothing
    elasticity: -2.2,
    popularity: 6,
    repeatLift: 0.35,
  },
  {
    key: "hydration-vest",
    title: "Hydration Vest 12L",
    type: "Packs",
    priceCents: 14_500,
    costCents: 5_800,
    elasticity: -1.6,
    popularity: 7,
  },
  {
    key: "wool-socks",
    title: "Merino Wool Socks (3-pack)",
    type: "Accessories",
    priceCents: 4_200,
    costCents: 1_300,
    elasticity: -2.0,
    popularity: 20,
    repeatLift: 1.5,
    priceChanges: [
      { onIso: "2026-04-01", priceCents: 3_800 },
      { onIso: "2026-07-01", priceCents: 4_500 },
    ],
  },
  {
    key: "headlamp",
    title: "Headlamp Pro 800",
    type: "Equipment",
    priceCents: 5_900,
    costCents: 3_100, // thin once fulfilment is allocated
    elasticity: -1.8,
    popularity: 9,
    priceChanges: [{ onIso: "2026-05-20", priceCents: 6_500 }],
  },
  {
    key: "rain-pants",
    title: "Storm Rain Pants",
    type: "Outerwear",
    priceCents: 12_900,
    costCents: 4_900,
    elasticity: -1.7,
    popularity: 6,
  },
];

// ---------------------------------------------------------------------------
// Channels and campaigns
// ---------------------------------------------------------------------------

interface SeedCampaign {
  id: string;
  name: string;
  channel: Channel;
  /** Share of the channel's orders this campaign wins. */
  orderShare: number;
  dailySpendStart: number;
  dailySpendEnd: number;
  /** How much the ad platform over-reports its own revenue. */
  platformInflation: number;
}

const CAMPAIGNS: SeedCampaign[] = [
  {
    id: "fb-prospecting",
    name: "Prospecting — Broad",
    channel: Channel.FACEBOOK,
    orderShare: 0.5,
    dailySpendStart: 42_000,
    dailySpendEnd: 96_000,
    platformInflation: 1.72,
  },
  {
    id: "fb-retargeting",
    name: "Retargeting — 30 day",
    channel: Channel.FACEBOOK,
    orderShare: 0.34,
    dailySpendStart: 9_000,
    dailySpendEnd: 15_000,
    platformInflation: 2.4, // retargeting claims credit for what would convert anyway
  },
  {
    id: "fb-lookalike",
    name: "Lookalike 1% — Purchasers",
    channel: Channel.FACEBOOK,
    orderShare: 0.16,
    dailySpendStart: 14_000,
    dailySpendEnd: 26_000,
    platformInflation: 1.55,
  },
  {
    id: "gg-brand",
    name: "Brand — Exact",
    channel: Channel.GOOGLE,
    orderShare: 0.31,
    dailySpendStart: 5_500,
    dailySpendEnd: 9_000,
    platformInflation: 1.9,
  },
  {
    id: "gg-shopping",
    name: "Shopping — All Products",
    channel: Channel.GOOGLE,
    orderShare: 0.46,
    dailySpendStart: 22_000,
    dailySpendEnd: 41_000,
    platformInflation: 1.35,
  },
  {
    id: "gg-nonbrand",
    name: "Search — Non-brand Hiking",
    channel: Channel.GOOGLE,
    orderShare: 0.23,
    dailySpendStart: 19_000,
    dailySpendEnd: 34_000,
    platformInflation: 1.28,
  },
  {
    id: "tt-spark",
    name: "Spark Ads — Creator UGC",
    channel: Channel.TIKTOK,
    orderShare: 1,
    dailySpendStart: 16_000,
    dailySpendEnd: 38_000,
    platformInflation: 2.1,
  },
];

const CHANNEL_MIX: { item: Channel; weight: number }[] = [
  { item: Channel.FACEBOOK, weight: 30 },
  { item: Channel.GOOGLE, weight: 22 },
  { item: Channel.TIKTOK, weight: 11 },
  { item: Channel.EMAIL, weight: 10 },
  { item: Channel.ORGANIC_SEARCH, weight: 13 },
  { item: Channel.DIRECT, weight: 9 },
  { item: Channel.REFERRAL, weight: 5 },
];

/** TikTok skews cheap and impulse-driven; Facebook prospecting carries the offer. */
const CHANNEL_BASKET_BIAS: Partial<Record<Channel, number>> = {
  TIKTOK: 0.62,
  FACEBOOK: 0.92,
  GOOGLE: 1.08,
  EMAIL: 1.15,
  ORGANIC_SEARCH: 1.12,
  DIRECT: 1.2,
  REFERRAL: 1.05,
};

const WEEKDAY_FACTORS = [0.74, 1.26, 1.16, 1.02, 0.98, 0.94, 0.8]; // Sun..Sat

/** Multi-day demand surges: Memorial Day and a July clearance. */
const PROMOS = [
  { startIso: "2026-05-22", days: 4, lift: 2.4, discountPct: 0.2 },
  { startIso: "2026-07-10", days: 3, lift: 1.9, discountPct: 0.15 },
];

const WAREHOUSE_CAPACITY = 95;

// ---------------------------------------------------------------------------

function dayIndex(date: Date) {
  return Math.round((date.getTime() - PERIOD_START.getTime()) / DAY_MS);
}

function totalDays() {
  return (
    Math.round((PERIOD_END.getTime() - PERIOD_START.getTime()) / DAY_MS) + 1
  );
}

function promoFor(date: Date) {
  for (const promo of PROMOS) {
    const start = new Date(`${promo.startIso}T00:00:00Z`).getTime();
    if (
      date.getTime() >= start &&
      date.getTime() < start + promo.days * DAY_MS
    ) {
      return promo;
    }
  }
  return null;
}

function priceOn(product: SeedProduct, date: Date): number {
  let price = product.priceCents;
  for (const change of product.priceChanges ?? []) {
    if (date.getTime() >= new Date(`${change.onIso}T00:00:00Z`).getTime()) {
      price = change.priceCents;
    }
  }
  return price;
}

/**
 * Demand weight at a given price, derived from the product's true elasticity.
 * This is what lets the pricing model rediscover the elasticity from sales.
 */
function demandWeight(product: SeedProduct, priceCents: number): number {
  const ratio = priceCents / product.priceCents;
  return product.popularity * ratio ** product.elasticity;
}

function dailyOrderTarget(date: Date): number {
  const i = dayIndex(date);
  const progress = i / Math.max(1, totalDays() - 1);

  // Steady growth from ~24 to ~108 orders a day over six months.
  const trend = 24 + progress * 84;
  const weekday = WEEKDAY_FACTORS[date.getUTCDay()] ?? 1;
  const promo = promoFor(date);

  return Math.max(
    1,
    Math.round(jitter(trend * weekday * (promo?.lift ?? 1), 0.16)),
  );
}

// ---------------------------------------------------------------------------

interface SeedCustomer {
  id: string;
  shopifyId: string;
  email: string;
  channel: Channel;
  campaignId: string | null;
  firstOrderAt: Date;
  repeatPropensity: number;
  orderCount: number;
  lastOrderAt: Date;
}

async function main() {
  console.log("Seeding Meridian demo store…");

  const existing = await prisma.shop.findUnique({
    where: { domain: DEMO_SHOP_DOMAIN },
  });
  if (existing) {
    console.log("  Removing previous demo data…");
    await prisma.shop.delete({ where: { id: existing.id } });
  }

  // --- shop, cost rules, connectors ---------------------------------------
  const shop = await prisma.shop.create({
    data: {
      domain: DEMO_SHOP_DOMAIN,
      name: "Northwind Supply Co.",
      email: "ops@northwindsupply.com",
      currency: "USD",
      timezone: "America/Los_Angeles",
      planName: "Shopify",
      isDemo: true,
      installedAt: PERIOD_START,
      lastSyncedAt: PERIOD_END,
      fulfillmentSlaDays: 2,
      onboardingStep: "complete",
      // Seeded, not imported — so the app never shows this store as "importing".
      syncStatus: SyncStatus.COMPLETE,
      syncCompletedAt: PERIOD_END,
      hasAllOrdersScope: true,
      earliestOrderAt: PERIOD_START,
      costRules: {
        create: [
          {
            kind: CostRuleKind.PAYMENT_FEE,
            label: "Shopify Payments (US online rate)",
            percentRate: "0.029",
            fixedPerOrder: "0.30",
            origin: CostRuleOrigin.DEMO_SEED,
            confirmedAt: PERIOD_START,
          },
          {
            kind: CostRuleKind.SHIPPING_DEFAULT,
            label: "Estimated outbound shipping",
            fixedPerOrder: "8.50",
            origin: CostRuleOrigin.DEMO_SEED,
            confirmedAt: PERIOD_START,
          },
          {
            kind: CostRuleKind.PICK_PACK,
            label: "Pick, pack and materials",
            fixedPerOrder: "1.75",
            fixedPerItem: "0.35",
            origin: CostRuleOrigin.DEMO_SEED,
            confirmedAt: PERIOD_START,
          },
          {
            kind: CostRuleKind.OVERHEAD_MONTHLY,
            label: "Fixed monthly overhead (rent, salaries, software)",
            monthlyAmount: "48500.00",
            origin: CostRuleOrigin.DEMO_SEED,
            confirmedAt: PERIOD_START,
          },
        ],
      },
      connectors: {
        create: [
          {
            provider: ConnectorProvider.SHOPIFY,
            status: ConnectorStatus.CONNECTED,
            displayName: "Northwind Supply Co.",
            lastSyncedAt: PERIOD_END,
          },
          {
            provider: ConnectorProvider.FACEBOOK_ADS,
            status: ConnectorStatus.CONNECTED,
            displayName: "Northwind — Meta Ads",
            externalAccountId: "act_4471029385",
            lastSyncedAt: PERIOD_END,
          },
          {
            provider: ConnectorProvider.GOOGLE_ADS,
            status: ConnectorStatus.CONNECTED,
            displayName: "Northwind Supply — Google Ads",
            externalAccountId: "882-441-9930",
            lastSyncedAt: PERIOD_END,
          },
          {
            provider: ConnectorProvider.TIKTOK_ADS,
            status: ConnectorStatus.CONNECTED,
            displayName: "Northwind TikTok",
            externalAccountId: "7284119203",
            lastSyncedAt: PERIOD_END,
          },
          {
            provider: ConnectorProvider.STRIPE,
            status: ConnectorStatus.NOT_CONFIGURED,
          },
          {
            provider: ConnectorProvider.WAREHOUSE_3PL,
            status: ConnectorStatus.ERROR,
            displayName: "ShipBob",
            lastError:
              "Credentials rejected (401). Reconnect to resume cost sync.",
            lastSyncedAt: new Date(PERIOD_END.getTime() - 9 * DAY_MS),
          },
        ],
      },
    },
  });

  // --- catalogue ----------------------------------------------------------
  console.log("  Creating products…");
  const variantIdByKey = new Map<string, string>();
  const productIdByKey = new Map<string, string>();

  for (const [index, product] of CATALOGUE.entries()) {
    const created = await prisma.product.create({
      data: {
        shopId: shop.id,
        shopifyId: `gid://shopify/Product/${8_100_000 + index}`,
        title: product.title,
        handle: product.key,
        productType: product.type,
        vendor: "Northwind Supply Co.",
        status: "ACTIVE",
        variants: {
          create: {
            shopId: shop.id,
            shopifyId: `gid://shopify/ProductVariant/${9_100_000 + index}`,
            sku: `NW-${product.key.toUpperCase().slice(0, 8)}`,
            title: "Default",
            price: money(priceOn(product, PERIOD_END)),
            unitCost: cost(product.costCents),
            costSource: CostSource.SHOPIFY,
            inventoryQty: intBetween(40, 600),
            weightGrams: intBetween(120, 2200),
          },
        },
      },
      include: { variants: true },
    });

    productIdByKey.set(product.key, created.id);
    variantIdByKey.set(product.key, created.variants[0]!.id);

    // Price history, including the opening price.
    const history = [
      { effectiveAt: PERIOD_START, price: product.priceCents },
      ...(product.priceChanges ?? []).map((c) => ({
        effectiveAt: new Date(`${c.onIso}T00:00:00Z`),
        price: c.priceCents,
      })),
    ];

    await prisma.priceChange.createMany({
      data: history.map((h) => ({
        shopId: shop.id,
        variantId: created.variants[0]!.id,
        price: money(h.price),
        effectiveAt: h.effectiveAt,
      })),
    });
  }

  // --- orders -------------------------------------------------------------
  console.log("  Generating orders…");

  const customers: SeedCustomer[] = [];
  const orderRows: any[] = [];
  const lineRows: any[] = [];
  const fulfillmentRows: any[] = [];
  const ordersReceivedByDay = new Map<number, number>();

  let orderSeq = 0;
  let customerSeq = 0;

  for (let d = 0; d < totalDays(); d++) {
    const date = new Date(PERIOD_START.getTime() + d * DAY_MS);
    const target = dailyOrderTarget(date);
    const promo = promoFor(date);

    ordersReceivedByDay.set(d, target);

    for (let n = 0; n < target; n++) {
      const processedAt = new Date(
        date.getTime() +
          intBetween(8, 23) * 3_600_000 +
          intBetween(0, 59) * 60_000,
      );

      // Returning-customer share climbs as the base grows.
      const returningRate = 0.08 + (d / totalDays()) * 0.3;
      const eligible = customers.filter(
        (c) => c.lastOrderAt.getTime() < processedAt.getTime() - 6 * DAY_MS,
      );

      const isReturning = eligible.length > 20 && rand() < returningRate;

      let customer: SeedCustomer;
      let channel: Channel;
      let campaignId: string | null;

      if (isReturning) {
        customer = pickWeighted(
          eligible.map((c) => ({ item: c, weight: c.repeatPropensity })),
        );
        // Repeat purchases arrive mostly through owned channels.
        channel = pickWeighted([
          { item: Channel.EMAIL, weight: 40 },
          { item: Channel.DIRECT, weight: 30 },
          { item: Channel.ORGANIC_SEARCH, weight: 14 },
          { item: Channel.FACEBOOK, weight: 12 },
          { item: Channel.GOOGLE, weight: 4 },
        ]);
        campaignId = channel === Channel.FACEBOOK ? "fb-retargeting" : null;
      } else {
        channel = pickWeighted(CHANNEL_MIX);
        const channelCampaigns = CAMPAIGNS.filter((c) => c.channel === channel);
        campaignId =
          channelCampaigns.length > 0
            ? pickWeighted(
                channelCampaigns.map((c) => ({
                  item: c.id,
                  weight: c.orderShare,
                })),
              )
            : null;

        customer = {
          id: `cus_${String(++customerSeq).padStart(6, "0")}`,
          shopifyId: `gid://shopify/Customer/${6_000_000 + customerSeq}`,
          email: `customer${customerSeq}@example.com`,
          channel,
          campaignId,
          firstOrderAt: processedAt,
          repeatPropensity: 1,
          orderCount: 0,
          lastOrderAt: processedAt,
        };
        customers.push(customer);
      }

      // --- basket ---
      const basketBias = CHANNEL_BASKET_BIAS[channel] ?? 1;
      const itemCount = rand() < 0.52 ? 1 : rand() < 0.82 ? 2 : 3;

      const available = CATALOGUE.filter((p) => {
        if (!p.acquisitionOffer) return true;
        // The starter kit is a first-order acquisition offer only, and mostly
        // runs on the top-of-funnel channels.
        return (
          !isReturning &&
          (channel === Channel.TIKTOK ||
            campaignId === "fb-prospecting" ||
            campaignId === "gg-nonbrand")
        );
      });

      const chosen: SeedProduct[] = [];
      for (let k = 0; k < itemCount; k++) {
        const candidates = available.filter((p) => !chosen.includes(p));
        if (candidates.length === 0) break;

        chosen.push(
          pickWeighted(
            candidates.map((p) => ({
              item: p,
              weight:
                demandWeight(p, priceOn(p, date)) *
                (p.acquisitionOffer ? 1 : basketBias),
            })),
          ),
        );
      }
      if (chosen.length === 0) continue;

      const orderId = `ord_${String(++orderSeq).padStart(6, "0")}`;

      let subtotal = 0;
      let discountTotal = 0;
      let units = 0;

      for (const product of chosen) {
        const quantity = product.key === "wool-socks" && rand() < 0.3 ? 2 : 1;
        const unitPrice = priceOn(product, date);
        const lineGross = unitPrice * quantity;

        const lineDiscount = promo
          ? Math.round(lineGross * promo.discountPct)
          : rand() < 0.12
            ? Math.round(lineGross * 0.1)
            : 0;

        subtotal += lineGross;
        discountTotal += lineDiscount;
        units += quantity;

        lineRows.push({
          shopId: shop.id,
          orderId,
          shopifyId: `gid://shopify/LineItem/${orderSeq}-${product.key}`,
          variantId: variantIdByKey.get(product.key)!,
          productId: productIdByKey.get(product.key)!,
          title: product.title,
          sku: `NW-${product.key.toUpperCase().slice(0, 8)}`,
          quantity,
          unitPrice: money(unitPrice),
          discount: money(lineDiscount),
          unitCost: cost(product.costCents),
          refundedQty: 0,
        });

        customer.repeatPropensity *= product.repeatLift ?? 1;
      }

      // Free shipping over $75, otherwise a flat charge.
      const shippingCharged = subtotal - discountTotal >= 7_500 ? 0 : 795;
      const taxable = subtotal - discountTotal + shippingCharged;
      const taxTotal = Math.round(taxable * 0.0825);
      const total = taxable + taxTotal;

      // ~4% of orders see a refund.
      const refunded = rand() < 0.04 ? Math.round(total * between(0.3, 1)) : 0;

      customer.orderCount += 1;
      customer.lastOrderAt = processedAt;

      orderRows.push({
        id: orderId,
        shopId: shop.id,
        shopifyId: `gid://shopify/Order/${5_000_000 + orderSeq}`,
        orderNumber: 1000 + orderSeq,
        processedAt,
        customerKey: customer.id,
        currency: "USD",
        subtotal: money(subtotal),
        discountTotal: money(discountTotal),
        shippingCharged: money(shippingCharged),
        taxTotal: money(taxTotal),
        total: money(total),
        refundedTotal: money(refunded),
        financialStatus: refunded > 0 ? "partially_refunded" : "paid",
        channel,
        campaignId,
        campaignName: CAMPAIGNS.find((c) => c.id === campaignId)?.name ?? null,
        utmSource: campaignId ? channel.toLowerCase() : null,
        utmMedium: campaignId ? "cpc" : null,
        utmCampaign: campaignId,
        isFirstOrder: customer.orderCount === 1,
        _units: units,
        _dayIndex: d,
      });
    }
  }

  console.log(`  ${orderRows.length} orders, ${customers.length} customers.`);

  // --- persist customers then orders --------------------------------------
  await prisma.customer.createMany({
    data: customers.map((c) => ({
      id: c.id,
      shopId: shop.id,
      shopifyId: c.shopifyId,
      email: c.email,
      firstOrderAt: c.firstOrderAt,
      acquisitionChannel: c.channel,
      acquisitionCampaignId: c.campaignId,
    })),
  });

  for (let i = 0; i < orderRows.length; i += 1000) {
    await prisma.order.createMany({
      data: orderRows.slice(i, i + 1000).map((o) => ({
        id: o.id,
        shopId: o.shopId,
        shopifyId: o.shopifyId,
        orderNumber: o.orderNumber,
        processedAt: o.processedAt,
        customerId: o.customerKey,
        currency: o.currency,
        subtotal: o.subtotal,
        discountTotal: o.discountTotal,
        shippingCharged: o.shippingCharged,
        taxTotal: o.taxTotal,
        total: o.total,
        refundedTotal: o.refundedTotal,
        financialStatus: o.financialStatus,
        fulfillmentStatus: "unfulfilled",
        channel: o.channel,
        campaignId: o.campaignId,
        campaignName: o.campaignName,
        utmSource: o.utmSource,
        utmMedium: o.utmMedium,
        utmCampaign: o.utmCampaign,
        isFirstOrder: o.isFirstOrder,
      })),
    });
  }

  for (let i = 0; i < lineRows.length; i += 2000) {
    await prisma.orderLineItem.createMany({
      data: lineRows.slice(i, i + 2000),
    });
  }

  // --- fulfilment and warehouse capacity ----------------------------------
  console.log("  Simulating fulfilment…");

  // Orders are worked oldest-first against a fixed daily ceiling. Once demand
  // outgrows the warehouse the backlog builds on its own — which is exactly the
  // condition the capacity alerts exist to catch.
  const queue = [...orderRows].sort(
    (a, b) => a.processedAt.getTime() - b.processedAt.getTime(),
  );

  const fulfilledByDay = new Map<number, { orders: number; units: number }>();
  const backlogByDay = new Map<number, number>();

  let cursor = 0;
  for (let d = 0; d < totalDays(); d++) {
    const capacityToday = Math.round(
      jitter(WAREHOUSE_CAPACITY, 0.08) * (d % 7 === 0 ? 0.45 : 1), // Sundays run light
    );

    let shippedToday = 0;
    let unitsToday = 0;

    while (shippedToday < capacityToday && cursor < queue.length) {
      const order = queue[cursor]!;
      if (order._dayIndex > d) break; // not placed yet

      const shippedAt = new Date(
        PERIOD_START.getTime() + d * DAY_MS + 15 * 3_600_000,
      );
      const itemCount = order._units as number;

      fulfillmentRows.push({
        shopId: shop.id,
        orderId: order.id,
        status: "success",
        createdAt: order.processedAt,
        shippedAt,
        deliveredAt: new Date(shippedAt.getTime() + intBetween(2, 6) * DAY_MS),
        carrier: pickWeighted([
          { item: "UPS", weight: 5 },
          { item: "USPS", weight: 3 },
          { item: "FedEx", weight: 2 },
        ]),
        serviceLevel: "ground",
        shippingCost: money(Math.round(between(620, 1_180) + itemCount * 110)),
        pickPackCost: money(Math.round(150 + itemCount * 40)),
        itemCount,
        location: "primary",
      });

      shippedToday += 1;
      unitsToday += itemCount;
      cursor += 1;
    }

    const placedThrough = queue.filter((o) => o._dayIndex <= d).length;
    fulfilledByDay.set(d, { orders: shippedToday, units: unitsToday });
    backlogByDay.set(d, Math.max(0, placedThrough - cursor));
  }

  for (let i = 0; i < fulfillmentRows.length; i += 2000) {
    await prisma.fulfillment.createMany({
      data: fulfillmentRows.slice(i, i + 2000),
    });
  }

  // Mark everything that shipped as fulfilled.
  const fulfilledOrderIds = new Set(fulfillmentRows.map((f) => f.orderId));
  for (let i = 0; i < orderRows.length; i += 1000) {
    const ids = orderRows
      .slice(i, i + 1000)
      .filter((o) => fulfilledOrderIds.has(o.id))
      .map((o) => o.id);
    if (ids.length === 0) continue;
    await prisma.order.updateMany({
      where: { id: { in: ids } },
      data: { fulfillmentStatus: "fulfilled" },
    });
  }

  // Match the live rebuild exactly: capacity is the best order-throughput day
  // actually observed, and staffed hours stay unknown because Shopify does not
  // provide a staffing schedule. The demo used to invent 16/40 staffed hours
  // and a fixed ceiling, so a re-import immediately changed the same screen.
  const observedCapacity = Math.max(
    0,
    ...Array.from(fulfilledByDay.values(), (day) => day.orders),
  );

  await prisma.capacityDay.createMany({
    data: Array.from({ length: totalDays() }, (_, d) => {
      const date = new Date(PERIOD_START.getTime() + d * DAY_MS);
      const fulfilled = fulfilledByDay.get(d) ?? { orders: 0, units: 0 };

      return {
        shopId: shop.id,
        date,
        location: "primary",
        ordersReceived: ordersReceivedByDay.get(d) ?? 0,
        ordersFulfilled: fulfilled.orders,
        unitsFulfilled: fulfilled.units,
        backlogEnd: backlogByDay.get(d) ?? 0,
        staffedHours: "0",
        maxDailyCapacity: observedCapacity,
      };
    }),
  });

  // --- ad spend: deliberately none ----------------------------------------
  //
  // This block used to fabricate `AdSpend` for every campaign for every day, and
  // it was the only writer of that table in the repo. Nothing else can write it:
  // there is no ad-platform OAuth flow and no platform API client anywhere in the
  // tree, and `provision.server.ts:97` creates every connector `NOT_CONFIGURED`
  // and nothing ever configures one.
  //
  // So the seeded store showed blended CAC, paid spend, marketing efficiency,
  // platform over-claim and per-channel ROAS, and every real store shows `—` and
  // `$0.00` for the life of the install. This store is not a private fixture —
  // it is what the listing screenshots are captured from and what the reviewer's
  // demo store URL points at, which made it the last place still selling the
  // capability that `plans.ts` and the Acquisition banner had already stopped
  // selling. Seeding it was the same fault one layer down: fix the surface, not
  // the default that keeps writing it back.
  //
  // `CAMPAIGNS` stays, and orders keep their campaign and UTM attribution, so the
  // demo still shows channel revenue and contribution profit — the capability
  // Starter actually sells, computed from the merchant's own orders and needing
  // no platform token.
  //
  // Restore this in the same change that ships a real connector, and not before.
  // `listing.test.ts` fails if it comes back on its own.

  // --- run the real engine over the seeded data ---------------------------
  console.log("  Computing profitability…");
  const result = await recomputeShopProfitability(shop.id);
  console.log(
    `    ${result.ordersUpdated} orders, ${result.customersUpdated} customers ` +
      `in ${result.durationMs}ms`,
  );
  console.log(
    `    Net profit: $${(result.netProfitCents / 100).toLocaleString("en-US", {
      maximumFractionDigits: 0,
    })}  ` +
      `(unattributed ad spend $${(
        result.unattributedAdSpendCents / 100
      ).toLocaleString("en-US", { maximumFractionDigits: 0 })})`,
  );

  console.log("  Generating pricing recommendations…");
  const recs = await generatePricingRecommendations(shop.id);
  console.log(`    ${recs} recommendations.`);

  console.log("Done.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
