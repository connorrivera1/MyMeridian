-- Publisher-level pre-launch waitlist. These tables are intentionally outside
-- the merchant tenant model: an email address collected before installation
-- must not be discoverable from a merchant-scoped request.

CREATE TYPE "FoundingMerchantEntitlementStatus" AS ENUM ('ELIGIBLE', 'RESERVED', 'REDEEMED', 'VOID');
CREATE TYPE "WaitlistEmailKind" AS ENUM ('WELCOME');
CREATE TYPE "WaitlistEmailStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

CREATE TABLE "WaitlistSignup" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "storeUrl" TEXT,
    "source" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "marketingConsentAt" TIMESTAMP(3),
    "marketingUnsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WaitlistSignup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FoundingMerchantEntitlement" (
    "id" TEXT NOT NULL,
    "signupId" TEXT NOT NULL,
    "offerVersion" TEXT NOT NULL DEFAULT 'founding-merchant-15-monthly-v1',
    "discountPercentage" INTEGER NOT NULL DEFAULT 15,
    "durationIntervals" INTEGER NOT NULL DEFAULT 12,
    "status" "FoundingMerchantEntitlementStatus" NOT NULL DEFAULT 'ELIGIBLE',
    "redeemShopId" TEXT,
    "reservedAt" TIMESTAMP(3),
    "reservationExpiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedBillingKey" TEXT,
    "redeemedSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FoundingMerchantEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WaitlistEmailDelivery" (
    "id" TEXT NOT NULL,
    "signupId" TEXT NOT NULL,
    "kind" "WaitlistEmailKind" NOT NULL DEFAULT 'WELCOME',
    "status" "WaitlistEmailStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "providerId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WaitlistEmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WaitlistSignup_email_key" ON "WaitlistSignup"("email");
CREATE INDEX "WaitlistSignup_createdAt_idx" ON "WaitlistSignup"("createdAt");
CREATE INDEX "WaitlistSignup_source_createdAt_idx" ON "WaitlistSignup"("source", "createdAt");
CREATE INDEX "WaitlistSignup_utmSource_createdAt_idx" ON "WaitlistSignup"("utmSource", "createdAt");
CREATE INDEX "WaitlistSignup_marketingConsent_createdAt_idx" ON "WaitlistSignup"("marketingConsent", "createdAt");
CREATE UNIQUE INDEX "FoundingMerchantEntitlement_signupId_key" ON "FoundingMerchantEntitlement"("signupId");
CREATE UNIQUE INDEX "FoundingMerchantEntitlement_redeemShopId_key" ON "FoundingMerchantEntitlement"("redeemShopId");
CREATE INDEX "FoundingMerchantEntitlement_status_reservationExpiresAt_idx" ON "FoundingMerchantEntitlement"("status", "reservationExpiresAt");
CREATE INDEX "FoundingMerchantEntitlement_redeemShopId_status_idx" ON "FoundingMerchantEntitlement"("redeemShopId", "status");
CREATE UNIQUE INDEX "WaitlistEmailDelivery_dedupeKey_key" ON "WaitlistEmailDelivery"("dedupeKey");
CREATE INDEX "WaitlistEmailDelivery_status_availableAt_leaseExpiresAt_idx" ON "WaitlistEmailDelivery"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "WaitlistEmailDelivery_signupId_createdAt_idx" ON "WaitlistEmailDelivery"("signupId", "createdAt");

ALTER TABLE "FoundingMerchantEntitlement"
  ADD CONSTRAINT "FoundingMerchantEntitlement_signupId_fkey"
  FOREIGN KEY ("signupId") REFERENCES "WaitlistSignup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FoundingMerchantEntitlement"
  ADD CONSTRAINT "FoundingMerchantEntitlement_redeemShopId_fkey"
  FOREIGN KEY ("redeemShopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WaitlistEmailDelivery"
  ADD CONSTRAINT "WaitlistEmailDelivery_signupId_fkey"
  FOREIGN KEY ("signupId") REFERENCES "WaitlistSignup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Publisher data is not tenant data. System/operator code may use it, but a
-- tenant transaction receives no grant and no policy.
ALTER TABLE "WaitlistSignup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WaitlistSignup" FORCE ROW LEVEL SECURITY;
ALTER TABLE "FoundingMerchantEntitlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FoundingMerchantEntitlement" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WaitlistEmailDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WaitlistEmailDelivery" FORCE ROW LEVEL SECURITY;

CREATE POLICY "meridian_system_all" ON "WaitlistSignup" TO meridian_system
  USING (true) WITH CHECK (true);
CREATE POLICY "meridian_system_all" ON "FoundingMerchantEntitlement" TO meridian_system
  USING (true) WITH CHECK (true);
CREATE POLICY "meridian_system_all" ON "WaitlistEmailDelivery" TO meridian_system
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE "WaitlistSignup", "FoundingMerchantEntitlement", "WaitlistEmailDelivery" FROM PUBLIC, meridian_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "WaitlistSignup", "FoundingMerchantEntitlement", "WaitlistEmailDelivery" TO meridian_system;
