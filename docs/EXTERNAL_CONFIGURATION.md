# External configuration handoff

[`LAUNCH_READINESS.md`](LAUNCH_READINESS.md) is the source of truth for release
status. This document is a preparation-only inventory: it neither creates an
account nor authorizes a paid service, deployment, publication, attestation or
submission.

Use two isolated environments. Staging has its own domain, Fly app, PostgreSQL
cluster, Redis instance, Shopify development app/store and provider test
credentials. Production has its own values and never receives staging data,
cookies, OAuth clients, database roles, encryption keys or merchant/customer
data.

## Authoritative owner choices

- Product/public identity: **MyMeridian / Meridian**, published initially by
  Connor as an individual.
- Production origin: `https://mymeridian.io`; staging origin:
  `https://staging.mymeridian.io`. The domain is controlled at GoDaddy and the
  apex currently serves GoDaddy's temporary page; staging is deployed over
  verified TLS at `https://staging.mymeridian.io`. Controlled Microsoft 365
  inbound delivery and controlled Resend delivery have passed for the verified
  identities. Do not register production callbacks until the production Fly
  origin and TLS certificate are in use.
- Primary/welcome/support email: `welcome@mymeridian.io` is the primary
  mailbox. `support@mymeridian.io` and `eevee@mymeridian.io` route inbound
  mail to it; controlled automated Resend sends and matching Reply-To values
  passed for all three identities. The owner-side emergency phone remains
  private and must not enter this repository.
- Hosting: Fly.io, `iad`; initial production app target: shared-cpu-2x with
  2 GB RAM. This is an initial measured baseline, not a permanent size.
- Database: one Fly Managed Postgres **Basic** cluster per environment.
- Redis: one Upstash Redis database per environment, free tier first only if
  staging proves queue, rate-limit and durability needs are met.
- Email/MFA: Resend free tier first; Twilio Verify usage-based. The existing
  MFA boundary distinguishes embedded Shopify authentication, standalone
  MyMeridian accounts, and publisher/operator access. No redundant SMS MFA is
  applied to normal Shopify-embedded merchants.
- Distribution: public Shopify app. Built for Shopify is post-launch only.

These choices authorize preparation only. They do not authorize account
creation, payment, provider review, domain purchase, deployment, merge,
submission or publication.

## Canonical origins and callback paths

Choose the actual values before registering callbacks:

| Environment | Canonical origin | Required paths |
| --- | --- | --- |
| Staging | `https://staging.mymeridian.io` | `/auth/callback`, `/oauth/google/callback`, `/oauth/microsoft/callback`, `/oauth/apple/callback`, `/connections/meta/callback`, `/connections/google/callback`, `/connections/tiktok/callback`, `/webhooks/*` |
| Production | `https://mymeridian.io` | Same paths, on the production origin only |

Never set `APP_URL` to a different host. Leave it unset in production and use
`SHOPIFY_APP_URL` as the canonical origin. Production readiness now rejects
localhost, example and Shopify CLI placeholder origins. These URLs are a
registration matrix only until the domain/DNS/TLS step is complete.

## Account and credential matrix

All values below are deployment secrets, except public client IDs and Shopify
app URL/scopes. Store runtime secrets in the environment-specific hosting secret
store; keep recovery copies of long-lived encryption and operator secrets only
in Connor's approved password manager/vault. Never commit them, put them in the
browser bundle, issue tracker, screenshots or chat.

