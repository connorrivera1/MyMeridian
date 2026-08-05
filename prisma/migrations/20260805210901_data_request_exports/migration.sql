-- CreateTable
CREATE TABLE "DataRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "customerEmail" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ordersIncluded" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB NOT NULL,
    "collectedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataRequest_webhookId_key" ON "DataRequest"("webhookId");

-- CreateIndex
CREATE INDEX "DataRequest_shopId_requestedAt_idx" ON "DataRequest"("shopId", "requestedAt");

-- CreateIndex
CREATE INDEX "DataRequest_shopId_shopifyCustomerId_idx" ON "DataRequest"("shopId", "shopifyCustomerId");

-- AddForeignKey
ALTER TABLE "DataRequest" ADD CONSTRAINT "DataRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
