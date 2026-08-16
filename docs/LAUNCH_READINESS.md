# Launch readiness matrix

**Authoritative status as of 2026-08-14.** This matrix supersedes dated
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
certificates now exist. `mymeridian-staging`, its Fly Machine, Fly Managed
Postgres and staging Upstash Redis are provisioned. Production secrets and the
live MyMeridian origin remain unprovisioned. The initial Fly target remains
shared-cpu-2x / 2 GB in `iad`.
Controlled delivery to `welcome@mymeridian.io`, `support@mymeridian.io` and
`eevee@mymeridian.io` has been verified. Details and owner-side instructions
are in [EXTERNAL_CONFIGURATION.md](EXTERNAL_CONFIGURATION.md).

The approval gates remain separate: **PR merge → staging deployment →
production deployment → Shopify submission → public launch**. No later gate is
implied by an earlier one.

## Latest verification record

- **Staging email identity acceptance (2026-08-13):** controlled Resend
  delivery accepted and arrived for `welcome@mymeridian.io`,
  `support@mymeridian.io` and `eevee@mymeridian.io`; each matching Reply-To
  value was verified. Microsoft 365 delivered all three aliases into the
  welcome mailbox. A received probe passed SPF, DKIM and DMARC. Microsoft 365
  `SendFromAliasEnabled` is deferred as a non-blocking post-launch operator
  convenience; it does not affect automated Resend sending or inbound routing.
- **Staging PostgreSQL role/RLS acceptance (2026-08-13):** real Fly
  `meridian-app-system` and `meridian-app-tenant` logins are non-superuser and
  non-`BYPASSRLS`. Synthetic tenant A/B data proved cross-store reads and
  writes are denied, identity rows are invisible and identity writes fail for
  the tenant login, while the system login retains intended worker access.
- **Staging PostgreSQL/RLS re-verification (2026-08-14):** release v62 has all
  41 migrations, and both real runtime logins remain non-superuser and
  non-`BYPASSRLS`. A clean-room live probe created two disposable shop/product
  fixtures, proved each tenant login saw only its own row and changed neither
  the other tenant's data, then removed the fixtures.
- **Staging Redis queue acceptance (2026-08-13):** authenticated TLS
  transport, disposable-job processing, intentional retry recovery and
  recovery of a leased job after a simulated worker stop all passed against
  the live staging Upstash instance. The isolated test queue was removed.
- **Staging required-secret/readiness gate (2026-08-14):** `/healthz` is
  healthy and `/readyz` proves database reachability and tenant isolation. It
  now fails closed unless the direct migration connection, public origin,
  support identity, waitlist-unsubscribe key, and matching HTTPS Shopify origin
  are configured. The staging Shopify credentials, operator configuration,
  Resend, Twilio, Meta and Google OAuth client credentials are installed
  server-side. The remaining connector secrets are the Google Ads developer
  token and TikTok's application credentials. Apple remains intentionally
  deferred.
- **Production launch-connector readiness gate (2026-08-14):** the production
  Fly configuration enables `MERIDIAN_REQUIRE_LAUNCH_CONNECTORS=true`. Before
  production can report ready, it must hold exactly `META_APP_ID`,
  `META_APP_SECRET`, `MERIDIAN_GOOGLE_ADS_CLIENT_ID`,
  `MERIDIAN_GOOGLE_ADS_CLIENT_SECRET`, `MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN`,
  `TIKTOK_APP_ID`, and `TIKTOK_APP_SECRET`. It also requires
  `MERIDIAN_REDIS_URL` and explicitly enables (and rejects a disabled) ads
  worker, so credentials
  cannot be present while connector ingestion is inert. This leaves staging
  able to prove its core readiness while provider enrollment is externally
  pending. Production also enables `MERIDIAN_REQUIRE_WEB_OAUTH=true`, so
  browser sign-in independently requires Google and Microsoft client IDs and
  secrets without burdening the staging readiness check. Apple remains the
  only intentionally deferred browser provider.
