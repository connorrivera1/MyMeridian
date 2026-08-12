# PostgreSQL tenant isolation

MyMeridian uses two database identities. `DATABASE_URL` is privileged and is
reserved for migrations, authentication, background workers, webhooks and the
publisher operator dashboard. `MERIDIAN_TENANT_DATABASE_URL` is used for every
merchant-facing data route. It must be a separate login with no ownership,
superuser or `BYPASSRLS` privilege.

Migration `20260812001000_tenant_row_level_security` creates the NOLOGIN group
roles, forces RLS on every merchant table, and grants the migration owner the
system and tenant groups. Provision the production login once, using a password
generated and stored in the platform secret vault (never in this repository):

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
`GRANT CONNECT` target. Put the resulting connection string in
`MERIDIAN_TENANT_DATABASE_URL`. Keep `DATABASE_URL` on the worker/system login
and `DIRECT_DATABASE_URL` on the migration endpoint.

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
   status, superuser, or `BYPASSRLS`.

Do not use Prisma Studio with the tenant URL for support work. The operator
dashboard is the approved, audited support surface and intentionally has no
arbitrary database editor.
