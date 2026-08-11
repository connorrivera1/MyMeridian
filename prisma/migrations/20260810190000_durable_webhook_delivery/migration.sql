-- A verified delivery must survive a process crash after the HTTP 200. The
-- application persists only a per-topic projected payload, never Shopify's
-- full wire body, and clears it as soon as the route processor succeeds.
ALTER TABLE "WebhookEvent"
ADD COLUMN "payload" JSONB,
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN "leaseToken" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "WebhookEvent_processedAt_availableAt_leaseExpiresAt_idx"
ON "WebhookEvent"("processedAt", "availableAt", "leaseExpiresAt");
