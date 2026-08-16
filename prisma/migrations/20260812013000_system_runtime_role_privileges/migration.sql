-- The application system login is deliberately separate from the migration
-- owner. Fly Managed Postgres uses its provisioned runtime login; local and
-- integration databases use the NOLOGIN group created by the prior migration.
DO $$
DECLARE
  system_role text := CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian-app-system')
      THEN 'meridian-app-system'
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_system')
      THEN 'meridian_system'
    ELSE NULL
  END;
BEGIN
  IF system_role IS NULL THEN
    RAISE EXCEPTION 'Missing system runtime role for MyMeridian.';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', system_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', system_role);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', system_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', system_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', system_role);
END
$$;
