CREATE TYPE "MerchantNotificationKind" AS ENUM ('WEEKLY_SUMMARY', 'ANOMALY_ALERT');
CREATE TYPE "MerchantNotificationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

ALTER TABLE "Shop"
  ADD COLUMN "weeklySummaryEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "weeklySummaryEmail" TEXT,
  ADD COLUMN "weeklySummaryDay" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "nextWeeklySummaryAt" TIMESTAMP(3),
  ADD COLUMN "lastWeeklySummaryAt" TIMESTAMP(3),
  ADD COLUMN "lastWeeklySummaryError" TEXT,
  ADD COLUMN "anomalyAlertsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastAnomalyCheckAt" TIMESTAMP(3),
  ADD COLUMN "lastAnomalyAlertAt" TIMESTAMP(3);

ALTER TABLE "Connector" ADD COLUMN "availableAccounts" JSONB;

ALTER TABLE "Order"
  ADD COLUMN "materializedPaymentFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "materializedPickPackCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "materializedOutboundShippingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "materializedReturnShippingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "materializedUnits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "materializedMissingCogs" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "materializedModeledCosts" BOOLEAN NOT NULL DEFAULT false;

-- Existing stores have already crossed their setup path. New installs retain
-- the schema default and receive the new merchant onboarding experience.
UPDATE "Shop"
SET "onboardingStep" = 'complete'
WHERE "isDemo" = true
   OR "syncStatus" = 'COMPLETE'
   OR EXISTS (
     SELECT 1 FROM "Subscription" s WHERE s."shopId" = "Shop"."id"
   );

CREATE TABLE "MerchantNotification" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "kind" "MerchantNotificationKind" NOT NULL,
  "status" "MerchantNotificationStatus" NOT NULL DEFAULT 'PENDING',
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MerchantNotification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectorOAuthState" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "provider" "ConnectorProvider" NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorOAuthState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SecurityAuditEvent" (
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

CREATE UNIQUE INDEX "MerchantNotification_dedupeKey_key" ON "MerchantNotification"("dedupeKey");
CREATE INDEX "MerchantNotification_status_availableAt_leaseExpiresAt_idx" ON "MerchantNotification"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "MerchantNotification_shopId_createdAt_idx" ON "MerchantNotification"("shopId", "createdAt");
CREATE UNIQUE INDEX "ConnectorOAuthState_tokenHash_key" ON "ConnectorOAuthState"("tokenHash");
CREATE INDEX "ConnectorOAuthState_shopId_provider_createdAt_idx" ON "ConnectorOAuthState"("shopId", "provider", "createdAt");
CREATE INDEX "ConnectorOAuthState_expiresAt_usedAt_idx" ON "ConnectorOAuthState"("expiresAt", "usedAt");
CREATE UNIQUE INDEX "SecurityAuditEvent_dedupeKey_key" ON "SecurityAuditEvent"("dedupeKey");
CREATE INDEX "SecurityAuditEvent_shopId_occurredAt_idx" ON "SecurityAuditEvent"("shopId", "occurredAt");
CREATE INDEX "SecurityAuditEvent_action_occurredAt_idx" ON "SecurityAuditEvent"("action", "occurredAt");

ALTER TABLE "MerchantNotification"
  ADD CONSTRAINT "MerchantNotification_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConnectorOAuthState"
  ADD CONSTRAINT "ConnectorOAuthState_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SecurityAuditEvent"
  ADD CONSTRAINT "SecurityAuditEvent_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
