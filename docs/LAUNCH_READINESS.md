# Launch readiness matrix

**Authoritative status as of 2026-08-12.** This matrix supersedes dated
snapshots elsewhere in the repository when they disagree. A local or
disposable-environment pass is not a production claim. The draft PR remains
unmerged and no production service, App Store submission, payment, or legal
attestation has been made.

## Owner decisions recorded

The release architecture is selected. `mymeridian.io` is controlled at
GoDaddy and currently serves its temporary page; Microsoft 365 and Resend mail
records resolve, but provider-dashboard status and actual delivery are not
inferred from DNS. Fly CLI is authenticated; the empty `mymeridian-prod` and
`mymeridian-staging` app records, included ingress IPs and three active TLS
certificates now exist. `staging.mymeridian.io`, Fly Machines, Fly Managed
Postgres, Upstash Redis, production secrets and the live MyMeridian origin
remain unprovisioned. The initial Fly target remains shared-cpu-2x / 2 GB in
`iad`.
`hello@mymeridian.io` and `support@mymeridian.io` are not treated as monitored
until controlled delivery is verified. Details and owner-side instructions are
in [EXTERNAL_CONFIGURATION.md](EXTERNAL_CONFIGURATION.md).

The approval gates remain separate: **PR merge → staging deployment →
production deployment → Shopify submission → public launch**. No later gate is
implied by an earlier one.

## Latest verification record

- Current local verification: `npm run typecheck`, the production build and
  `npm test -- --run` passed with **1,201 tests**; 74 PostgreSQL opt-in
  integration tests remain
  intentionally skipped without the dedicated disposable database URL. A new
  migration must still be exercised from an empty PostgreSQL database before
  any merge or staging gate.
- Historical baseline: a fresh disposable PostgreSQL database accepted the
  prior 34 migrations and the real production-role isolation suite passed 7/7:
  two independently provisioned non-owner logins could not bypass tenant RLS,
  and the narrowly privileged system login remained functional. Test roles and
  database were destroyed. The current 35-migration set, including action
  dismissals, still requires the same clean-database runtime-role rerun.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- Current local full-history credential scan passed with the repository's
  `.gitleaks.toml`; the only allowlist is the public Shopify application
  identifier in `shopify.app.toml`, never a client secret. The matching Semgrep
  rule set scanned 262 tracked files with 0 findings.
- Current local single-origin load test: 300 requests at concurrency 10, zero
  errors. p95 was 15 ms (`/healthz`), 32 ms (`/readyz`), 5 ms (`/`), and
  1,148 ms (`/app.data`), under the 2,500 ms local gate. This is not capacity
  evidence for production.
- Compiled-production smoke check: `/`, the landing stylesheet/favicon/hero
  asset, `/privacy.html`, `/terms.html`, `/support` and `/healthz` returned 200
  locally; the support route rendered `support@mymeridian.io` when configured,
  and `www` returned a 308 to the apex while preserving path/query. The landing
  rendered visually with its intended hierarchy. This is local proof, not a
  live-domain or Fly deployment claim.
- `shopify.app.production.toml` validates with no issues and contains only
  `https://mymeridian.io` plus `/auth/callback`; dev URL rewriting is disabled.
  The default Shopify CLI config remains development-only.
