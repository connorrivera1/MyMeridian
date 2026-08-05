-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "earliestOrderAt" TIMESTAMP(3),
ADD COLUMN     "hasAllOrdersScope" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "syncCompletedAt" TIMESTAMP(3),
ADD COLUMN     "syncCursor" TEXT,
ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncStage" TEXT,
ADD COLUMN     "syncStartedAt" TIMESTAMP(3),
ADD COLUMN     "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "syncedOrders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "syncedProducts" INTEGER NOT NULL DEFAULT 0;
