# Launch readiness matrix

**Authoritative status as of 2026-08-12.** This matrix supersedes dated
snapshots elsewhere in the repository when they disagree. A local or
disposable-environment pass is not a production claim. The draft PR remains
unmerged and no production service, App Store submission, payment, or legal
attestation has been made.

## Owner decisions recorded

The release architecture is now selected, but none of these external resources
is configured yet: MyMeridian / Meridian, individual publisher, production
`mymeridian.io`, staging `staging.mymeridian.io`, Fly.io app hosting (initial
production target: shared-cpu-2x / 2 GB in `iad`), Fly Managed Postgres Basic,
Upstash Redis, Resend, Twilio Verify, Google/Apple web sign-in, Meta/Google Ads/
TikTok Ads, and ShipStation. `hello@mymeridian.io` and
`support@mymeridian.io` are planned addresses only until the domain and email
service are configured. Details and owner-side instructions are in
[EXTERNAL_CONFIGURATION.md](EXTERNAL_CONFIGURATION.md).

The approval gates remain separate: **PR merge → staging deployment →
production deployment → Shopify submission → public launch**. No later gate is
implied by an earlier one.

## Latest verification record

- `npm run ci`: 1,173 passing tests, 74 opt-in integration tests skipped by
  the default suite, 80.71% statement/line coverage; TypeScript, production
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
| Production Postgres, separate application roles and secret vault | **NEEDS CONNOR — account/payment/provisioning** | Fly Managed Postgres Basic in `iad` is selected. Provision distinct staging/production clusters and roles; create `meridian_app_system` and `meridian_app_tenant` exactly as [DATABASE_SECURITY.md](DATABASE_SECURITY.md), then set `DATABASE_URL`, `MERIDIAN_TENANT_DATABASE_URL` and `DIRECT_DATABASE_URL`. |
| Production Redis | **NEEDS CONNOR — account/provisioning** | Upstash is selected; begin on its free tier only if staging proves it adequate for queues, rate limits and durability. Provision separate staging/production databases and set distinct `MERIDIAN_REDIS_URL` values. |
| Domain, TLS and public origin | **WAITING FOR `mymeridian.io`** | Production is `https://mymeridian.io`; staging is `https://staging.mymeridian.io`. Do not register callbacks or change Shopify production configuration until the domain is purchased, DNS is controlled and each HTTPS origin is live. Production readiness fails closed on placeholder/local origins. |
| Auth delivery providers | **NEEDS CONNOR — account/provisioning** | Resend (free tier initially) and Twilio Verify are selected. Configure separate staging/production credentials, verify domain DNS, and prove controlled real email/SMS delivery. Shopify-embedded merchants do not receive redundant standalone SMS challenges. |
| Operator identity | **NEEDS CONNOR — decision/account/payment/legal** | Run `npm run operator:provision -- <publisher-email>` in a private terminal, enroll the TOTP secret, and store the generated values only in the vault/offline recovery process. |
| Production deployment | **NEEDS CONNOR — explicit Gate 3 approval** | Fly.io is selected, initially shared-cpu-2x / 2 GB. Do not deploy production until staging acceptance has passed and Connor explicitly authorizes Gate 3. Follow [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md). |
| Production backup and restore drill | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Configure encrypted backups, retention and least-privilege restore access on the chosen managed Postgres provider; execute and record a restore drill following [BACKUP_RESTORE_RUNBOOK.md](BACKUP_RESTORE_RUNBOOK.md). |
| Production monitoring and alerts | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Connect HTTP/database/Redis/queue/provider alert delivery, configure alert destinations and escalation, deliberately trigger controlled failures, then verify delivery and recovery. |
| Production load/soak and capacity gate | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Against authorized staging with production-equivalent app, database and Redis, run the defined 30-minute soak in [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) and record p50/p95/p99, errors, memory, CPU, database connections, queue depth and webhook lag. |
| Production security acceptance | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Run `/readyz`, `npm run operator:verify-live`, authenticated Shopify install, cross-role checks, session/cookie TLS checks and deployment bundle checks against the actual release. |
| Shopify app registration, billing charge authorization and App Store account state | **NEEDS CONNOR — payment/explicit authorization** | Public distribution and individual publisher are selected. Connor's associated-account confirmation is recorded owner-side. The $19 registration fee is approved in principle but must not be initiated until Connor explicitly authorizes that exact step. |
| Shopify OAuth, webhooks, billing and full-history import | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Install the deployed app on a controlled development store; verify OAuth, charge approval/decline, webhook HMAC/delivery, uninstall/reinstall, scope updates and real import/recovery. |
| Protected Customer Data scope for ShopifyQL-dependent shipping and Shop Campaigns functionality | **WAITING FOR `mymeridian.io` + Shopify approval** | `read_reports` is already requested, but ShopifyQL requires separate Level 2 approval covering name, address, phone and email. This gates `shipping_labels` and `shop_campaign_insights`; Shop Campaigns code is present but pauses truthfully until Shopify approves it. Request only the fields Shopify requires; disclose that MyMeridian queries only aggregate Shop Campaign metrics and does not query, retain or use shopper identity. Keep `read_all_orders` correctly supported. Then verify a controlled store with no campaigns, active campaigns, a zero-spend result, denied access, and a late report restatement before calling it live. |
| Meta, Google Ads and TikTok OAuth connector lifecycle | **NEEDS CONNOR — accounts/provider approval** | Provider applications are approved for creation, but no production callbacks may be registered before `mymeridian.io` exists. Then test connect → authorize → select account → encrypted storage → ingestion/refresh → disconnect/revoke → reconnect using controlled accounts. |
| ShipStation provider lifecycle | **NEEDS CONNOR — controlled test account/access** | ShipStation is a launch requirement. Obtain a controlled non-customer test account/API credential and prove connection, label ingestion, reconciliation, void/refund/update, disconnect/reconnect and recovery. |
| Shopify App Store listing and reviewer package | **NEEDS CONNOR — decision/account/payment/legal** | Finalize legal pages, support contact, listing copy/screenshots, reviewer instructions and accurate disclosure of scope/connector availability; use [SHOPIFY_SUBMISSION_PACKET.md](SHOPIFY_SUBMISSION_PACKET.md) and submit only after deployed acceptance evidence exists. |
| Built for Shopify status | **NEEDS EXTERNAL APPROVAL — Shopify/provider action** | First launch, reach Shopify’s then-current usage/review thresholds, satisfy the program requirements in production, and apply for Shopify review. No eligibility claim is authorized before that. |

## Deterministic release order

1. Connor purchases and controls `mymeridian.io`; then create DNS for
   `staging.mymeridian.io` and the production root. Do not register callbacks
   against any temporary production domain.
2. Connor creates the selected accounts and supplies only the staging
   credentials through the approved secret path. The PR remains unmerged until
   explicit Gate 1 approval.
3. After explicit Gate 1 and Gate 2 approvals, provision staging Postgres roles,
   Upstash, backups and monitoring; deploy the reviewed draft PR to staging.
4. Apply migrations from the direct migration connection; run `/readyz` and
   the operator acceptance script before routing traffic.
5. Install on a controlled Shopify development store and complete billing,
   webhook, import, scope, connector and uninstall/reinstall verification.
6. Run staging load/soak and restore drill; remediate any failed target.
7. Stop for explicit Gate 3 before production, Gate 4 before Shopify
   submission, and Gate 5 before any additional public activation. Production
   launch happens only after all production-verification rows above pass.