| Service / exact product | Account or product Connor needs | Cost / review | MyMeridian value(s) | Register / configure | Can happen before deployment? |
| --- | --- | --- | --- | --- | --- |
| **Fly.io Apps** | One Fly organization and two reserved apps: `mymeridian-staging` and `mymeridian-prod`, both targeting `iad` | Empty app records and included ingress IPs are unbilled; one always-on shared-cpu-2x / 2 GB Machine is currently $11.39/month at full-month uptime | Hosting deployment authorization; environment-scoped secret store | Attach each real custom domain and require HTTPS | Staging is deployed. The production app record and hostname attachments are reserved; production deployment remains Gate 3 only. |
| **Fly Managed Postgres** | One **Basic** cluster per environment, same region as its app | Starting production cluster about $38/month plus storage; payment/provisioning required | `DATABASE_URL` (system pooled), `MERIDIAN_TENANT_DATABASE_URL` (tenant pooled), `DIRECT_DATABASE_URL` (migration direct) | Create `meridian-app-system` and `meridian-app-tenant` exactly as `DATABASE_SECURITY.md`; keep migration owner separate; enable encrypted daily backups/PITR and record retention | Staging cluster and isolated runtime users are provisioned; role grants, URLs and deployment verification remain. Production is not provisioned. |
| **Upstash Redis** | One isolated Redis database per environment for BullMQ | Fly provisions pay-as-you-go at $0.20/100K commands; because BullMQ polls aggressively, use the predictable Fixed 250 MB plan at $10/month unless measured staging traffic proves a lower budgeted plan safe. Never enable the $200/month ProdPack or auto-upgrade without separate authorization. | `MERIDIAN_REDIS_URL` only | Separate credentials/prefixes; TLS; no staging/production sharing; tenant-safe cache keys only | Staging exists but its 500,000-request quota is exhausted; the production database is not provisioned. A plan or new database requires owner approval. |
| **Domain registrar + authoritative DNS** | Controlled `mymeridian.io`, with `staging.mymeridian.io` routing still to add | Purchase complete; no hosting cutover charge authorized here | No secret; DNS records and final `SHOPIFY_APP_URL` | Exact non-routing ACME CNAMEs are live; replace only apex web A records and add Fly AAAA at production cutover; preserve all mail records | **Controlled; apex, `www` and staging Fly certificates are verified and active. Deployed routing remains.** |
| **Resend Transactional Email** | Resend team, verified `mymeridian.io`, scoped staging/prod API keys | Free tier initially; upgrade only when actual limits require it | `RESEND_API_KEY`, `MERIDIAN_EMAIL_FROM` (`MyMeridian <welcome@mymeridian.io>` or a verified support sender) | Resend DKIM plus `send` MX/SPF resolve; confirm provider dashboard status and prove controlled email delivery in staging | Verified with controlled staging delivery from `welcome@`, `support@`, and `eevee@`; production values remain separate and unprovisioned. |
| **Twilio Verify** | Twilio account, restricted API key and separate staging/production Verify Services | Trial constrained; successful verifications are usage-billed | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_VERIFY_SERVICE_SID` | Configure SMS only for appropriate standalone-account enrollment/recovery; Fraud Guard, rate limits and allowed geographies; no callback required by this app | Staging service and controlled real SMS verification passed. Production service and values remain separate and unprovisioned. |
| **Shopify Partner Dashboard** | Connor's only Partner account; one staging/development app and the separate `MyMeridian` production app draft | Public distribution, registration and App Store review are external gates; $19 registration needs a separate explicit payment authorization | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | Production draft: `https://mymeridian.io`, `/auth/callback`, relative GDPR/webhook routes; production deploy sets `automatically_update_urls_on_dev = false` | The production draft has a distinct public client ID, but its secret remains only in Shopify and public distribution/release are intentionally paused. |
| **Meta for Developers / Marketing API** | Meta developer account and Marketing API app owned by Connor as the individual publisher | Access/review may be required for production access; Meta decision is external | `META_APP_ID`, `META_APP_SECRET` | Register separate staging/production redirects: `https://staging.mymeridian.io/connections/meta/callback` and `https://mymeridian.io/connections/meta/callback` if Meta permits both | App request: yes. Callback activation: after domain/TLS. |
| **Google Cloud + Google Ads manager account** | Google Cloud project with web OAuth client, plus a Google Ads manager account/API Center developer token | OAuth consent configuration and Google Ads developer-token access are external; production access level depends on Google review | `MERIDIAN_GOOGLE_ADS_CLIENT_ID`, `MERIDIAN_GOOGLE_ADS_CLIENT_SECRET`, `MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN` | Separate staging/production redirects at `/connections/google/callback`; use real `mymeridian.io` and monitored `support@mymeridian.io` only after both are live | Project/manager account: yes. Callback/production consent: after domain. |
| **TikTok for Business / Marketing API** | TikTok for Business developer/Marketing API app owned by Connor | Provider approval/access is external; any spend is subject to TikTok account terms | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | Separate staging/production redirects at `/connections/tiktok/callback` where TikTok permits | Account/app request: yes. Callback activation: after domain/TLS. |
| **Google Identity** | Google Cloud OAuth web client for MyMeridian standalone-account sign-in | Account normally free; consent-screen verification can be required depending on publishing/scopes | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Separate staging/production redirects at `/oauth/google/callback`; client secret stays server-side | Project/client: yes. Callback activation: after domain/TLS. |
| **Microsoft identity platform** | Microsoft Entra app registration for MyMeridian standalone-account sign-in | An app registration is normally free; choose accounts in any organizational directory and personal Microsoft accounts to support business and Microsoft 365 sign-in | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optional `MICROSOFT_TENANT_ID=common` | Configure the Web platform, register the exact staging/production redirects at `/oauth/microsoft/callback`, and keep the client secret server-side | App registration: yes. Callback activation: after domain/TLS. |
| **Apple Developer Program / Sign in with Apple** | Apple Developer membership, primary App ID, Services ID and Sign in with Apple private key | Membership/payment and Apple ownership are Connor decisions; no code attestation by this repo | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Register verified domains and separate staging/production return URLs at `/oauth/apple/callback`; private key stays server-side | Apple enrollment/App ID: yes. Website URLs: after domain/TLS. |
| **Operational/security alerts** | Initial recipient: `support@mymeridian.io` | Provider monitoring may be free/paid depending on selected service | Provider notification target; optional `CONNECTOR_ALERT_WEBHOOK_URL` + `CONNECTOR_ALERT_WEBHOOK_SECRET` | Configure Fly/Upstash/provider alerts to the monitored support mailbox. Connector-health alerts fall back to a transactional Resend message there; when the optional webhook is configured, it receives a signed HTTPS payload instead. | Recipient and mailbox: verified. End-to-end synthetic alert: staging. |
| **ShipStation test account** | Controlled ShipStation account and API credential for connector acceptance | Provider plan/access is external | Encrypted merchant-provided credential; no publisher-wide runtime secret | Configure test webhook if the controlled account supports it | Account: yes. Test after staging deploy. |

