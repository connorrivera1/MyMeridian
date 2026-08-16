-- Shopify can return a lower-bound history count for large stores. A nullable
-- field prevents that lower bound from becoming a misleading percentage.
ALTER TABLE "Shop"
  ADD COLUMN "syncTotalOrders" INTEGER;

-- Existing zero-cost snapshots used zero as the missing-input sentinel.
-- Preserve that history while allowing new imports to store a confirmed $0.00
-- COGS value without flagging it as unknown.
ALTER TABLE "OrderLineItem"
  ADD COLUMN "cogsKnown" BOOLEAN NOT NULL DEFAULT false;

UPDATE "OrderLineItem"
SET "cogsKnown" = true
WHERE "unitCost" <> 0;
