-- Fly Managed Postgres provisions "writer" logins for both application
-- identities. That inherited role can retain broad table privileges even when
-- the tenant login has no direct grant. RLS therefore has to cover every
-- system-only table as well as merchant tables: privilege alone must never let
-- a tenant transaction inspect identity, operator, session or rate-limit data.
DO $$
DECLARE
  system_role text := CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian-app-system')
      THEN 'meridian-app-system'
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_system')
      THEN 'meridian_system'
    ELSE NULL
  END;
  tenant_role text := CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian-app-tenant')
      THEN 'meridian-app-tenant'
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_tenant')
      THEN 'meridian_tenant'
    ELSE NULL
  END;
  migration_role text := current_user;
  table_name text;
  system_only_tables text[] := ARRAY[
    'EmailVerificationToken', 'FoundingMerchantEntitlement', 'MfaChallenge',
    'OAuthAccount', 'OperatorAuditEvent', 'OperatorMfaState',
    'OperatorSession', 'PasswordResetCode', 'RateLimitBucket', 'Session',
    'User', 'WaitlistEmailDelivery', 'WaitlistSignup', 'WebSession'
  ];
BEGIN
  IF system_role IS NULL OR tenant_role IS NULL THEN
    RAISE EXCEPTION 'Missing MyMeridian runtime roles for system-table RLS.';
  END IF;

  FOREACH table_name IN ARRAY system_only_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'meridian_system_all', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO %I USING (true) WITH CHECK (true)',
      'meridian_system_all', table_name, system_role
    );
  END LOOP;

  -- Exchange rates are global reference data. Tenant routes may read them but
  -- may never mutate them, even through an inherited provider writer role.
  ALTER TABLE "ExchangeRate" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "ExchangeRate" FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "meridian_system_all" ON "ExchangeRate";
  DROP POLICY IF EXISTS "meridian_tenant_read" ON "ExchangeRate";
  EXECUTE format(
    'CREATE POLICY %I ON "ExchangeRate" TO %I USING (true) WITH CHECK (true)',
    'meridian_system_all', system_role
  );
  EXECUTE format(
    'CREATE POLICY %I ON "ExchangeRate" FOR SELECT TO %I USING (true)',
    'meridian_tenant_read', tenant_role
  );

  -- A compromised tenant request must not inspect or alter migration history.
  -- The direct migration login receives the only additional policy it needs.
  ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "_prisma_migrations" FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "meridian_system_all" ON "_prisma_migrations";
  DROP POLICY IF EXISTS "meridian_migration_all" ON "_prisma_migrations";
  EXECUTE format(
    'CREATE POLICY %I ON "_prisma_migrations" TO %I USING (true) WITH CHECK (true)',
    'meridian_system_all', system_role
  );
  EXECUTE format(
    'CREATE POLICY %I ON "_prisma_migrations" TO %I USING (true) WITH CHECK (true)',
    'meridian_migration_all', migration_role
  );
END
$$;
