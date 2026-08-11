-- Product pages and webhook deliveries can cross in flight. Persist Shopify's
-- source timestamp so a late older delivery can add historical evidence
-- without replacing the newer catalog state already published to merchants.
ALTER TABLE "Product" ADD COLUMN "shopifyUpdatedAt" TIMESTAMP(3);
