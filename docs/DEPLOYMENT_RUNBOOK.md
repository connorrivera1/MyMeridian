# Staging and production deployment runbook

This is a preparation-only runbook. Do not execute a paid, publishing or
external-state-changing command without Connor's authorization. The current
release status is in [`LAUNCH_READINESS.md`](LAUNCH_READINESS.md).

## Release inputs and hard stops

Before staging: explicit Gate 1 (merge) and Gate 2 (staging deployment)
approvals, a reviewed commit, clean CI, `https://staging.mymeridian.io`, isolated
Fly Managed Postgres Basic/Upstash, staging provider credentials, and a
controlled Shopify development store. Before production: explicit Gate 3,
the merged reviewed commit, `https://mymeridian.io`, completed production
account matrix, production secrets, encrypted daily backup/PITR retention,
monitored alerts, and the staging acceptance record. Never use production
customer data in staging.

Use `fly.staging.toml` for staging and `fly.toml` for production. The default
`shopify.app.toml` remains the tunnel-rewritten development configuration;
production validation and release must explicitly use
`shopify.app.production.toml` (`--config production`). A separate staging
Shopify app/client must be linked before Gate 2; never reuse the production
client id for staging. Domain cutover is governed by
[`DOMAIN_CUTOVER.md`](DOMAIN_CUTOVER.md).

## Clean-environment procedure

1. Create isolated Fly staging hosting, Fly Managed Postgres Basic and Upstash
   Fixed 250 MB. Do not enable Upstash auto-upgrade or ProdPack. Revisit the
   Redis plan only from measured staging command volume.
   Create separate system, tenant and migration database roles using
   `DATABASE_SECURITY.md`. Use the initial production target shared-cpu-2x /
   2 GB only as a measured baseline, not a capacity claim.
2. Create the staging secret set from `EXTERNAL_CONFIGURATION.md`. Generate
   cryptographic and operator values once in a private terminal; retain their
   recovery copies outside the deployment platform.
3. Build the candidate from a clean checkout: `npm ci`, `npm run ci`, then the
   real-Postgres integration suite against a disposable database. For a
   production candidate, run `npm run production:preflight:config` before any
   release command; after production secrets are entered directly into Fly, run
   `npm run production:preflight`. It validates only configuration and secret
   names, never secret values, and must pass before deployment. Record commit,
   test counts, migration count and dependency audit result.
4. Deploy the compiled release using the staging application configuration. The
   release command applies the checked-in migrations using `DIRECT_DATABASE_URL`.
   Do not expose traffic until migration and health checks finish.
5. Confirm HTTP/TLS headers, `/healthz`, and `/readyz`. `/readyz` must report
   ready, not merely answer HTTP 200. Confirm it rejects a missing secret, a
   placeholder origin and identical tenant/system database logins in a
   disposable check only; restore correct values immediately.
6. Verify database RLS with the real deployed roles: tenant A cannot read/write
   tenant B; the system role can execute only its intentionally privileged
   worker paths. Record the results without customer records.
7. Verify Redis with a synthetic queue claim, worker restart, expired-lease
   reclaim and alert. Do not enable connector polling until this is clean.
8. Use a controlled Shopify development store to install staging, complete
   onboarding, start an historical import, and verify status/retry behavior.
9. Complete the staging verification sequence below, then run the load/soak and
   backup restore drill. Resolve every failure before considering production.
10. For production, repeat steps 1–9 using production-only accounts/values.
    Validate `shopify.app.production.toml`, but release that Shopify
    configuration only after the Fly origin, custom-domain TLS and exact OAuth
    callback are live and Connor authorizes the action. Do not submit or publish
    from this procedure.

## Exact acceptance sequence

Run in this order against staging, then repeat against production after launch
authorization. Record timestamp, commit, actor, environment, result and
sanitized evidence for each item using
[`RELEASE_EVIDENCE_TEMPLATE.md`](RELEASE_EVIDENCE_TEMPLATE.md).

1. Migration: all expected migrations present; no drift; no failed release.
2. RLS: actual tenant and system runtime logins prove cross-store denial and
   intended worker access.
3. Redis: TLS/auth connection, enqueue, processing, retry, lease expiry and
   recovery after worker restart.
4. Secrets: `npm run production:preflight` passes against the intended Fly app;
   `/readyz` reports ready; production bundle scan finds no configured secret
   or server-only key name in public assets.
5. Health: `/healthz`, `/readyz`, TLS, HSTS/security headers, liveness check,
   logs and alert receiver work.
6. Shopify: controlled store install, embedded session, onboarding, scope
   display and clean denial path.
7. Import: historical import resumes after an intentional worker interruption;
   data completeness status becomes accurate.
