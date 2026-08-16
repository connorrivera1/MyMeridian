import type { Cents, Micros } from "./money";

export type Channel =
  | "FACEBOOK"
  | "GOOGLE"
  | "TIKTOK"
  | "SHOP_CAMPAIGNS"
  | "EMAIL"
  | "ORGANIC_SEARCH"
  | "DIRECT"
  | "REFERRAL"
  | "AFFILIATE"
  | "OTHER";

export const PAID_CHANNELS: readonly Channel[] = [
  "FACEBOOK",
  "GOOGLE",
  "TIKTOK",
  "SHOP_CAMPAIGNS",
];

export const CHANNEL_LABELS: Record<Channel, string> = {
  FACEBOOK: "Facebook Ads",
  GOOGLE: "Google Ads",
  TIKTOK: "TikTok Ads",
  SHOP_CAMPAIGNS: "Shop Campaigns",
  EMAIL: "Email",
  ORGANIC_SEARCH: "Organic Search",
  DIRECT: "Direct",
  REFERRAL: "Referral",
  AFFILIATE: "Affiliate",
  OTHER: "Other",
};

export interface EngineLineItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  title: string;
  quantity: number;
  refundedQty: number;
  unitPriceCents: Cents;
  discountCents: Cents;
  unitCostMicros: Micros;
  /** True when Shopify or a merchant explicitly supplied COGS, even if $0. */
  cogsKnown?: boolean;
}

export interface EngineOrder {
  id: string;
  orderNumber: number;
  processedAt: Date;
  customerId: string | null;
  channel: Channel;
  campaignId: string | null;
  isFirstOrder: boolean;

  subtotalCents: Cents;
  discountTotalCents: Cents;
  shippingChargedCents: Cents;
  taxTotalCents: Cents;
  totalCents: Cents;
  refundedTotalCents: Cents;

  /**
   * Return/restocking fees the merchant kept when refunding this order.
   * `refundedTotalCents` is what was actually paid back, so it is already net
   * of these — the engine needs them named so the tax share of a refund is
   * taken from the value that came back, not from money that never left.
   */
  returnFeesRetainedCents: Cents;

  lineItems: EngineLineItem[];

  /** Real carrier cost when a fulfilment record exists; null falls back to rules. */
  actualShippingCostCents: Cents | null;
  actualPickPackCostCents: Cents | null;
  /**
   * Return labels and other inbound-shipping cost the merchant paid, from the
   * shipping-adjustment ledger. Zero when none — a return label either exists
   * as a recorded cost or it does not, so there is no modeled fallback.
   */
  returnShippingCostCents: Cents;
}

export interface CostRuleSet {
  paymentPercentRate: number;
  paymentFixedPerOrderCents: Cents;
  shippingDefaultPerOrderCents: Cents;
  pickPackPerOrderCents: Cents;
  pickPackPerItemCents: Cents;
  monthlyOverheadCents: Cents;
  provenance: CostRuleProvenanceSet;
}

export type EngineCostRuleOrigin =
  "INSTALL_DEFAULT" | "MERCHANT_CONFIGURED" | "DEMO_SEED" | "LEGACY_UNKNOWN";

export interface EngineCostRuleProvenance {
  origin: EngineCostRuleOrigin;
  confirmed: boolean;
}

/** Provenance follows each numerical rule into the pure profit engine. */
export interface CostRuleProvenanceSet {
  paymentFee: EngineCostRuleProvenance | null;
  shippingDefault: EngineCostRuleProvenance | null;
  pickPack: EngineCostRuleProvenance | null;
  monthlyOverhead: EngineCostRuleProvenance | null;
}

export const ZERO_COST_RULES: CostRuleSet = {
  paymentPercentRate: 0,
  paymentFixedPerOrderCents: 0,
  shippingDefaultPerOrderCents: 0,
  pickPackPerOrderCents: 0,
  pickPackPerItemCents: 0,
  monthlyOverheadCents: 0,
  provenance: {
    paymentFee: null,
    shippingDefault: null,
    pickPack: null,
    monthlyOverhead: null,
  },
};

export interface OrderProfit {
  orderId: string;
  orderNumber: number;
  processedAt: Date;
  channel: Channel;
  customerId: string | null;
  isFirstOrder: boolean;

  grossRevenueCents: Cents;
  discountCents: Cents;
  refundCents: Cents;
  /** Return/restocking fees retained on refunds; already inside net revenue. */
  returnFeesRetainedCents: Cents;
  shippingRevenueCents: Cents;
  netRevenueCents: Cents;

  cogsCents: Cents;
  /** Outbound only. Return labels are their own line below. */
  shippingCostCents: Cents;
  paymentFeeCents: Cents;
  pickPackCents: Cents;
  adCostCents: Cents;
  overheadCents: Cents;
  /** Merchant-paid return labels, from the shipping-adjustment ledger. */
  returnShippingCostCents: Cents;
  totalCostCents: Cents;

  contributionProfitCents: Cents;
  netProfitCents: Cents;

  /** null when there is no revenue to divide by. */
  contributionMarginPct: number | null;
  netMarginPct: number | null;

  units: number;
  /** A sold unit had no Shopify inventory-item cost to snapshot. */
  hasMissingCogs: boolean;
  /** A configured fee, fulfilment fallback or overhead allocation was used. */
  usesModeledCosts: boolean;
  /** True when a carrier or fulfilment source supplied this order's shipping cost. */
  shippingCostMeasured?: boolean;
  /** Compatibility summary: either missing COGS or a modeled cost was used. */
  usesEstimatedCosts: boolean;
}

export interface AdSpendRow {
  date: Date;
  channel: Channel;
  campaignId: string | null;
  campaignName: string | null;
  spendCents: Cents;
  impressions: number;
  clicks: number;
  platformConversions: number;
  platformRevenueCents: Cents;
}
