-- Shopify's order subtotal is already net of discounts, while Meridian's
-- profit engine stores a pre-discount merchandise subtotal and subtracts the
-- separately stored discount exactly once. Historical webhook/backfill rows
-- therefore understated revenue and profit by their discount total.
--
-- Demo seed rows already use the engine's pre-discount convention. Repair only
-- real Shopify shops, then enqueue an independent whole-history recompute so
-- every materialized order/customer aggregate is rebuilt from corrected input.

INSERT INTO "RecalcJob" (
  "id",
  "shopId",
  "kind",
  "status",
  "dedupeKey",
  "payload",
  "availableAt",
  "createdAt"
)
SELECT
  'discount_subtotal_repair_' || md5(s.id),
  s.id,
  'FULL_RECOMPUTE'::"RecalcJobKind",
  'QUEUED'::"RecalcJobStatus",
  'discount-subtotal-repair:' || s.id,
  jsonb_build_object('reason', 'discount_subtotal_repair'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Shop" AS s
WHERE NOT s."isDemo"
  AND EXISTS (
    SELECT 1
    FROM "Order" AS o
    WHERE o."shopId" = s.id
      AND o."discountTotal" <> 0
  )
ON CONFLICT ("dedupeKey") DO NOTHING;

UPDATE "Order" AS o
SET "subtotal" = COALESCE(
  (
    SELECT SUM(li."unitPrice" * li.quantity)
    FROM "OrderLineItem" AS li
    WHERE li."orderId" = o.id
  ),
  o."subtotal" + o."discountTotal"
)
FROM "Shop" AS s
WHERE o."shopId" = s.id
  AND NOT s."isDemo"
  AND o."discountTotal" <> 0;
