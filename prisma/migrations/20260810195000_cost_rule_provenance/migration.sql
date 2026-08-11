-- A cost assumption is not "confirmed" merely because it exists. Previous
-- releases did not retain provenance, so live-store rows remain unverified
-- until the merchant saves the corresponding Settings card. Demo data is
-- intentionally authored and can be marked confirmed without merchant input.
CREATE TYPE "CostRuleOrigin" AS ENUM (
  'INSTALL_DEFAULT',
  'MERCHANT_CONFIGURED',
  'DEMO_SEED',
  'LEGACY_UNKNOWN'
);

ALTER TABLE "CostRule"
ADD COLUMN "origin" "CostRuleOrigin" NOT NULL DEFAULT 'LEGACY_UNKNOWN',
ADD COLUMN "confirmedAt" TIMESTAMP(3);

-- These labels are the immutable install-default identities used by every
-- released provisioner. Values may have been edited, so provenance is based on
-- the kind/label pair and confirmation remains unknown.
UPDATE "CostRule" AS rule
SET "origin" = 'INSTALL_DEFAULT'
FROM "Shop" AS shop
WHERE rule."shopId" = shop."id"
  AND shop."isDemo" = false
  AND (
    (rule."kind" = 'PAYMENT_FEE' AND rule."label" = 'Shopify Payments (US online rate)') OR
    (rule."kind" = 'SHIPPING_DEFAULT' AND rule."label" = 'Estimated outbound shipping') OR
    (rule."kind" = 'PICK_PACK' AND rule."label" = 'Pick, pack and materials') OR
    (rule."kind" = 'OVERHEAD_MONTHLY' AND rule."label" = 'Fixed monthly overhead')
  );

UPDATE "CostRule" AS rule
SET
  "origin" = 'DEMO_SEED',
  "confirmedAt" = rule."updatedAt"
FROM "Shop" AS shop
WHERE rule."shopId" = shop."id"
  AND shop."isDemo" = true;

-- New ad-hoc rules are merchant-authored unless their creator explicitly says
-- otherwise. Install and seed paths set their own origins.
ALTER TABLE "CostRule"
ALTER COLUMN "origin" SET DEFAULT 'MERCHANT_CONFIGURED';
