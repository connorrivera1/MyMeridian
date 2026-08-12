# Launch readiness matrix

**Authoritative status as of 2026-08-12.** This matrix supersedes dated
snapshots elsewhere in the repository when they disagree. A local or
disposable-environment pass is not a production claim. The draft PR remains
unmerged and no production service, App Store submission, payment, or legal
attestation has been made.

## Latest verification record

- `npm run ci`: 1,172 passing tests, 74 opt-in integration tests skipped by
  the default suite, 80.68% statement/line coverage; TypeScript, production
  build and the 29-field server-configuration bundle scan passed.
- A fresh disposable PostgreSQL database accepted all 34 migrations. The real
  production-role isolation suite passed 7/7: two independently provisioned
  non-owner logins could not bypass tenant RLS, and the narrowly privileged
  system login remained functional. Test roles and database were destroyed.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- Local single-origin load test: 375 requests at concurrency 10, zero errors.
  p95 was 39 ms (`/healthz`), 34 ms (`/readyz`), 7 ms (`/`), 808 ms
  (`/app.data`), and 2,064 ms (`/app/orders.data`), under the 2,500 ms local
  gate. This is not capacity evidence for production.
- Browser smoke check: landing page and `/app` rendered on
  `http://127.0.0.1:3130`; the development-only Vite hot-reload WebSocket
  emitted a connection warning. It does not exist in the compiled production
  artifact.

## Matrix

