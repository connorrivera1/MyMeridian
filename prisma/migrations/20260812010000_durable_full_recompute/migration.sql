-- Merchant-triggered whole-store recomputes must not hold a request open or
-- disappear during a deploy. They run through the leased PostgreSQL queue.
ALTER TYPE "RecalcJobKind" ADD VALUE 'FULL_RECOMPUTE';
