-- Session.refreshToken / refreshTokenExpires are written unconditionally by
-- @shopify/shopify-app-session-storage-prisma 9.x on every storeSession().
-- Without these columns Prisma rejects the write and no session is ever
-- stored, which fails every install at the token-exchange step.
ALTER TABLE "Session" ADD COLUMN     "refreshToken" TEXT,
ADD COLUMN     "refreshTokenExpires" TIMESTAMP(3);

-- Order line items are deleted and recreated on every sync, outside a
-- transaction. This is what stops two concurrent deliveries of the same order
-- interleaving into duplicated lines and doubling that order's COGS.
CREATE UNIQUE INDEX "OrderLineItem_orderId_shopifyId_key" ON "OrderLineItem"("orderId", "shopifyId");
