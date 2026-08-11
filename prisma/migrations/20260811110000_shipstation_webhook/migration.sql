ALTER TABLE "Connector"
  ADD COLUMN "webhookId" TEXT,
  ADD COLUMN "webhookSecretEnc" TEXT,
  ADD COLUMN "webhookRegisteredAt" TIMESTAMP(3),
  ADD COLUMN "workLeaseToken" TEXT,
  ADD COLUMN "workLeaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "Connector_workLeaseExpiresAt_idx"
  ON "Connector"("workLeaseExpiresAt");
