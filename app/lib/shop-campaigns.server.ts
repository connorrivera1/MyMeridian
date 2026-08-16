import type { ProviderDailySpend } from "~/lib/ad-platforms/types.server";
import { adminClientForShop } from "~/lib/shopify-catalog.server";

type JsonRecord = Record<string, unknown>;

interface ShopifyQlResponse {
  data?: {
    shopifyqlQuery?: {
      tableData?: { rows?: JsonRecord[] | null } | null;
      parseErrors?: (string | { message?: string })[] | null;
    } | null;
  };
  errors?: { message?: string }[];
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function decimal(value: unknown): string {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00";
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

/**
 * ShopifyQL grants this field only after the app has both `read_reports` and
 * Shopify's Level 2 protected-customer-data approval. The query below reads
 * only aggregate campaign metrics; the wider ShopifyQL gate does not authorise
 * MyMeridian to retrieve or retain individual shopper fields.
 */
export const SHOP_CAMPAIGNS_PROTECTED_DATA_ERROR =
  "Shopify has not approved Level 2 protected customer data for ShopifyQL yet. In Partner Dashboard, request Level 2 access covering Name, Email, Phone, and Address, then retry Shop Campaigns. MyMeridian queries only aggregate Shop Campaign metrics and does not query or store shopper name, email, phone, or address.";

export const SHOP_CAMPAIGNS_REPORT_ACCESS_ERROR =
  "Shopify reports access is unavailable for Shop Campaigns. Re-authorize MyMeridian with read_reports, then retry.";

/** Permanent until the app's Shopify access or approval changes. */
export class ShopCampaignsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopCampaignsAccessError";
  }
}

/** The only campaign dimension currently exposed by this ShopifyQL schema. */
export function shopCampaignId(name: string): string {
  // ShopifyQL documents the schema as keyed by campaign, but exposes a name
  // rather than a durable campaign-id dimension. Namespace it so an order UTM
  // can never accidentally collide with another provider's campaign id.
  return `shop-campaign:${name}`;
}

/** Build a one-day query so each durable sync-window has one replacement unit. */
export function shopCampaignsQueryForDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Shop Campaigns requires an ISO calendar day");
  }
  return [
    "FROM shop_campaign_insights",
    "SHOW shop_campaign_ad_spend, shop_campaign_sales, shop_campaign_customers",
    "GROUP BY shop_campaign_name",
    "TIMESERIES day",
    `SINCE ${day} UNTIL ${day}`,
    "ORDER BY day ASC LIMIT 1000",
  ].join(" ");
}

/**
 * Normalize Shopify's aggregate Shop Campaign metrics into the existing spend
 * row shape. Sales and customers remain provider-reported fields: no order id
 * is available here, so they must not be merged into Meridian order counts.
 */
export function parseShopCampaignRows(
  payload: ShopifyQlResponse,
): ProviderDailySpend[] {
  const errors = [
    ...(payload.errors ?? []).map((error) => error.message ?? "GraphQL error"),
    ...(payload.data?.shopifyqlQuery?.parseErrors ?? []).map((error) =>
      typeof error === "string"
        ? error
        : (error.message ?? "ShopifyQL parse error"),
    ),
  ];
  if (errors.length > 0) {
    throw new Error(`Shop Campaigns query failed: ${errors.join("; ")}`);
  }

  const rows = payload.data?.shopifyqlQuery?.tableData?.rows ?? [];
  return rows.flatMap((row) => {
    const campaignName = text(row.shop_campaign_name);
    if (!campaignName) return [];
    return [
      {
        campaignId: shopCampaignId(campaignName),
        campaignName,
        // The schema does not publish impression or click metrics. Zero here
        // means "not supplied by this source" and those fields are never used
        // to infer spend, sales, or conversion performance.
        impressions: 0,
        clicks: 0,
        spend: decimal(row.shop_campaign_ad_spend),
        conversions: count(row.shop_campaign_customers),
        revenue: decimal(row.shop_campaign_sales),
      },
    ];
  });
}

const SHOP_CAMPAIGNS_GRAPHQL = `#graphql
  query MeridianShopCampaigns($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData { rows }
      parseErrors
    }
  }
`;

/** Fetch aggregate, store-currency Shop Campaign metrics for one calendar day. */
export async function fetchShopCampaignDailySpend(
  shopDomain: string,
  day: string,
): Promise<ProviderDailySpend[]> {
  const admin = await adminClientForShop(shopDomain);
  const response = await admin.graphql(SHOP_CAMPAIGNS_GRAPHQL, {
    variables: { query: shopCampaignsQueryForDay(day) },
  });
  return parseShopCampaignRows((await response.json()) as ShopifyQlResponse);
}

function messageFor(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function isShopCampaignsProtectedDataError(error: unknown): boolean {
  const message = messageFor(error);
  return (
    (message.includes("protected customer data") ||
      message.includes("protected customer fields") ||
      message.includes("level 2")) &&
    (message.includes("not approved") ||
      message.includes("request access") ||
      message.includes("access denied") ||
      message.includes("requirements"))
  );
}

export function isShopCampaignsReportsAccessError(error: unknown): boolean {
  const message = messageFor(error);
  return (
    message.includes("read_reports") ||
    message.includes("reports access scope") ||
    message.includes("access scope is required")
  );
}
