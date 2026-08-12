-- Database-enforced tenant isolation. The migration owner is granted the
-- system group for workers/auth/operator work; merchant requests switch to or
-- connect as meridian_tenant and must set a transaction-local shop id.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_system') THEN
    CREATE ROLE meridian_system NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_tenant') THEN
    CREATE ROLE meridian_tenant NOLOGIN;
  END IF;
END
$$;

GRANT meridian_system TO CURRENT_USER;
GRANT meridian_tenant TO CURRENT_USER;

-- Global exchange rates contain no tenant or customer information and are
-- read by profit calculations inside tenant transactions.
GRANT SELECT ON TABLE "ExchangeRate" TO meridian_tenant;

DO $$
DECLARE
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
  FOREACH table_name IN ARRAY shop_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO meridian_system USING (true) WITH CHECK (true)',
      'meridian_system_all', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I TO meridian_tenant USING ("shopId" = NULLIF(current_setting(''meridian.shop_id'', true), '''')) WITH CHECK ("shopId" = NULLIF(current_setting(''meridian.shop_id'', true), ''''))',
      'meridian_tenant_shop', table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO meridian_system', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO meridian_tenant', table_name);
  END LOOP;
END
$$;

-- Shop uses its primary key as the tenant discriminator.
ALTER TABLE "Shop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Shop" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meridian_system_all" ON "Shop" TO meridian_system
  USING (true) WITH CHECK (true);
CREATE POLICY "meridian_tenant_shop" ON "Shop" TO meridian_tenant
  USING ("id" = NULLIF(current_setting('meridian.shop_id', true), ''))
  WITH CHECK ("id" = NULLIF(current_setting('meridian.shop_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Shop" TO meridian_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "Shop" TO meridian_tenant;

-- Membership rows require both the active account and active shop. Merchant
-- code cannot enumerate another user's portfolio inside the same shop.
ALTER TABLE "ShopMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopMembership" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meridian_system_all" ON "ShopMembership" TO meridian_system
  USING (true) WITH CHECK (true);
CREATE POLICY "meridian_tenant_membership" ON "ShopMembership" TO meridian_tenant
  USING (
    "shopId" = NULLIF(current_setting('meridian.shop_id', true), '') AND
    "userId" = NULLIF(current_setting('meridian.user_id', true), '')
  )
  WITH CHECK (
    "shopId" = NULLIF(current_setting('meridian.shop_id', true), '') AND
    "userId" = NULLIF(current_setting('meridian.user_id', true), '')
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShopMembership" TO meridian_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ShopMembership" TO meridian_tenant;

-- Identity, provider, session, one-time-code, operator, rate-limit and Shopify
-- session tables intentionally receive no tenant grants. They are reachable
-- only through the system authentication/operations client.
