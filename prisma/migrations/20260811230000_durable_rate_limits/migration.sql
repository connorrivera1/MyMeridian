-- Distributed abuse protection. The app stores only keyed fingerprints, never
-- raw addresses, emails, shop domains, tokens or other supplied identifiers.
CREATE TABLE "RateLimitBucket" (
    "scope" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("scope", "subjectHash", "windowStart")
);

CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");
