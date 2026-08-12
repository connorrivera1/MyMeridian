-- Historical imports must survive a web-process restart. Reuse the existing
-- leased PostgreSQL work queue rather than adding a second queue protocol.
ALTER TYPE "RecalcJobKind" ADD VALUE 'HISTORICAL_BACKFILL';
