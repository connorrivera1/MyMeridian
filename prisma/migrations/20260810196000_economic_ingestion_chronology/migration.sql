-- Economic ingestion is fed by independently delayed webhooks and the
-- historical import. Persist Shopify's own clocks so arrival order cannot
-- regress a complete order/fulfilment snapshot.
ALTER TABLE "Order" ADD COLUMN "shopifyUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Fulfillment" ADD COLUMN "shopifyUpdatedAt" TIMESTAMP(3);

-- inventory_items/update identifies an InventoryItem, not its ProductVariant.
-- Retain that identity and its independent source clock so cost edits can be
-- applied to the correct variant without letting a delayed edit win.
ALTER TABLE "Variant"
ADD COLUMN "inventoryItemShopifyId" TEXT,
ADD COLUMN "inventoryItemUpdatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Variant_shopId_inventoryItemShopifyId_key"
ON "Variant"("shopId", "inventoryItemShopifyId");
