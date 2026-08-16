# Backup and restore runbook

MyMeridian's database contains merchant configuration, historical cost bases,
privacy-erasure guards, webhook receipts and connector ciphertext. Re-importing
Shopify orders does not recreate those records, so a tested database restore is
required.

## Verification record

On 2026-08-12, a local custom-format PostgreSQL backup was restored into an
isolated disposable database. Ten critical table/migration counts matched the
source, Prisma reported no schema drift, and the restored database contained all
source migration records. The temporary database was dropped and its dump moved
to Trash. This is code-path evidence only; the first production launch still
requires a Fly Managed Postgres point-in-time restore drill with retained
encryption keys and a recorded provider receipt, elapsed RPO/RTO and `/readyz`
result.

## Preconditions

- Fly Managed Postgres backups and point-in-time recovery are enabled and their
  retention window is recorded.
- `MERIDIAN_ENCRYPTION_KEY` and `MERIDIAN_CUSTOMER_ERASURE_KEY` are backed up in
  the approved secret vault separately from Postgres. Neither belongs in a DB
  dump or this repository.
- The operator has recorded the current migration, app release and database
  cluster identifiers.

## Quarterly restore drill

1. Restore the latest recovery point to a new, isolated cluster. Never overwrite
   the production cluster during a drill.
2. Attach a temporary MyMeridian app configured with the preserved external
   keys and no Shopify/webhook traffic.
3. Run `npx prisma migrate status`, then `npx prisma migrate deploy` only if the
   restored snapshot predates the current release.
4. Run the repository's data verification script and confirm row counts for
   shops, orders, cost history, customer-erasure guards, webhook events and
   pending jobs.
5. Boot the release, require `/readyz` to return 200, open a synthetic shop, and
   verify a connector ciphertext can be decrypted without printing its value.
6. Delete the temporary app and cluster after recording the provider restore
   receipt, recovery point, elapsed time, checks and any corrective actions.

## Production recovery

Contain writes, select a recovery point before corruption, restore to a new
cluster, apply only forward migrations, attach the application, validate
`/readyz`, then resume queues and Shopify traffic. Recompute materialized profit
after recovery. Keep the old cluster read-only until reconciliation and the
incident commander approve disposal.
