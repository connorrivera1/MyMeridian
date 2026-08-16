-- Standalone web accounts use mandatory email + phone enrollment and a
-- possession challenge. Shopify-embedded requests continue to authenticate
-- with Shopify session tokens and never collect a phone number.
ALTER TABLE "User"
  ADD COLUMN "phoneNumberEnc" TEXT,
  ADD COLUMN "phoneLast4" TEXT,
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "mfaEnrolledAt" TIMESTAMP(3);

ALTER TABLE "WebSession"
  ADD COLUMN "primaryAuthenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "mfaVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "reauthenticatedAt" TIMESTAMP(3);

-- Existing sessions are deliberately left without mfaVerifiedAt. They become
-- restricted pre-auth sessions and must complete MFA after this migration.
CREATE TABLE "MfaChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "codeHash" TEXT,
    "destinationHash" TEXT NOT NULL,
    "providerRef" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MfaChallenge_sessionId_purpose_channel_createdAt_idx"
  ON "MfaChallenge"("sessionId", "purpose", "channel", "createdAt");
CREATE INDEX "MfaChallenge_userId_createdAt_idx"
  ON "MfaChallenge"("userId", "createdAt");
CREATE INDEX "MfaChallenge_expiresAt_idx" ON "MfaChallenge"("expiresAt");

ALTER TABLE "MfaChallenge"
  ADD CONSTRAINT "MfaChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MfaChallenge"
  ADD CONSTRAINT "MfaChallenge_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "WebSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