- **No-deploy production preflight (2026-08-14):**
  `npm run production:preflight` checks the canonical Fly/Shopify production
  configuration and the exact required Fly secret *names* without reading or
  printing secret values or deploying; public runtime settings are validated
  from `fly.toml`, not misclassified as secrets. `npm run
  production:preflight:config` verifies the checked-in configuration alone for
  CI/local use. The manifest requires the separate Google and Microsoft
  browser-sign-in credentials as well as the Google Ads connector credentials,
  so production cannot be called ready with either enabled sign-in path
  unintentionally absent.
- **Staging Google OAuth acceptance (2026-08-14):** the controlled test user
  is enrolled in Google’s testing audience. The MyMeridian Google Ads client
  has the exact staging and production connector callbacks and the `adwords`
  scope. The MyMeridian Web client now has the exact staging and production
  browser origins and callbacks. A real staging Google sign-in returned to
  MyMeridian and was stopped at the required MFA gate. Google consent remains
  in testing; no provider publishing action was taken.
- **Microsoft OAuth configuration (2026-08-14):** the MyMeridian staging app
  registration now contains the exact staging and production web callbacks.
  The live staging sign-in initiation correctly redirects to Microsoft; the
  production client ID and secret must still be installed directly in the
  production Fly secret store before any production release.
- **Ad-provider configuration audit (2026-08-14):** Meta’s existing
  MyMeridian app is in development, has no required-action notices, enforces
  HTTPS/strict OAuth redirects, and contains the exact staging and production
  Meta connector callbacks. Its app secret was entered directly into Fly's
  staging secret store and remains masked. Meta’s attached business portfolio is unverified, and
  Meta blocks its required tech-provider access verification until that
  owner-controlled business-verification process completes. Google Cloud’s
  MyMeridian Google Ads client has both callbacks and an enabled server-side
  secret, but Google Ads itself remains at initial business/campaign onboarding
  with no developer token. TikTok for Business registration is populated with
  accurate pre-launch information but remains unsubmitted; developer terms
  remain unaccepted. No provider publication, review, campaign, spend, terms
  acceptance, or secret reveal was performed.
- **Staging crawl-control acceptance (2026-08-14):** staging release v46
  serves `robots.txt` with `Disallow: /` and an empty sitemap. Both the
  crawl-control route and the live/ready health routes retain the required
  TLS security headers.
- **Staging redirect-security acceptance (2026-08-14):** release v47 closes
  the unauthenticated MFA redirect header gap. The live 302 now retains HSTS,
  `nosniff`, and the standard referrer policy.
- **Staging visual acceptance (2026-08-14):** the live landing page renders
  correctly at desktop and 390 px mobile widths. Mobile navigation retains the
  primary waitlist path, and the page emits no browser-console errors.
- **Staging accessibility acceptance (2026-08-14):** release v48 corrects
  low-contrast utility labels. The mobile audit now scores 100 for
  accessibility and 100 for browser best practices. Its SEO score remains
  intentionally reduced only because staging blocks indexing.
- **Staging light-theme acceptance (2026-08-14):** release v49 corrects the
  remaining low-contrast footer links in the alternate light theme. Both
  supported themes now pass the mobile accessibility and browser best-practice
  audits at 100.
- **Staging static-document security acceptance (2026-08-14):** release v50
  preserves the legal-card rendering and applies HSTS, `nosniff`, and the
  standard referrer policy to `privacy.html` and `terms.html`, closing the
  static-response header gap.
- **Staging public-document CSP acceptance (2026-08-14):** release v64
  enforces a strict Content Security Policy on the landing page, both legal
  cards, and waitlist confirmation/unsubscribe pages. Required inline scripts
  are hash-authorized from their exact document source; no unsafe inline script
  permission is present. Each page rendered in the live browser without a CSP
  violation or console error.
- **Staging response-boundary security acceptance (2026-08-14):** release v54
  applies the same transport baseline at the server response boundary. Live
  OAuth, connector, MFA, error and operator redirects now retain exactly one
  HSTS, `nosniff`, and appropriate referrer-policy value.