8. Billing: selected plan approval, decline/cancel, return route, active-plan
   gating, upgrade/downgrade and webhook reconciliation. Use only explicitly
   authorized development/test or production charges.
9. Webhooks: valid delivery, invalid HMAC rejection, duplicate idempotency,
   retry, delayed delivery and durable recovery.
10. Uninstall/reinstall: revoke access, stop work, preserve only permitted
    records, reinstall and re-authorize cleanly.
11. GDPR: `customers/data_request`, `customers/redact`, and `shop/redact` with
    signed controlled payloads; verify erasure guard and no re-creation by
    delayed import/webhook.
12. Connectors: Meta, Google and TikTok connect → authorize → account select →
    encrypted storage → first sync → refresh → disconnect/revoke → reconnect.
    Mark each unavailable if its provider approval is incomplete.
13. Email/SMS: controlled email code, controlled E.164 number code, expired and
    replayed-code rejection, rate-limit behavior and delivery alert.
14. Monitoring: alert routing for readiness, database, Redis, queue, webhook,
    import and provider failures; acknowledge and clear every synthetic alert.
15. Backup/restore: execute `BACKUP_RESTORE_RUNBOOK.md` on an isolated restored
    cluster; record daily schedule, encryption, retention, access, RPO, RTO,
    restoration/verification evidence and incident owner; destroy the drill
    environment without exposing merchant PII.
16. Failure recovery: run the cases in the rollback table before launch.

## Load and soak plan

Run only against an authorized staging environment equivalent to production in
machine size, database plan/pool, Redis plan, region and release artifact. Use
synthetic or controlled-test stores only. `scripts/load-test.mjs` refuses a
remote target unless `LOAD_TEST_ALLOW_REMOTE=true`; that explicit switch is a
guard, not authorization.

| Phase | Traffic and duration | Required observations / pass gate |
| --- | --- | --- |
| Baseline | 5 minutes, 10 concurrent mixed anonymous/authenticated requests | zero 5xx; p95 under 1.5 s for data routes; no unbounded memory growth |
| Launch load | 15 minutes, 50 concurrent mixed requests plus 10 concurrent authenticated app-data requests | error rate below 1%; p95 below 2.5 s; p99 below 5 s; CPU below 75% sustained; memory below 75%; database connections below 70% pool; no rising queue lag |
| Soak | 30 minutes at 50 concurrent mixed requests, 10 authenticated users, periodic webhook duplicates and a resumable import | same latency/error targets; no lease stuck beyond its recovery window; no error/queue/memory trend; all synthetic jobs complete or recover |
| Recovery | Restart one worker and temporarily deny Redis in staging | website stays available; durable work resumes; alerts fire and resolve; no cross-tenant exposure or duplicate financial writes |

These are launch gates, not proven production capacity. Record actual percentiles,
host/database/Redis metrics, webhook lag, import duration and failure evidence;
do not claim production performance until the production-equivalent run occurs.

## Rollback and recovery

| Event | Immediate containment | Recovery / verification |
| --- | --- | --- |
| Bad deployment | Stop routing to the new release; keep database unchanged | Roll back to prior image; `/readyz`, Shopify install path and queue health must pass before traffic resumes |
| Failed migration | Keep the new app release out of traffic; do not manually edit production tables | Diagnose on restored/staging copy; use forward corrective migration or restore to new cluster. Never assume migration rollback is safe. |
| Database corruption | Freeze writes/queues and preserve evidence | Follow `BACKUP_RESTORE_RUNBOOK.md`: restore to new isolated cluster, validate keys/RLS/migrations/data, then controlled cutover |
| Redis outage | Pause connector polling/worker claims; retain web availability | Restore Redis/auth/network, reclaim leases from Postgres, verify queue depth reaches zero and alerts clear |
| Broken OAuth deployment | Disable new provider path and prevent repeat redirects | Restore prior provider configuration/release; verify exact callback origin and state/PKCE flow with controlled account |
| Billing regression | Disable affected paid action/plan transition, do not create additional charges | Restore tested release/config; reconcile subscription state and test approve/decline/return before re-enable |
| Webhook-processing failure | Keep receipts durable, pause destructive downstream processing if needed | Restore worker, replay idempotently from receipt ledger, verify invalid HMAC and duplicate behavior |
| Security incident | Follow `INCIDENT_RESPONSE.md`; revoke only in-scope credentials and preserve evidence | Patch through reviewed CI, rotate/re-authorize as needed, prove health/GDPR/queue recovery and record retrospective |

No production rollback deletes a database, secret, app, provider account or audit
record. Connor or the named incident commander authorizes each external
cutover, provider change and communication.