## Merchant-side Shopify Shop Campaigns

MyMeridian's Shop Campaigns source is distinct from any advertising used to
promote MyMeridian itself in the Shopify App Store. It reads only a merchant
store's aggregate ShopifyQL report through the existing Shopify installation;
it creates no ad account, OAuth callback, billing action, or paid charge.

- Query: `FROM shop_campaign_insights SHOW shop_campaign_ad_spend, shop_campaign_sales, shop_campaign_customers GROUP BY shop_campaign_name TIMESERIES day` with a bounded daily `SINCE` / `UNTIL` window, submitted through the Admin GraphQL `shopifyqlQuery` field.
- Shopify requirement: `read_reports` **and** Shopify Level 2 protected-customer-data approval covering name, address, phone, and email. `read_reports` alone is insufficient.
- Current external gate: Level 2 approval remains pending. The connector pauses with a merchant-visible needs-approval state after Shopify denies the query; it can be retried only after approval changes.
- Reporting contract: Shopify-reported sales, customers, ROAS and CAC-equivalent evidence remain aggregate/source-reported. They never overwrite or add to MyMeridian's order-attributed revenue, order count, new-customer count or CAC. Shopify documents Shop Campaign sales as excluding refunds; MyMeridian's order-derived revenue continues to process refunds separately.
- Required staging proof after approval: use a controlled store to verify no campaigns, active campaigns, an observed zero-spend campaign, denied/revoked reports access, a later ShopifyQL restatement, and tenant isolation. No production claim is authorized before those checks pass.

## Required production secret inventory

Set each value separately for staging and production. The first group is
mandatory for `/readyz`. Production sets
`MERIDIAN_REQUIRE_LAUNCH_CONNECTORS=true`, so its complete Meta, Google Ads and
TikTok credential group is mandatory for readiness; staging may omit an
externally pending provider without losing its core readiness proof. Production
also requires `MERIDIAN_REDIS_URL` and rejects
`MERIDIAN_ADS_WORKER_DISABLED=true`, preventing an otherwise configured
connector surface from launching with its ingestion worker paused.