- **Staging auth-probe acceptance (2026-08-14):** release v55 returns a clean
  200 from `HEAD /auth/login` without invoking the browser-only Shopify login
  helper; the normal merchant GET and POST flow remains unchanged.
- **Staging HTTP/database soak acceptance (2026-08-14):** release v55 held a
  fixed machine for 1,802 seconds across 5,406 public, health, readiness,
  static-card, and auth-probe requests. p50/p95/p99 were 49/142/251 ms with
  no application HTTP failures. One client transport fetch failed without an
  HTTP response; the affected auth probe then completed 500 concurrent retry
  requests with zero failures (p95 129 ms). Redis queue work remains excluded
  because its provider quota is exhausted.
- **Staging Shopify lifecycle acceptance (2026-08-14):** release v68 added a
  fresh App Bridge bearer-token handoff for billing confirmation and restricts
  that top-level redirect to Shopify-owned hosts. A controlled development
  store completed install/OAuth return, Starter approval, Growth approval,
  declined upgrade, downgrade approval, signed subscription webhooks,
  uninstall/session clearing and reinstall. Shopify test charges completed the
  downgrade as an immediate replacement, so a real future-cycle transition
  remains a production-provider proof.
- **Staging backup readiness (2026-08-14):** Fly Managed Postgres exposes
  completed full and incremental recovery points. A fresh full staging backup
  and its following incremental recovery point both completed. An isolated
  restore remains intentionally pending because Fly restores into a separately
  billed cluster; the source cluster is never overwritten.
- **Staging load and runtime-recovery gate (2026-08-14):** 6,000 requests at
  concurrency 50 across `/healthz`, `/readyz` and `/` completed with zero
  failures; p95 was 172 ms, 426 ms and 406 ms respectively. A controlled
  staging-machine restart returned `/readyz` to ready. This is a finite
  baseline, not the required mixed authenticated 30-minute soak.
- **Staging release v65 regression load gate (2026-08-14):** after the
  connector-error redaction hardening and all current migrations were released,
  3,600 remote requests at concurrency 50 across `/healthz`, `/readyz` and
  `/` completed with zero failures. p95 was 280 ms, 367 ms and 399 ms
  respectively; `/readyz` remained below its 2.5-second gate. This verifies
  the current release's public/database path only; it does not substitute for
  the mixed authenticated/queue soak, which remains unavailable while Redis is
  quota-limited.
- **Staging release v68 regression load gate (2026-08-14):** after the
  embedded-billing handoff fix, 3,600 remote requests at concurrency 50 across
  `/healthz`, `/readyz` and `/` completed with zero failures. p95 was 293 ms,
  468 ms and 502 ms respectively; p99 remained below 1.1 seconds for every
  path. No server error appeared in the post-run logs. This is a public and
  database-path regression test, not a substitute for the mixed authenticated
  queue soak while Redis remains quota-limited.
- **Staging release v68 recovery gate (2026-08-14):** the single staging
  machine was restarted after the regression load. Its process returned, the
  platform health check recovered, and both `/healthz` and `/readyz` returned
  green with database reachability and tenant isolation enforced.
- **Staging Redis service gate (2026-08-14):** Upstash rejected further
  commands at its 500,000-request limit. Ad-polling workers are deliberately
  disabled in staging to stop retries while the provider quota is addressed.
  The deployed runtime now records only safe error classifications rather than
  serializing Redis/provider error objects. Redis-dependent connector polling,
  the full soak and final staging recovery remain blocked until the quota is
  restored through an owner-authorized provider action.
- **Staging release v69 readiness acceptance (2026-08-14):** the
  launch-connector readiness safeguard was released after all 41 migrations
  were confirmed current. Staging remains healthy because it does not opt into
  the production-only launch-connector switch; `/healthz` and `/readyz` both
  passed after the rollout.
- **Staging release v71 readiness acceptance (2026-08-14):** production now
  explicitly enables the ads worker, requires Redis, and rejects an override
  that disables ingestion whenever launch connectors are required. Staging v71
  is healthy with all 41 migrations current; `/healthz` and `/readyz` passed.
