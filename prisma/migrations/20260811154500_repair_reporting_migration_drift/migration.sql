-- The preceding reporting migration was expanded during pre-launch development
-- after it had already been applied to some local databases. Keep this repair
-- forward-only and idempotent: a fresh database already has these objects,
-- while an earlier development database receives only what it is missing.

ALTER TABLE "Connector"
  ADD COLUMN IF NOT EXISTS "availableAccounts" JSONB;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "materializedPaymentFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "materializedPickPackCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "materializedOutboundShippingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "materializedReturnShippingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "materializedUnits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "materializedMissingCogs" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "materializedModeledCosts" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Shop"
  ALTER COLUMN "anomalyAlertsEnabled" SET DEFAULT false;

CREATE TABLE IF NOT EXISTS "SecurityAuditEvent" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorHash" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "requestPath" TEXT NOT NULL,
  "dedupeKey" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SecurityAuditEvent_dedupeKey_key"
  ON "SecurityAuditEvent"("dedupeKey");
CREATE INDEX IF NOT EXISTS "SecurityAuditEvent_shopId_occurredAt_idx"
  ON "SecurityAuditEvent"("shopId", "occurredAt");
CREATE INDEX IF NOT EXISTS "SecurityAuditEvent_action_occurredAt_idx"
  ON "SecurityAuditEvent"("action", "occurredAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'SecurityAuditEvent_shopId_fkey'
  ) THEN
    ALTER TABLE "SecurityAuditEvent"
      ADD CONSTRAINT "SecurityAuditEvent_shopId_fkey"
      FOREIGN KEY ("shopId") REFERENCES "Shop"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
