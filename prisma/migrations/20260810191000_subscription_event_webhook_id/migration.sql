-- Existing history predates durable delivery ids and remains valid with NULL.
-- PostgreSQL permits multiple NULLs under a unique index; every new webhook
-- event supplies a non-null delivery id and therefore becomes idempotent.
ALTER TABLE "SubscriptionEvent" ADD COLUMN "webhookId" TEXT;

CREATE UNIQUE INDEX "SubscriptionEvent_webhookId_key"
ON "SubscriptionEvent"("webhookId");