- **Staging release v72 security acceptance (2026-08-14):** a production
  readiness failure now returns only a generic configuration failure publicly;
  missing secret and provider names remain server-side diagnostics. Staging v72
  is healthy with all 41 migrations current; `/healthz` and `/readyz` passed.
- **Staging release v73 security acceptance (2026-08-14):** the final
  production build, dependency audit, full-history credential scan and static
  security scan passed before release. Staging v73 is healthy with all 41
  migrations current; `/healthz` and `/readyz` passed.
- **Staging release v75 preflight acceptance (2026-08-14):** the exact same
  production requirement manifest now powers runtime readiness and a
  no-deploy Fly inventory preflight. The configuration-only preflight,
  1,300-test CI suite, 76/76 real-database suite, audit, credential scan and
  static security scan passed. Staging v75 is healthy with all 41 migrations
  current; `/healthz` and `/readyz` passed.
- Current local verification (2026-08-15): `npm run ci` passed with **1,307
  executable tests**; **76** PostgreSQL integration cases remain opt-in when a
  disposable database is not configured. The production build and
  server/browser secret-boundary scan also passed. The separately recorded CI
  database gate applied all 41 migrations to a fresh disposable PostgreSQL
  instance, reported zero schema drift, and passed **76/76** real-database
  integration tests. This is staging/CI evidence only, not a claim about
  production infrastructure.
- Historical baseline: a fresh disposable PostgreSQL database accepted the
  prior 34 migrations and the real production-role isolation suite passed 7/7:
  two independently provisioned non-owner logins could not bypass tenant RLS,
  and the narrowly privileged system login remained functional. The live
  staging database is current through all 41 migrations; production-role proof
  remains a production-infrastructure gate.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- Current local full-history credential scan passed with the repository's
  `.gitleaks.toml`: 159 commits were scanned with no leaks. The only allowlist
  is the public Shopify application identifier in `shopify.app.toml`, never a
  client secret. The matching Semgrep rule set scanned 326 tracked files with
  271 applicable rules and 0 findings; the only excluded rule is Django's
  template-CSRF check, which is inapplicable to this React Router application.
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
- `shopify.app.production.toml` is structurally complete and contains only
  `https://mymeridian.io` plus `/auth/callback`; dev URL rewriting is disabled.
  The Shopify CLI is not installed in this checkout, so no current CLI
  validation claim is made. The default Shopify CLI config remains
  development-only. A separately issued production Shopify app draft now
  exists with its own client ID and the unique handle `mymeridian-1`; the
  checked-in production configuration uses that identity and staging cannot
  reuse it. Its client secret remains only in Shopify's credential vault, and
  has not been placed in Fly because the production app has no deployment.
  The irreversible public-distribution confirmation is paused, and no version,
  listing, review or submission has been released.
- Fly CLI validates both `fly.toml` and `fly.staging.toml`. The public Fly
  hostnames are attached to the correct isolated app records; all three
  Let’s Encrypt certificates are issued, verified and active through exact
  non-routing ACME CNAMEs. GoDaddy routing remains unchanged.

## Matrix

