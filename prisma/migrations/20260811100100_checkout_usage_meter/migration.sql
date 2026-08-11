CREATE TABLE "Checkout" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "cartToken" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "totalQuantity" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Checkout_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageMeter" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "softLimit" INTEGER NOT NULL,
    "hardLimit" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'under_limit',
    "billedUnits" INTEGER NOT NULL DEFAULT 0,
    "billingAttempts" INTEGER NOT NULL DEFAULT 0,
    "billingError" TEXT,
    "lastBillingAttemptAt" TIMESTAMP(3),
    "lastUsageRecordId" TEXT,
    "overageNotifiedAt" TIMESTAMP(3),
    "capWarningNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UsageMeter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageMeterEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageMeterEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Checkout_shopId_token_key" ON "Checkout"("shopId", "token");
CREATE INDEX "Checkout_shopId_shopifyUpdatedAt_idx" ON "Checkout"("shopId", "shopifyUpdatedAt");
CREATE UNIQUE INDEX "UsageMeter_shopId_metric_periodStart_key" ON "UsageMeter"("shopId", "metric", "periodStart");
CREATE INDEX "UsageMeter_shopId_metric_periodEnd_idx" ON "UsageMeter"("shopId", "metric", "periodEnd");
CREATE INDEX "UsageMeter_status_updatedAt_idx" ON "UsageMeter"("status", "updatedAt");
CREATE UNIQUE INDEX "UsageMeterEvent_sourceId_key" ON "UsageMeterEvent"("sourceId");
CREATE INDEX "UsageMeterEvent_meterId_createdAt_idx" ON "UsageMeterEvent"("meterId", "createdAt");
CREATE INDEX "UsageMeterEvent_shopId_source_createdAt_idx" ON "UsageMeterEvent"("shopId", "source", "createdAt");

ALTER TABLE "Checkout" ADD CONSTRAINT "Checkout_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageMeter" ADD CONSTRAINT "UsageMeter_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageMeterEvent" ADD CONSTRAINT "UsageMeterEvent_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageMeterEvent" ADD CONSTRAINT "UsageMeterEvent_meterId_fkey"
  FOREIGN KEY ("meterId") REFERENCES "UsageMeter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
