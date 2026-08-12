-- The application system login is deliberately separate from the migration
-- owner. The original tenant-isolation migration granted it merchant tables,
-- but the system routes also need the identity, operator, session, rate-limit
-- and job tables. Keep this access in the NOLOGIN group rather than making a
-- runtime credential an owner or a BYPASSRLS role.
GRANT USAGE ON SCHEMA public TO meridian_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO meridian_system;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO meridian_system;

-- Prisma migrations run as the database migration owner. These defaults make
-- a separately provisioned system login usable after future migrations without
-- granting it DDL, ownership, superuser, or BYPASSRLS privileges.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meridian_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO meridian_system;