| Area | Status | Evidence or exact next action |
| --- | --- | --- |
| Core profitability engine, materialized-read fallback, financial reconciliation | **DONE — code and required verification complete** | Canonical engine remains the source of truth; bounded/materialized reads have reconciliation and stale-data fallback coverage. |
| Merchant isolation and PostgreSQL RLS | **DONE — staging acceptance** | Real separate runtime tenant/system login tests passed; live staging is current through 41 migrations. |
| Merchant session boundary, standalone MFA/reauth, operator MFA | **DONE — code and required verification complete** | Shopify embedded sessions remain distinct from cookie-authenticated web accounts; standalone mutations require same-origin checks, MFA and step-up reauthentication; operator uses password + replay-protected TOTP. |
| Rate limiting and repeated-request protection | **DONE — code and required verification complete** | Durable PostgreSQL limits cover public authentication/OAuth, operator access, every merchant mutation, billing, connector OAuth and exports. |
| Sensitive logs, secrets and client-bundle boundary | **DONE — code and required verification complete** | Production artifact scan passed; connector callback no longer preserves provider-controlled errors in logs or browser URLs. |
| Operator dashboard and no-PII-by-default support view | **DONE — code and required verification complete** | Route-isolation, MFA/audit, security-header and data-minimization tests pass. No arbitrary database editor or mutation routes exist. |
| Webhook, queue, backfill and recalculation recovery | **DONE — code and required verification complete** | Idempotency, leases, retry/recovery, duplicate delivery, stale-worker reclamation and alert coverage are in the test suite. |
| Current plan catalogue | **DONE — code and required verification complete** | Starter $49/$490, Growth $129/$1,290, Scale $299/$2,990; annual effective monthly amounts are $40.83/$107.50/$249.17. |
| Profit Data Quality | **DONE — code and local verification complete** | The merchant now sees categorical Complete / Strong / Partial / Limited quality with explicit Measured, Configured estimate and Missing reasons. It never turns unavailable input into zero or a false percentage. |
| Deterministic Action Center | **DONE — code and local verification complete** | Starter shows only data-quality guidance; Growth/Scale overview ranks at most five aggregate, evidence-backed loss, product, channel, fulfilment-projection and data-quality actions. Every card separates observed fact, likely explanation, suggested next step, confidence and evidence. |
| Recommendation decisions and outcomes | **DONE — code and local verification complete** | Dismissals are tenant-scoped and persist until a material impact bucket changes. Accepted pricing recommendations wait for a Shopify price change and a 28-day observation period; no causal outcome is claimed. |
| Staging Postgres, separate application roles and secret vault | **DONE — staging acceptance** | Fly Managed Postgres Basic `mymeridian-staging-db` is provisioned in `iad` with isolated `meridian` database and `meridian-app-system` / `meridian-app-tenant` runtime users. All 41 migrations, plus live cross-store/identity RLS proof, passed. Production remains unprovisioned. |
| Staging Redis queue | **BLOCKED — provider request quota exhausted** | Previous live TLS/authentication, BullMQ processing/retry and abandoned-lease recovery passed. Upstash has now rejected commands at the 500,000-request limit, so staging ad-polling workers are disabled. No provider plan, paid service or new database may be changed without owner authorization. Production Redis remains unprovisioned. |
| Domain, TLS and public origin | **STAGING READY — ROOT ROUTING PENDING** | `staging.mymeridian.io` is deployed over TLS. The apex still serves GoDaddy's temporary page over HTTPS. The three exact non-routing ACME CNAMEs are live and Fly’s apex, `www` and staging certificates are verified and active. Preserve every Microsoft 365 and Resend record. |
| Auth delivery providers | **DONE — staging acceptance** | Controlled real Resend inbox delivery, email identity/Reply-To routing, SPF/DKIM/DMARC and Twilio Verify SMS passed. `welcome@`, `support@` and `eevee@` send automatically through Resend and route inbound mail to welcome. Microsoft 365 alias send-as is deferred as a non-blocking operator convenience. Shopify-embedded merchants do not receive redundant standalone SMS challenges. |
| Operator identity | **STAGING CONFIGURED — authenticated acceptance pending** | The four operator secrets are installed in Fly staging; the public login page requires both password and TOTP and carries the isolated no-store/noindex response policy. The remaining test is `npm run operator:verify-live` in a private terminal with the owner-held acceptance password; never place that password in source, chat, or a browser URL. |
| Production deployment | **NEEDS CONNOR — explicit production Gate 3** | Fly CLI is authenticated and the production app record is reserved, but no production Machine, database or Redis service has been created. Staging is provisioned separately and remains the only deployed environment. Authorize production only after the staging acceptance gates and external provider approvals are complete. Follow [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md). |
| Production backup and restore drill | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Configure encrypted backups, retention and least-privilege restore access on the chosen managed Postgres provider; execute and record a restore drill following [BACKUP_RESTORE_RUNBOOK.md](BACKUP_RESTORE_RUNBOOK.md). |
| Production monitoring and alerts | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Connector-health alerts use the verified support inbox through Resend when no signed webhook is configured; a signed HTTPS webhook remains optional. Configure HTTP/database/Redis/queue/provider alert delivery and escalation, deliberately trigger controlled failures, then verify delivery and recovery on the production release. |
| Production load/soak and capacity gate | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Against authorized staging with production-equivalent app, database and Redis, run the defined 30-minute soak in [DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md) and record p50/p95/p99, errors, memory, CPU, database connections, queue depth and webhook lag. |
| Production security acceptance | **NEEDS PRODUCTION VERIFICATION — implementation exists but cannot be truthfully proven until deployed** | Startup rejects the staging Shopify public client for the production origin, and `/readyz` fails closed without the direct migration connection, public origin, support identity, waitlist-unsubscribe key, exact HTTPS origin match, all seven launch-provider credential fields, Redis, and an enabled ads worker. On the actual release, run `/readyz`, `npm run operator:verify-live`, authenticated Shopify install, cross-role checks, session/cookie TLS checks and deployment bundle checks. |
| Shopify app registration, billing charge authorization and App Store account state | **STAGING ACCEPTED — no submission** | App Store registration is paid and complete. The controlled development-store charge approval/decline lifecycle has passed in staging. Shopify review/submission and any production listing action remain intentionally unperformed. |
| Shopify OAuth, webhooks, billing and full-history import | **PRODUCTION APP DRAFT CONFIGURED — release and verification pending** | The separately issued production app has the exact production origin, embedded mode, `2026-07` webhook API version and `/auth/callback` staged. Its config uses a different client ID from staging, and the server fails closed if a production process is given the staging identity. Shopify currently marks `read_all_orders` as an additional scope requiring public-distribution selection and access approval; the irreversible distribution confirmation is paused. Before release, add the production app secret directly to the production Fly secret store, obtain Shopify scope/PCD approval, then install the deployed app on a controlled development store and verify OAuth, charge approval/decline, webhook HMAC/delivery, uninstall/reinstall, scope updates and real import/recovery. |
| Protected Customer Data scope for ShopifyQL-dependent shipping and Shop Campaigns functionality | **WAITING FOR `mymeridian.io` + Shopify approval** | `read_reports` is already requested, but ShopifyQL requires separate Level 2 approval covering name, address, phone and email. This gates `shipping_labels` and `shop_campaign_insights`; Shop Campaigns code is present but pauses truthfully until Shopify approves it. Request only the fields Shopify requires; disclose that MyMeridian queries only aggregate Shop Campaign metrics and does not query, retain or use shopper identity. Keep `read_all_orders` correctly supported. Then verify a controlled store with no campaigns, active campaigns, a zero-spend result, denied access, and a late report restatement before calling it live. |
| Meta, Google Ads and TikTok OAuth connector lifecycle | **NEEDS PROVIDER COMPLETION** | Meta is in development with no required actions, strict HTTPS OAuth, both exact callbacks and its app secret already stored directly in Fly staging. Its attached business portfolio is unverified, and Meta requires that owner-controlled process before tech-provider access verification. Google’s client has both callbacks and an enabled secret, but the Ads account is at manager-account creation with an unsolved provider CAPTCHA and no developer token; consent remains in testing. Google Ads account selection preserves the MCC identifier for a nested advertiser instead of incorrectly sending the advertiser as its own manager. For all three ad providers, switching advertiser accounts atomically clears the former account’s channel spend and sync ledger before a clean re-import, preventing mixed-account profitability data. TikTok is signed in but its developer registration requires business identity, email/SMS verification and acceptance of TikTok's developer terms before an app can exist. Once each provider completes those steps and its credentials are entered directly in Fly staging, test connect → authorize → select account → encrypted storage → ingestion/refresh → disconnect/revoke → reconnect using controlled accounts. |
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
