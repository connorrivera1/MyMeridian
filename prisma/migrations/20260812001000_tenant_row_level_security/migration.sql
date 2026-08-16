-- Database-enforced tenant isolation. Locally and in the integration suite we
-- create NOLOGIN group roles and explicitly assume the tenant role. Fly
-- Managed Postgres deliberately forbids CREATE ROLE, so deployed staging uses
-- its two separately provisioned, least-privileged runtime logins directly.
DO $$
DECLARE
  use_managed_runtime_logins boolean :=
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian-app-system')
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian-app-tenant');
  can_create_roles boolean := COALESCE(
    (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user),
    false
  );
  system_role text;
  tenant_role text;
  table_name text;
  shop_tables text[] := ARRAY[
    'WebhookEvent', 'Subscription', 'SubscriptionEvent', 'Checkout',
    'UsageMeter', 'UsageMeterEvent', 'Product', 'Variant', 'VariantCost',
    'BundleComponent', 'PeriodSnapshot', 'PeriodRestatement', 'RecalcJob',
    'PriceChange', 'Customer', 'CustomerErasure', 'DataRequest', 'Order',
    'OrderTaxComponent', 'ShippingLabelAdjustment', 'OrderLineItem', 'AdSpend',
    'Fulfillment', 'ShippingCostObservation', 'CapacityDay', 'CostRule',
    'Connector', 'ConnectorHealthEvent', 'MerchantNotification',
    'ConnectorOAuthState', 'SecurityAuditEvent', 'AdSyncWindow',
    'PricingRecommendation'
  ];
BEGIN
  IF use_managed_runtime_logins THEN
    system_role := 'meridian-app-system';
    tenant_role := 'meridian-app-tenant';
  ELSE
    IF NOT can_create_roles THEN
      RAISE EXCEPTION
        'Tenant RLS requires meridian-app-system and meridian-app-tenant runtime logins, or a migration role with CREATEROLE.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_system') THEN
      CREATE ROLE meridian_system NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_tenant') THEN
      CREATE ROLE meridian_tenant NOLOGIN;
    END IF;
    GRANT meridian_system TO CURRENT_USER;
    GRANT meridian_tenant TO CURRENT_USER;
    system_role := 'meridian_system';
    tenant_role := 'meridian_tenant';
  END IF;

  EXECUTE format('GRANT SELECT ON TABLE "ExchangeRate" TO %I', tenant_role);

  FOREACH table_name IN ARRAY shop_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO %I USING (true) WITH CHECK (true)',
      'meridian_system_all', table_name, system_role
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I TO %I USING ("shopId" = NULLIF(current_setting(''meridian.shop_id'', true), '''')) WITH CHECK ("shopId" = NULLIF(current_setting(''meridian.shop_id'', true), ''''))',
      'meridian_tenant_shop', table_name, tenant_role
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', table_name, system_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', table_name, tenant_role);
  END LOOP;

  ALTER TABLE "Shop" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "Shop" FORCE ROW LEVEL SECURITY;
  EXECUTE format(
    'CREATE POLICY %I ON "Shop" TO %I USING (true) WITH CHECK (true)',
    'meridian_system_all', system_role
  );
  EXECUTE format(
    'CREATE POLICY %I ON "Shop" TO %I USING ("id" = NULLIF(current_setting(''meridian.shop_id'', true), '''')) WITH CHECK ("id" = NULLIF(current_setting(''meridian.shop_id'', true), ''''))',
    'meridian_tenant_shop', tenant_role
  );
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Shop" TO %I', system_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Shop" TO %I', tenant_role);

  ALTER TABLE "ShopMembership" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "ShopMembership" FORCE ROW LEVEL SECURITY;
  EXECUTE format(
    'CREATE POLICY %I ON "ShopMembership" TO %I USING (true) WITH CHECK (true)',
    'meridian_system_all', system_role
  );
  EXECUTE format(
    'CREATE POLICY %I ON "ShopMembership" TO %I USING ("shopId" = NULLIF(current_setting(''meridian.shop_id'', true), '''') AND "userId" = NULLIF(current_setting(''meridian.user_id'', true), '''')) WITH CHECK ("shopId" = NULLIF(current_setting(''meridian.shop_id'', true), '''') AND "userId" = NULLIF(current_setting(''meridian.user_id'', true), ''''))',
    'meridian_tenant_membership', tenant_role
  );
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShopMembership" TO %I', system_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShopMembership" TO %I', tenant_role);
END
$$;

-- Identity, provider, session, one-time-code, operator, rate-limit and Shopify
-- session tables intentionally receive no tenant grants. They are reachable
-- only through the system authentication/operations client.
