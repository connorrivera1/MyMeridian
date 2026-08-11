-- A detached historical import can outlive a request and can be abandoned by
-- a machine restart. The token fences a replacement owner from the old worker;
-- the renewable expiry distinguishes a healthy long import from a dead one.
ALTER TABLE "Shop"
ADD COLUMN "syncRunToken" TEXT,
ADD COLUMN "syncLeaseExpiresAt" TIMESTAMP(3);
