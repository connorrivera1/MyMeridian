# PostgreSQL tenant isolation

MyMeridian uses two database identities. `DATABASE_URL` is privileged and is
reserved for migrations, authentication, background workers, webhooks and the
publisher operator dashboard. `MERIDIAN_TENANT_DATABASE_URL` is used for every
merchant-facing data route. It must be a separate login with no ownership,
superuser or `BYPASSRLS` privilege.

Migrations `20260812001000_tenant_row_level_security` and
`20260812013000_system_runtime_role_privileges` force RLS on every merchant
table and give the system identity the required runtime privileges without
making it a database owner. On PostgreSQL providers that permit role creation,
the migrations use NOLOGIN group roles. Fly Managed Postgres forbids custom
role creation, so it uses the two separately provisioned runtime logins
directly.

For Fly Managed Postgres, create two **Writer** users in the cluster dashboard
or with `fly mpg users create`. Fly user names may use lowercase alphanumerics
and hyphens only, so the required names are `meridian-app-system` and
`meridian-app-tenant`. Let Fly generate passwords; attach their pooled URLs to
`DATABASE_URL` and `MERIDIAN_TENANT_DATABASE_URL`, and store the migration
owner's direct URL in `DIRECT_DATABASE_URL`. These values belong only in Fly
secrets.

For providers that allow PostgreSQL role management, provision the two runtime
logins with vault-generated passwords (never in this repository):

```sql
CREATE ROLE "meridian-app-system"
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  INHERIT
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD '<vault-generated-password>';
GRANT CONNECT ON DATABASE meridian TO "meridian-app-system";
GRANT USAGE ON SCHEMA public TO "meridian-app-system";
GRANT meridian_system TO "meridian-app-system";
```

```sql
CREATE ROLE "meridian-app-tenant"
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD '<vault-generated-password>';
GRANT CONNECT ON DATABASE meridian TO "meridian-app-tenant";
GRANT USAGE ON SCHEMA public TO "meridian-app-tenant";
GRANT meridian_tenant TO "meridian-app-tenant";
```

If the managed service database name is not `meridian`, change only the
`GRANT CONNECT` target. Put the tenant connection string in
`MERIDIAN_TENANT_DATABASE_URL`, the system connection string in `DATABASE_URL`,
and reserve `DIRECT_DATABASE_URL` for the migration endpoint.

On Fly Managed Postgres, each merchant transaction uses the dedicated tenant
login directly. Local and integration environments explicitly assume
`meridian_tenant` to exercise the same policy. `/readyz` fails closed unless
both URLs are configured with different database usernames in production. It also
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
