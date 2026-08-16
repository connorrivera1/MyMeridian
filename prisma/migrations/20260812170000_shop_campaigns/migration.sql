-- ShopifyQL reports Shop Campaign spend separately from merchant-connected
-- Meta, Google and TikTok accounts. Keep it in the same tenant-scoped spend
-- ledger, but give it its own immutable source/channel identity.
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'SHOP_CAMPAIGNS';

ALTER TYPE "ConnectorProvider" ADD VALUE IF NOT EXISTS 'SHOPIFY_SHOP_CAMPAIGNS';
