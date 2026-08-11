-- Auditable order-level tax splits. Shopify remains the calculator of record;
-- these rows reconcile its total rather than attempting to file or assess tax.
CREATE TYPE "TaxRegime" AS ENUM ('EU_VAT', 'US_SALES_TAX', 'GST', 'OTHER', 'UNALLOCATED');
CREATE TYPE "TaxJurisdictionType" AS ENUM ('VAT', 'STATE', 'COUNTY', 'CITY', 'DISTRICT', 'NATIONAL', 'OTHER', 'UNALLOCATED');
CREATE TYPE "ShippingCostSource" AS ENUM ('SHIPSTATION', 'SHOPIFY_SHIPPING');
CREATE TYPE "ShippingObservationStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'CURRENCY_MISMATCH', 'CONFLICT', 'VOIDED');
CREATE TYPE "ConnectorHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');
CREATE TYPE "ConnectorHealthEventKind" AS ENUM ('CHECK_PASSED', 'CHECK_FAILED', 'TOKEN_REFRESHED', 'FAILOVER_ACTIVATED', 'ALERT_SENT', 'ALERT_FAILED');

ALTER TYPE "ConnectorProvider" ADD VALUE IF NOT EXISTS 'SHIPSTATION';
ALTER TYPE "ConnectorProvider" ADD VALUE IF NOT EXISTS 'SHOPIFY_SHIPPING';

ALTER TABLE "Order"
ADD COLUMN "taxesIncluded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "taxCountryCode" VARCHAR(2),
ADD COLUMN "taxRegionCode" VARCHAR(16),
ADD COLUMN "taxReconciledAt" TIMESTAMP(3);

CREATE TABLE "OrderTaxComponent" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "regime" "TaxRegime" NOT NULL,
  "jurisdictionType" "TaxJurisdictionType" NOT NULL,
  "title" TEXT NOT NULL,
  "source" TEXT,
  "countryCode" VARCHAR(2),
  "regionCode" VARCHAR(16),
  "rate" DECIMAL(12,8),
  "taxableAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "reportedTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "lineItemTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "shippingTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "roundingAdjustment" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "channelLiable" BOOLEAN,
  "includedInPrice" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderTaxComponent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderTaxComponent_orderId_sourceKey_key" ON "OrderTaxComponent"("orderId", "sourceKey");
CREATE INDEX "OrderTaxComponent_shopId_regime_jurisdictionType_idx" ON "OrderTaxComponent"("shopId", "regime", "jurisdictionType");
ALTER TABLE "OrderTaxComponent" ADD CONSTRAINT "OrderTaxComponent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderTaxComponent" ADD CONSTRAINT "OrderTaxComponent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ShippingCostObservation" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "orderId" TEXT,
  "fulfillmentId" TEXT,
  "source" "ShippingCostSource" NOT NULL,
  "externalId" TEXT NOT NULL,
  "externalOrderRef" TEXT,
  "carrier" TEXT,
  "serviceLevel" TEXT,
  "currency" VARCHAR(3) NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "labelCount" INTEGER NOT NULL DEFAULT 1,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3),
  "status" "ShippingObservationStatus" NOT NULL DEFAULT 'UNMATCHED',
  "discrepancyReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShippingCostObservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShippingCostObservation_shopId_source_externalId_key" ON "ShippingCostObservation"("shopId", "source", "externalId");
CREATE INDEX "ShippingCostObservation_shopId_status_observedAt_idx" ON "ShippingCostObservation"("shopId", "status", "observedAt");
CREATE INDEX "ShippingCostObservation_orderId_source_idx" ON "ShippingCostObservation"("orderId", "source");
ALTER TABLE "ShippingCostObservation" ADD CONSTRAINT "ShippingCostObservation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShippingCostObservation" ADD CONSTRAINT "ShippingCostObservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShippingCostObservation" ADD CONSTRAINT "ShippingCostObservation_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "Fulfillment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Connector"
ADD COLUMN "standbyAccessTokenEnc" TEXT,
ADD COLUMN "standbyRefreshTokenEnc" TEXT,
ADD COLUMN "standbyTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "healthStatus" "ConnectorHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "lastHealthCheckedAt" TIMESTAMP(3),
ADD COLUMN "lastHealthyAt" TIMESTAMP(3),
ADD COLUMN "nextHealthCheckAt" TIMESTAMP(3),
ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failoverCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ConnectorHealthEvent" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "connectorId" TEXT NOT NULL,
  "provider" "ConnectorProvider" NOT NULL,
  "kind" "ConnectorHealthEventKind" NOT NULL,
  "status" "ConnectorHealthStatus" NOT NULL,
  "message" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "notifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorHealthEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConnectorHealthEvent_shopId_createdAt_idx" ON "ConnectorHealthEvent"("shopId", "createdAt");
CREATE INDEX "ConnectorHealthEvent_connectorId_createdAt_idx" ON "ConnectorHealthEvent"("connectorId", "createdAt");
ALTER TABLE "ConnectorHealthEvent" ADD CONSTRAINT "ConnectorHealthEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorHealthEvent" ADD CONSTRAINT "ConnectorHealthEvent_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
