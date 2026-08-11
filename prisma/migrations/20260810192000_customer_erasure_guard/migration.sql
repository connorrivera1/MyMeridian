-- Deleting a Customer row is not enough: an order webhook already in flight,
-- a durable retry, or a later historical import can otherwise recreate it.
-- Only shop-scoped, secret-keyed HMAC-SHA-256 identifier digests are retained;
-- the Shopify id and email themselves never enter this table.
ALTER TABLE "WebhookEvent" ADD COLUMN "payloadExpiresAt" TIMESTAMP(3);

-- Upgrade safety for any delivery queued between the durable-queue migration
-- and this one. Fresh claims set their own deadline in application code.
UPDATE "WebhookEvent"
SET "payloadExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '7 days'
WHERE "payload" IS NOT NULL AND "processedAt" IS NULL;

CREATE TABLE "CustomerErasure" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "identifierHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerErasure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerErasure_shopId_identifierHash_key"
ON "CustomerErasure"("shopId", "identifierHash");

CREATE INDEX "CustomerErasure_shopId_createdAt_idx"
ON "CustomerErasure"("shopId", "createdAt");

ALTER TABLE "CustomerErasure"
ADD CONSTRAINT "CustomerErasure_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
