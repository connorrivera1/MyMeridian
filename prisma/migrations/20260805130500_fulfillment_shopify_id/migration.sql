-- A `fulfillments/update` delivery repeats the original fulfilment's
-- `created_at`, so the sync's `(shopId, orderId, createdAt)` match treated every
-- update as a duplicate and returned early. Status changes, cancellations and
-- carrier corrections were never applied, and two shipments created in the same
-- second collapsed into one row — which also undercounts the shipped series the
-- capacity engine is built from.
--
-- Nullable: rows imported before this column existed have no Shopify id to
-- backfill from. Postgres treats NULLs as distinct in a unique index, so those
-- legacy rows coexist; the sync adopts one of them by id on the next delivery
-- rather than writing a second row beside it.
ALTER TABLE "Fulfillment" ADD COLUMN     "shopifyId" TEXT;

CREATE UNIQUE INDEX "Fulfillment_shopId_shopifyId_key" ON "Fulfillment"("shopId", "shopifyId");
