import type { Cents, Micros } from "./money";

export type Channel =
  | "FACEBOOK"
  | "GOOGLE"
  | "TIKTOK"
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
];

export const CHANNEL_LABELS: Record<Channel, string> = {
  FACEBOOK: "Facebook Ads",
  GOOGLE: "Google Ads",
  TIKTOK: "TikTok Ads",
  EMAIL: "Email",
  ORGANIC_SEARCH: "Organic search",
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

  lineItems: EngineLineItem[];

  /** Real carrier cost when a fulfilment record exists; null falls back to rules. */
  actualShippingCostCents: Cents | null;
  actualPickPackCostCents: Cents | null;
}

export interface CostRuleSet {
  paymentPercentRate: number;
  paymentFixedPerOrderCents: Cents;
  shippingDefaultPerOrderCents: Cents;
  pickPackPerOrderCents: Cents;
  pickPackPerItemCents: Cents;
  monthlyOverheadCents: Cents;
}

export const ZERO_COST_RULES: CostRuleSet = {
  paymentPercentRate: 0,
  paymentFixedPerOrderCents: 0,
  shippingDefaultPerOrderCents: 0,
  pickPackPerOrderCents: 0,
  pickPackPerItemCents: 0,
  monthlyOverheadCents: 0,
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
  shippingRevenueCents: Cents;
  netRevenueCents: Cents;

  cogsCents: Cents;
  shippingCostCents: Cents;
  paymentFeeCents: Cents;
  pickPackCents: Cents;
  adCostCents: Cents;
  overheadCents: Cents;
  totalCostCents: Cents;

  contributionProfitCents: Cents;
  netProfitCents: Cents;

  /** null when there is no revenue to divide by. */
  contributionMarginPct: number | null;
  netMarginPct: number | null;

  units: number;
  /** True when any cost in this order came from a default rather than real data. */
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