| Group | Required values |
| --- | --- |
| Database and tenant boundary | `DATABASE_URL`, `MERIDIAN_TENANT_DATABASE_URL`, `DIRECT_DATABASE_URL` |
| Shopify | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` |
| Cryptography and abuse protection | `MERIDIAN_ENCRYPTION_KEY`, `MERIDIAN_CUSTOMER_ERASURE_KEY`, `MERIDIAN_RATE_LIMIT_KEY`, `MERIDIAN_SHOPIFY_BRIDGE_SESSION_KEY` |
| Publisher operator | `MERIDIAN_OPERATOR_EMAIL`, `MERIDIAN_OPERATOR_PASSWORD_HASH`, `MERIDIAN_OPERATOR_TOTP_SECRET`, `MERIDIAN_OPERATOR_SESSION_KEY` |
| Email and standalone-account MFA | `RESEND_API_KEY`, `MERIDIAN_EMAIL_FROM=MyMeridian <welcome@mymeridian.io>`, `MERIDIAN_PUBLIC_ORIGIN=https://mymeridian.io`, `MERIDIAN_WAITLIST_UNSUBSCRIBE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_VERIFY_SERVICE_SID` |
| Background work | `MERIDIAN_REDIS_URL`, `MERIDIAN_DEMO_MODE=false`, `NODE_ENV=production` |
| Ad connectors | `META_APP_ID`, `META_APP_SECRET`, optional `META_LOGIN_CONFIG_ID` for Facebook Login for Business, `MERIDIAN_GOOGLE_ADS_CLIENT_ID`, `MERIDIAN_GOOGLE_ADS_CLIENT_SECRET`, `MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` |
| Optional web sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optional `MICROSOFT_TENANT_ID=common`, `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |
| Legal/support and alerting | `MERIDIAN_SUPPORT_EMAIL=support@mymeridian.io`, `MERIDIAN_LEGAL_ENTITY=<Connor's legal name supplied privately at configuration time>`, `MERIDIAN_SUPPORT_URL`, optional `CONNECTOR_ALERT_WEBHOOK_URL`, `CONNECTOR_ALERT_WEBHOOK_SECRET` |

## Explicit stops

Connor has resolved the intended individual publisher, domains, providers,
support recipient and infrastructure baseline. Connor must still create/own the
remaining accounts, supply private legal-name/phone values at configuration
time, make the required provider/Shopify submissions, approve each
paid or irreversible action, provide reviewer credentials, and authorize Gates
1–5. This repository cannot truthfully create, attest to, pay for or approve
any of them.

Reference requirements: [Fly Managed Postgres](https://fly.io/docs/mpg/),
[Resend production access](https://resend.com/docs/knowledge-base/does-resend-require-production-approval),
[Twilio Verify](https://www.twilio.com/docs/verify/api/verification),
[Google Ads developer token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token),
[Microsoft OpenID Connect](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc),
[Apple web sign-in](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple),
and [Shopify protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).

For waitlist activation and the server-side Founding Merchant benefit, see
[`PRELAUNCH_WAITLIST.md`](PRELAUNCH_WAITLIST.md). The Resend key/sender and a
controlled inbox-delivery test are mandatory before the application can send a
waitlist welcome email; a branded queued receipt is not delivery proof.

## Historical staging-provisioning sequence

The completed staging sequence is retained as an audit record. It does not
authorize production deployment; step 7 remains subject to explicit Gate 3.

1. Connor signs in to Fly and explicitly authorizes the selected paid staging
   and production app/Postgres resources. No provisioning command runs before
   that authorization.
2. Deploy staging with `fly.staging.toml`, attach its certificate, and add only
   the exact confirmed `staging` DNS record; wait for HTTPS validation.
3. Confirm Resend's dashboard sees the already-resolving DKIM and `send`
   MX/SPF records. Prove controlled delivery to a mailbox Connor owns before
   treating either planned address as active.
4. Create the staging-only PostgreSQL, Upstash and secret sets; do not use
   production values or data.
5. Register the listed **staging** OAuth callbacks with each available provider.
   Do not register production callbacks or update Shopify production config
   until `https://mymeridian.io` itself is live and Connor authorizes the
   relevant gate.
6. Stop and obtain explicit Gate 1 (merge) and Gate 2 (staging deployment)
   approvals before merging PR #1 or deploying staging.
7. After Gate 3, deploy production, attach apex and `www` certificates, and
   perform only the DNS changes in `DOMAIN_CUTOVER.md`; do not touch any
   Microsoft 365 or Resend record.
