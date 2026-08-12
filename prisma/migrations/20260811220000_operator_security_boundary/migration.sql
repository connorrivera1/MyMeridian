CREATE TABLE "OperatorSession" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "actorHash" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "mfaAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "ipHash" TEXT NOT NULL,
  "userAgentHash" TEXT NOT NULL,
  CONSTRAINT "OperatorSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperatorMfaState" (
  "actorHash" TEXT NOT NULL,
  "lastAcceptedCounter" BIGINT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperatorMfaState_pkey" PRIMARY KEY ("actorHash")
);

CREATE TABLE "OperatorAuditEvent" (
  "id" TEXT NOT NULL,
  "actorHash" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "requestPath" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "reason" TEXT,
  "shopId" TEXT,
  "ipHash" TEXT NOT NULL,
  "userAgentHash" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperatorAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperatorSession_tokenHash_key" ON "OperatorSession"("tokenHash");
CREATE INDEX "OperatorSession_actorHash_expiresAt_idx" ON "OperatorSession"("actorHash", "expiresAt");
CREATE INDEX "OperatorSession_expiresAt_revokedAt_idx" ON "OperatorSession"("expiresAt", "revokedAt");
CREATE INDEX "OperatorAuditEvent_actorHash_occurredAt_idx" ON "OperatorAuditEvent"("actorHash", "occurredAt");
CREATE INDEX "OperatorAuditEvent_action_occurredAt_idx" ON "OperatorAuditEvent"("action", "occurredAt");
CREATE INDEX "OperatorAuditEvent_shopId_occurredAt_idx" ON "OperatorAuditEvent"("shopId", "occurredAt");
CREATE INDEX "OperatorAuditEvent_outcome_occurredAt_idx" ON "OperatorAuditEvent"("outcome", "occurredAt");

ALTER TABLE "OperatorAuditEvent"
  ADD CONSTRAINT "OperatorAuditEvent_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
