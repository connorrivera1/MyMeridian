-- CreateEnum
CREATE TYPE "ShippingAdjustmentKind" AS ENUM ('LABEL_PURCHASE', 'CARRIER_ADJUSTMENT', 'RETURN_LABEL');

-- CreateEnum
CREATE TYPE "ShippingAdjustmentSource" AS ENUM ('SHOPIFY', 'CARRIER_INVOICE', 'THREEPL', 'MANUAL');

-- CreateEnum
CREATE TYPE "AdSyncWindowState" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- AlterTable
ALTER TABLE "Connector" ADD COLUMN     "accountCurrency" TEXT,
ADD COLUMN     "lastDeepSyncAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "presentmentCurrency" TEXT,
ADD COLUMN     "presentmentExchangeRate" DECIMAL(20,10),
ADD COLUMN     "presentmentTotal" DECIMAL(12,2),
ADD COLUMN     "returnFeesRetained" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ShippingLabelAdjustment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentId" TEXT,
    "kind" "ShippingAdjustmentKind" NOT NULL,
    "source" "ShippingAdjustmentSource" NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sourceCurrency" TEXT,
    "sourceAmount" DECIMAL(12,2),
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingLabelAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSyncWindow" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "status" "AdSyncWindowState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "rowsWritten" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "lastError" TEXT,
    "syncedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSyncWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'frankfurter',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShippingLabelAdjustment_orderId_idx" ON "ShippingLabelAdjustment"("orderId");

-- CreateIndex
CREATE INDEX "ShippingLabelAdjustment_shopId_occurredAt_idx" ON "ShippingLabelAdjustment"("shopId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingLabelAdjustment_shopId_source_reference_key" ON "ShippingLabelAdjustment"("shopId", "source", "reference");

-- CreateIndex
CREATE INDEX "AdSyncWindow_shopId_status_day_idx" ON "AdSyncWindow"("shopId", "status", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AdSyncWindow_connectorId_day_key" ON "AdSyncWindow"("connectorId", "day");

-- CreateIndex
CREATE INDEX "ExchangeRate_base_quote_day_idx" ON "ExchangeRate"("base", "quote", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_day_base_quote_key" ON "ExchangeRate"("day", "base", "quote");

-- AddForeignKey
ALTER TABLE "ShippingLabelAdjustment" ADD CONSTRAINT "ShippingLabelAdjustment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingLabelAdjustment" ADD CONSTRAINT "ShippingLabelAdjustment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingLabelAdjustment" ADD CONSTRAINT "ShippingLabelAdjustment_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "Fulfillment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSyncWindow" ADD CONSTRAINT "AdSyncWindow_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSyncWindow" ADD CONSTRAINT "AdSyncWindow_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
