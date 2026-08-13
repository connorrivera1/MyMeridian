-- Merchant decisions are tenant-owned, aggregate-only evidence. Keep the
-- model inside the same RLS architecture as every other shop-owned record.
CREATE TABLE "ActionDismissal" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ActionDismissal_shopId_key_key" ON "ActionDismissal"("shopId", "key");
CREATE INDEX "ActionDismissal_shopId_dismissedAt_idx" ON "ActionDismissal"("shopId", "dismissedAt");

ALTER TABLE "ActionDismissal"
  ADD CONSTRAINT "ActionDismissal_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActionDismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActionDismissal" FORCE ROW LEVEL SECURITY;

CREATE POLICY "meridian_system_all" ON "ActionDismissal" TO meridian_system
  USING (true) WITH CHECK (true);
CREATE POLICY "meridian_tenant_shop" ON "ActionDismissal" TO meridian_tenant
  USING ("shopId" = NULLIF(current_setting('meridian.shop_id', true), ''))
  WITH CHECK ("shopId" = NULLIF(current_setting('meridian.shop_id', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON "ActionDismissal" TO meridian_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ActionDismissal" TO meridian_tenant;

-- An accepted price recommendation is an observation request, not a claim of
-- causation. It stays pending until Meridian sees a Shopify price change and
-- enough later order data to make a comparison honest.
ALTER TABLE "PricingRecommendation"
  ADD COLUMN "outcomeStatus" TEXT NOT NULL DEFAULT 'NOT_TRACKED',
  ADD COLUMN "outcomeObservedAt" TIMESTAMP(3),
  ADD COLUMN "outcomeObservedProfitDelta" DECIMAL(12,2);
