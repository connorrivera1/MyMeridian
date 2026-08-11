-- Store Shopify's durable development-store signal. A display plan name is
-- not stable enough to decide whether a Billing API charge should be a test.
ALTER TABLE "Shop" ADD COLUMN "partnerDevelopment" BOOLEAN;
