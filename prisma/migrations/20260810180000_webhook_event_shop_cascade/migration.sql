-- Link every delivery record that still has a live shop. Rows whose shop was
-- already redacted are themselves store-linked records and are removed below;
-- the application no longer creates a delivery row for an unknown shop.
ALTER TABLE "WebhookEvent" ADD COLUMN "shopId" TEXT;

UPDATE "WebhookEvent" AS event
SET "shopId" = shop."id"
FROM "Shop" AS shop
WHERE event."shopDomain" = shop."domain";

DELETE FROM "WebhookEvent" WHERE "shopId" IS NULL;

ALTER TABLE "WebhookEvent" ALTER COLUMN "shopId" SET NOT NULL;

CREATE INDEX "WebhookEvent_shopId_idx" ON "WebhookEvent"("shopId");

ALTER TABLE "WebhookEvent"
ADD CONSTRAINT "WebhookEvent_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