- Fly CLI validates both `fly.toml` and `fly.staging.toml`. The public Fly
  hostnames are attached to the correct isolated app records; all three
  Let’s Encrypt certificates are issued, verified and active through exact
  non-routing ACME CNAMEs. GoDaddy routing remains unchanged.

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
| Profit Data Quality | **DONE — code and local verification complete** | The merchant now sees categorical Complete / Strong / Partial / Limited quality with explicit Measured, Configured estimate and Missing reasons. It never turns unavailable input into zero or a false percentage. |
| Deterministic Action Center | **DONE — code and local verification complete** | Starter shows only data-quality guidance; Growth/Scale overview ranks at most five aggregate, evidence-backed loss, product, channel, fulfilment-projection and data-quality actions. Every card separates observed fact, likely explanation, suggested next step, confidence and evidence. |
| Recommendation decisions and outcomes | **DONE — code and local verification complete** | Dismissals are tenant-scoped and persist until a material impact bucket changes. Accepted pricing recommendations wait for a Shopify price change and a 28-day observation period; no causal outcome is claimed. |
| Production Postgres, separate application roles and secret vault | **NEEDS CONNOR — payment/provisioning authorization** | Fly Managed Postgres Basic in `iad` is selected. The current dashboard price is $38/month plus 10 GB at $0.28/GB ($40.80/month per cluster at full-month uptime). Provision distinct staging/production clusters and roles only after explicit authorization; create `meridian_app_system` and `meridian_app_tenant` exactly as [DATABASE_SECURITY.md](DATABASE_SECURITY.md), then set `DATABASE_URL`, `MERIDIAN_TENANT_DATABASE_URL` and `DIRECT_DATABASE_URL`. |
| Production Redis | **NEEDS CONNOR — payment/provisioning authorization** | Fly's Upstash integration starts at $0.20/100K commands and explicitly warns that BullMQ-style polling can run up pay-as-you-go usage. Use the predictable Fixed 250 MB plan at $10/month per environment, with no replicas, auto-upgrade or $200/month ProdPack; revisit only from measured staging traffic. Provision separate staging/production databases and set distinct `MERIDIAN_REDIS_URL` values. |
| Domain, TLS and public origin | **TLS READY — DEPLOYMENT/ROUTING PENDING** | The apex still serves GoDaddy's temporary page over HTTPS and staging does not resolve. The three exact non-routing ACME CNAMEs are live and Fly’s apex, `www` and staging certificates are verified and active. Leave routing unchanged until each app is deployed. Preserve every Microsoft 365 and Resend record. |
| Auth delivery providers | **NEEDS CONNOR — account/provisioning** | Resend (free tier initially) and Twilio Verify are selected. Configure separate staging/production credentials, verify domain DNS, and prove controlled real email/SMS delivery. Shopify-embedded merchants do not receive redundant standalone SMS challenges. |
| Operator identity | **NEEDS CONNOR — decision/account/payment/legal** | Run `npm run operator:provision -- <publisher-email>` in a private terminal, enroll the TOTP secret, and store the generated values only in the vault/offline recovery process. |
| Production deployment | **NEEDS CONNOR — payment authorization plus explicit Gate 2/3** | Fly CLI is authenticated and both empty app records are reserved, but no Machine, database or Redis service exists. One always-on shared-cpu-2x/2 GB `iad` Machine is currently $11.39/month at full-month uptime. Staging plus one Basic/10 GB Managed Postgres cluster and Fixed 250 MB Upstash is therefore $62.19/month before data transfer or other usage. No paid resource was provisioned. Authorize staging first, complete acceptance, then separately authorize production Gate 3. Follow [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md). |
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

1. Connor explicitly authorizes the selected staging Machine and Managed
   Postgres charges. Deploy staging first, then add only Fly's exact staging
   CNAME. Do not change the production apex or register production callbacks
   against a temporary host.
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

## Merchant decision system and plan matrix

| Plan | Merchant promise | Included capabilities |
| --- | --- | --- |
| Starter — $49/mo or $490/year | **Know the truth.** | Overview; profit per order; products and channels; costs and bundles; core Shopify integration; Meta, Google and TikTok connection paths; ShipStation and available Shopify Shipping costs; payment, shipping fallback, pick/pack and overhead estimates; Profit Data Quality; core missing-input alerts. |
| Growth — $129/mo or $1,290/year | **Know what to investigate or change.** | Everything in Starter; deterministic pricing recommendations; price-test/insufficient-data states; fulfilment forecast and capacity warnings; loss, product and channel diagnosis; proactive recommendations; recommendation decisions and outcome states; advanced acquisition economics only where authorised source data is actually available. |
| Scale — $299/mo or $2,990/year | **Operate at scale.** | Everything in Growth; multi-store portfolio and rollups; scheduled weekly profitability summaries; advanced CSV/accountant export; portfolio reporting and alerts. Priority support is not advertised until it can be delivered. |

### Confidence methodology

Confidence is categorical, not a synthetic percentage. **Measured** means an
authoritative source supplied the value (Shopify order/COGS, synchronized spend,
or observed carrier cost). **Configured estimate** means a merchant rule is in
use and remains an estimate even after confirmation. **Missing** means Meridian
does not know; the surface shows a dash/qualification rather than zero.

- **Complete:** all displayed inputs in the period are measured.
- **Strong:** core COGS and source data are complete, but one or more configured
  estimates remain.
- **Partial:** some COGS or another material source is unavailable.
- **Limited:** there are no orders, or every order is missing COGS.

### Decision evidence and restraint

The Action Center can produce only these recommendation types: aggregate
unprofitable orders (complete COGS); a bleeding product (complete COGS and not
classified strategic loss leader); a channel with negative contribution after
synchronized spend and complete COGS; observed-throughput fulfilment risk; and
data-completeness remediation. Lack of the required evidence creates no action
card. Pricing continues to use post-install observations, broken-fit/insufficient
data guards, the ±25% cap, contribution floor and explicit merchant approval.

### Usage protection recommendation

The currently enforced soft/hard monthly order policies are Starter
1,000/1,200, Growth 5,000/6,000 and Scale 20,000/24,000, with a $0.05 overage
above the soft threshold capped at $50. These are transparent billing safeguards,
not silent incomplete-calculation throttles. They require staging cost telemetry
for PostgreSQL, Redis, workers, exports and provider delivery before being
represented as final production economics; do not increase them simply to claim
“unlimited.”
