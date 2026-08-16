ALTER TABLE "Subscription"
  ADD COLUMN "pendingPlan" TEXT,
  ADD COLUMN "pendingInterval" TEXT,
  ADD COLUMN "pendingEffectiveAt" TIMESTAMP(3);
