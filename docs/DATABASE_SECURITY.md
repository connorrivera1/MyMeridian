# PostgreSQL tenant isolation

MyMeridian uses two database identities. `DATABASE_URL` is privileged and is
reserved for migrations, authentication, background workers, webhooks and the
publisher operator dashboard. `MERIDIAN_TENANT_DATABASE_URL` is used for every
merchant-facing data route. It must be a separate login with no ownership,
superuser or `BYPASSRLS` privilege.

Migrations `20260812001000_tenant_row_level_security` and
`20260812013000_system_runtime_role_privileges` create the NOLOGIN group roles,
force RLS on every merchant table, and give the system group the runtime table
privileges it needs without making the application login a database owner.
Provision the two production logins once, using passwords generated and stored
in the platform secret vault (never in this repository):

```sql
CREATE ROLE meridian_app_system
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  INHERIT
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD '<vault-generated-password>';
GRANT CONNECT ON DATABASE meridian TO meridian_app_system;
GRANT USAGE ON SCHEMA public TO meridian_app_system;
GRANT meridian_system TO meridian_app_system;
```

```sql
CREATE ROLE meridian_app_tenant
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD '<vault-generated-password>';
GRANT CONNECT ON DATABASE meridian TO meridian_app_tenant;
GRANT USAGE ON SCHEMA public TO meridian_app_tenant;
GRANT meridian_tenant TO meridian_app_tenant;
```

If the managed service database name is not `meridian`, change only the
`GRANT CONNECT` target. Put the tenant connection string in
`MERIDIAN_TENANT_DATABASE_URL`, the system connection string in `DATABASE_URL`,
and reserve `DIRECT_DATABASE_URL` for the migration endpoint.

Each merchant transaction explicitly assumes `meridian_tenant`; the login
cannot query merchant tables before that role switch. `/readyz` fails closed
unless both URLs are configured with different database usernames in
production. It also
executes a live isolation probe: the tenant connection must see no shop for a
sentinel tenant and must be denied access to the `User` identity table.

## Operational checks

After every schema change:

1. Add every new table containing `shopId` to the RLS migration introduced by
   that change; do not wait for a later cleanup migration.
2. Run the integration suite against a freshly migrated, disposable PostgreSQL
   database. `tenant-rls.integration.test.ts` proves cross-store reads, inserts,
   updates and deletes are blocked and that memberships require both user and
   shop context.
3. Confirm `/readyz` reports `tenantIsolation: "enforced"` before routing
   traffic.
4. Never grant the tenant login membership in `meridian_system`, table-owner
   status, superuser, or `BYPASSRLS`. Never grant the system login table-owner,
   superuser, or `BYPASSRLS` either.

Do not use Prisma Studio with the tenant URL for support work. The operator
dashboard is the approved, audited support surface and intentionally has no
arbitrary database editor.
