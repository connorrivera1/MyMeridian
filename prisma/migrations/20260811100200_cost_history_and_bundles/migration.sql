-- Cost history, bundle deconstruction, frozen reporting periods, and the
-- durable recalculation queue.
--
-- The final statement is the one that needs explaining. Every variant that
-- already carries a cost gets one `VariantCost` row effective at the epoch,
-- which reads as "as far back as this install can see, the cost was this".
-- That is not a new claim: it is exactly what `OrderLineItem.unitCost`
-- already assumed when it froze today's number onto a two-year-old order.
-- Making it explicit is what gives cost resolution a floor, so a merchant's
-- first backdated correction has something to supersede instead of finding an
-- empty timeline and falling back to the mutable column it was trying to fix.
--
-- Seeding the floor changes no reported number. Line-item snapshots are not
-- touched here; only an explicit, audited restatement rewrites those.

-- CreateEnum
CREATE TYPE "BundleSource" AS ENUM ('MANUAL', 'SKU_PATTERN', 'TITLE_PATTERN', 'SHOPIFY_BUNDLE');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "RecalcJobKind" AS ENUM ('COST_RESTATEMENT', 'BUNDLE_ROLLUP', 'BUNDLE_DETECTION');

-- CreateEnum
CREATE TYPE "RecalcJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETE', 'FAILED');

-- AlterEnum
ALTER TYPE "CostSource" ADD VALUE 'BUNDLE_ROLLUP';

-- AlterTable
ALTER TABLE "OrderLineItem" ADD COLUMN     "costEffectiveAt" TIMESTAMP(3),
ADD COLUMN     "costRestatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "VariantCost" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "unitCost" DECIMAL(12,4) NOT NULL,
    "source" "CostSource" NOT NULL DEFAULT 'MANUAL',
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "VariantCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleComponent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "bundleVariantId" TEXT NOT NULL,
    "componentVariantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "source" "BundleSource" NOT NULL DEFAULT 'MANUAL',
    "evidence" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BundleComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "orderCount" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "netRevenue" DECIMAL(14,2) NOT NULL,
    "cogs" DECIMAL(14,2) NOT NULL,
    "contributionProfit" DECIMAL(14,2) NOT NULL,
    "netProfit" DECIMAL(14,2) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "restatementCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PeriodSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodRestatement" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "jobId" TEXT,
    "periodKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ordersAffected" INTEGER NOT NULL,
    "lineItemsAffected" INTEGER NOT NULL,
    "cogsBefore" DECIMAL(14,2) NOT NULL,
    "cogsAfter" DECIMAL(14,2) NOT NULL,
    "contributionProfitBefore" DECIMAL(14,2) NOT NULL,
    "contributionProfitAfter" DECIMAL(14,2) NOT NULL,
    "netProfitBefore" DECIMAL(14,2) NOT NULL,
    "netProfitAfter" DECIMAL(14,2) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodRestatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecalcJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" "RecalcJobKind" NOT NULL,
    "status" "RecalcJobStatus" NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecalcJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VariantCost_shopId_effectiveAt_idx" ON "VariantCost"("shopId", "effectiveAt");

-- CreateIndex
CREATE INDEX "VariantCost_variantId_effectiveAt_idx" ON "VariantCost"("variantId", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "VariantCost_variantId_effectiveAt_key" ON "VariantCost"("variantId", "effectiveAt");

-- CreateIndex
CREATE INDEX "BundleComponent_shopId_bundleVariantId_idx" ON "BundleComponent"("shopId", "bundleVariantId");

-- CreateIndex
CREATE INDEX "BundleComponent_shopId_componentVariantId_idx" ON "BundleComponent"("shopId", "componentVariantId");

-- CreateIndex
CREATE INDEX "BundleComponent_shopId_confirmedAt_idx" ON "BundleComponent"("shopId", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BundleComponent_bundleVariantId_componentVariantId_key" ON "BundleComponent"("bundleVariantId", "componentVariantId");

-- CreateIndex
CREATE INDEX "PeriodSnapshot_shopId_status_idx" ON "PeriodSnapshot"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodSnapshot_shopId_periodKey_key" ON "PeriodSnapshot"("shopId", "periodKey");

-- CreateIndex
CREATE INDEX "PeriodRestatement_shopId_periodKey_appliedAt_idx" ON "PeriodRestatement"("shopId", "periodKey", "appliedAt");

-- CreateIndex
CREATE INDEX "PeriodRestatement_snapshotId_idx" ON "PeriodRestatement"("snapshotId");

-- CreateIndex
CREATE INDEX "PeriodRestatement_jobId_idx" ON "PeriodRestatement"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "RecalcJob_dedupeKey_key" ON "RecalcJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "RecalcJob_status_availableAt_leaseExpiresAt_idx" ON "RecalcJob"("status", "availableAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "RecalcJob_shopId_kind_createdAt_idx" ON "RecalcJob"("shopId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "RecalcJob_shopId_status_idx" ON "RecalcJob"("shopId", "status");

-- AddForeignKey
ALTER TABLE "VariantCost" ADD CONSTRAINT "VariantCost_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCost" ADD CONSTRAINT "VariantCost_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_bundleVariantId_fkey" FOREIGN KEY ("bundleVariantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleComponent" ADD CONSTRAINT "BundleComponent_componentVariantId_fkey" FOREIGN KEY ("componentVariantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodSnapshot" ADD CONSTRAINT "PeriodSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodRestatement" ADD CONSTRAINT "PeriodRestatement_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodRestatement" ADD CONSTRAINT "PeriodRestatement_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "PeriodSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodRestatement" ADD CONSTRAINT "PeriodRestatement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RecalcJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecalcJob" ADD CONSTRAINT "RecalcJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed the cost timeline floor from the current denormalised cost.
INSERT INTO "VariantCost" ("id", "shopId", "variantId", "unitCost", "source", "effectiveAt", "recordedAt", "note")
SELECT
  'seed_' || v."id",
  v."shopId",
  v."id",
  v."unitCost",
  v."costSource",
  TIMESTAMP '1970-01-01 00:00:00',
  NOW(),
  'Opening cost basis, carried forward from the catalog at migration time'
FROM "Variant" AS v
WHERE v."unitCost" IS NOT NULL
ON CONFLICT ("variantId", "effectiveAt") DO NOTHING;