| Area | Status | Evidence or exact next action |
| --- | --- | --- |
| Core profitability engine, materialized-read fallback, financial reconciliation | **DONE — code and required verification complete** | Canonical engine remains the source of truth; bounded/materialized reads have reconciliation and stale-data fallback coverage. |
| Merchant isolation and PostgreSQL RLS | **DONE — code and required verification complete** | 34 clean migrations plus real separate runtime tenant/system login tests passed. |
| Merchant session boundary, standalone MFA/reauth, operator MFA | **DONE — code and required verification complete** | Shopify embedded sessions remain distinct from cookie-authenticated web accounts; standalone mutations require same-origin checks, MFA and step-up reauthentication; operator uses password + replay-protected TOTP. |
| Rate limiting and repeated-request protection | **DONE — code and required verification complete** | Durable PostgreSQL limits cover public authentication/OAuth, operator access, every merchant mutation, billing, connector OAuth and exports. |
| Sensitive logs, secrets and client-bundle boundary | **DONE — code and required verification complete** | Production artifact scan passed; connector callback no longer preserves provider-controlled errors in logs or browser URLs. |
| Operator dashboard and no-PII-by-default support view | **DONE — code and required verification complete** | Route-isolation, MFA/audit, security-header and data-minimization tests pass. No arbitrary database editor or mutation routes exist. |
| Webhook, queue, backfill and recalculation recovery | **DONE — code and required verification complete** | Idempotency, leases, retry/recovery, duplicate delivery, stale-worker reclamation and alert coverage are in the test suite. |
| Current plan catalogue | **DONE — code and required verification complete** | Starter $49/$490, Growth $129/$1,290, Scale $299/$2,990; annual effective monthly amounts are $40.83/$107.50/$249.17. |
| Production Postgres, separate application roles and secret vault | **NEEDS CONNOR — decision/account/payment/legal** | Provision the managed database and vault; create `meridian_app_system` and `meridian_app_tenant` exactly as [DATABASE_SECURITY.md](DATABASE_SECURITY.md), then set `DATABASE_URL`, `MERIDIAN_TENANT_DATABASE_URL` and `DIRECT_DATABASE_URL`. |
| Production Redis | **NEEDS CONNOR — decision/account/payment/legal** | Provision Redis and set `MERIDIAN_REDIS_URL`; do not enable ad-ingestion claims until the deployment health checks and queue recovery have passed. |
| Domain, TLS and public origin | **NEEDS CONNOR — decision/account/payment/legal** | Choose and provision the stable HTTPS origin, then replace placeholder app URL, OAuth redirect URLs and Shopify webhook destination in Shopify configuration before deployment. |
| Auth delivery providers | **NEEDS CONNOR — decision/account/payment/legal** | Create/configure Resend and Twilio (or selected equivalent), place server credentials in the deployment vault, and send/verify real email and SMS codes using controlled accounts. |
| Operator identity | **NEEDS CONNOR — decision/account/payment/legal** | Run `npm run operator:provision -- <publisher-email>` in a private terminal, enroll the TOTP secret, and store the generated values only in the vault/offline recovery process. |
| Production deployment | **NEEDS CONNOR — decision/account/payment/legal** | Create the hosting account/app and authorize deployment. Follow [DEPLOY_PLAN.md](../DEPLOY_PLAN.md) through deploy, migration and release health verification; do not route Shopify traffic until `/readyz` is enforced. |
| Production backup and restore drill | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Configure encrypted backups, retention and least-privilege restore access on the chosen managed Postgres provider; execute and record a restore drill following [BACKUP_RESTORE_RUNBOOK.md](BACKUP_RESTORE_RUNBOOK.md). |
| Production monitoring and alerts | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Connect HTTP/database/Redis/queue/provider alert delivery, configure alert destinations and escalation, deliberately trigger controlled failures, then verify delivery and recovery. |
| Production load/soak and capacity gate | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Against authorized staging with production-equivalent app, database and Redis, run the documented 30-minute soak and record p50/p95/p99, errors, memory, CPU, database connections, queue depth and webhook lag. |
| Production security acceptance | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Run `/readyz`, `npm run operator:verify-live`, authenticated Shopify install, cross-role checks, session/cookie TLS checks and deployment bundle checks against the actual release. |
| Shopify app registration, billing charge authorization and App Store account state | **NEEDS CONNOR — decision/account/payment/legal** | Complete Partner/app registration and payment/identity requirements; authorize only the intended test or production billing steps. |
| Shopify OAuth, webhooks, billing and full-history import | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Install the deployed app on a controlled development store; verify OAuth, charge approval/decline, webhook HMAC/delivery, uninstall/reinstall, scope updates and real import/recovery. |
| Protected Customer Data scope for ShopifyQL-dependent shipping functionality | **NEEDS EXTERNAL APPROVAL — Shopify/provider action** | Submit Shopify’s scope request with accurate use-case/reviewer evidence. Do not advertise the dependent ShopifyQL functionality until Shopify approves it and the approved scope is verified on a development store. |
| Meta, Google Ads and TikTok OAuth connector lifecycle | **NEEDS CONNOR — decision/account/payment/legal** | Create provider applications, obtain approved credentials/developer token and register production callbacks. Then test connect → authorize → select account → encrypted storage → ingestion/refresh → disconnect/revoke → reconnect using controlled accounts. |
| ShipStation provider lifecycle | **NEEDS CONNOR — decision/account/payment/legal** | Obtain a controlled ShipStation account/API key and production webhook registration details; test encrypted storage, signed webhook processing, revoke/disconnect and reconnect. |
| Shopify App Store listing and reviewer package | **NEEDS CONNOR — decision/account/payment/legal** | Finalize legal pages, support contact, listing copy/screenshots, reviewer instructions and accurate disclosure of scope/connector availability; submit only after deployed acceptance evidence exists. |
| Built for Shopify status | **NEEDS EXTERNAL APPROVAL — Shopify/provider action** | First launch, reach Shopify’s then-current usage/review thresholds, satisfy the program requirements in production, and apply for Shopify review. No eligibility claim is authorized before that. |

## Deterministic release order

1. Connor provisions the production accounts, domain, secrets, provider apps and
   operator identity listed above.
2. Provision Postgres roles, Redis, backups and monitoring; deploy the reviewed
   draft PR after it is merged.
3. Apply migrations from the direct migration connection; run `/readyz` and
   the operator acceptance script before routing traffic.
4. Install on a controlled Shopify development store and complete billing,
   webhook, import, scope, connector and uninstall/reinstall verification.
5. Run staging load/soak and restore drill; remediate any failed target.
6. Finalize reviewer assets and submit to Shopify. Production launch happens
   only after Shopify approval and all production-verification rows above pass.
