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
  `https://staging.mymeridian.io`. The domain is not yet purchased. Do not
  register production callbacks, set live Shopify configuration, or send email
  from either address until the relevant domain is controlled and verified.
- Planned general/support/emergency email: `hello@mymeridian.io` and
  `support@mymeridian.io`. They are not active yet. The owner-side emergency
  phone remains private and must not enter this repository.
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
| Staging | `https://staging.mymeridian.io` | `/auth/callback`, `/oauth/google/callback`, `/oauth/apple/callback`, `/connections/meta/callback`, `/connections/google/callback`, `/connections/tiktok/callback`, `/webhooks/*` |
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
| **Fly.io Apps** | One Fly organization and two apps: `mymeridian-staging` and final production app, both in `iad` | Compute is paid; no Shopify-style review | Hosting deployment authorization; environment-scoped secret store | Initial production VM: shared-cpu-2x / 2 GB. Attach each real custom domain and require HTTPS | Account/app names: yes. Domain attachment: after purchase. Deployment: only Gate 2/3 authorization. |
| **Fly Managed Postgres** | One **Basic** cluster per environment, same region as its app | Starting production cluster about $38/month plus storage; payment/provisioning required | `DATABASE_URL` (system pooled), `MERIDIAN_TENANT_DATABASE_URL` (tenant pooled), `DIRECT_DATABASE_URL` (migration direct) | Create `meridian_app_system` and `meridian_app_tenant` exactly as `DATABASE_SECURITY.md`; keep migration owner separate; enable encrypted daily backups/PITR and record retention | Account decision: resolved. Cluster/roles/URLs: only after provisioning. |
| **Upstash Redis** | One isolated Redis database per environment for BullMQ | Free tier first; upgrade requires evidence that limits, durability or workload are inadequate and Connor authorization if paid | `MERIDIAN_REDIS_URL` only | Separate credentials/prefixes; TLS; no staging/production sharing; tenant-safe cache keys only | Account can be created now; database credentials after creation; no traffic until staging Gate 2. |
| **Domain registrar + authoritative DNS** | `mymeridian.io`, with `staging.mymeridian.io` DNS record | Domain purchase is an owner/payment action | No secret; DNS records and final `SHOPIFY_APP_URL` | Add Fly and Resend verification records exactly as supplied; Fly validates TLS after DNS propagates | **Waiting for Connor to purchase/control domain.** |
| **Resend Transactional Email** | Resend team, verified `mymeridian.io`, scoped staging/prod API keys | Free tier initially; upgrade only when actual limits require it | `RESEND_API_KEY`, `MERIDIAN_EMAIL_FROM` (`MyMeridian <hello@mymeridian.io>` or a verified support sender) | Add Resend DNS records; verify sender/domain; prove controlled email delivery in staging | Account: yes. Domain verification/sender: after purchase. |
| **Twilio Verify** | Twilio account, restricted API key and separate staging/production Verify Services | Trial constrained; successful verifications are usage-billed | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_VERIFY_SERVICE_SID` | Configure SMS only for appropriate standalone-account enrollment/recovery; Fraud Guard, rate limits and allowed geographies; no callback required by this app | Account/service: yes. Real controlled SMS test: after staging deploy. |
| **Shopify Partner Dashboard** | Connor's only Partner account; one staging/development app and one production public app | Public distribution, registration and App Store review are external gates; $19 registration needs a separate explicit payment authorization | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | Production app: `https://mymeridian.io`, `/auth/callback`, relative GDPR/webhook routes; production deploy sets `automatically_update_urls_on_dev = false` | Staging app: yes. Production URLs/config/registration payment: after domain and explicit approval. |
| **Meta for Developers / Marketing API** | Meta developer account and Marketing API app owned by Connor as the individual publisher | Access/review may be required for production access; Meta decision is external | `META_APP_ID`, `META_APP_SECRET` | Register separate staging/production redirects: `https://staging.mymeridian.io/connections/meta/callback` and `https://mymeridian.io/connections/meta/callback` if Meta permits both | App request: yes. Callback activation: after domain/TLS. |
| **Google Cloud + Google Ads manager account** | Google Cloud project with web OAuth client, plus a Google Ads manager account/API Center developer token | OAuth consent configuration and Google Ads developer-token access are external; production access level depends on Google review | `MERIDIAN_GOOGLE_ADS_CLIENT_ID`, `MERIDIAN_GOOGLE_ADS_CLIENT_SECRET`, `MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN` | Separate staging/production redirects at `/connections/google/callback`; use real `mymeridian.io` and monitored `support@mymeridian.io` only after both are live | Project/manager account: yes. Callback/production consent: after domain. |
| **TikTok for Business / Marketing API** | TikTok for Business developer/Marketing API app owned by Connor | Provider approval/access is external; any spend is subject to TikTok account terms | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | Separate staging/production redirects at `/connections/tiktok/callback` where TikTok permits | Account/app request: yes. Callback activation: after domain/TLS. |
| **Google Identity** | Google Cloud OAuth web client for MyMeridian standalone-account sign-in | Account normally free; consent-screen verification can be required depending on publishing/scopes | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Separate staging/production redirects at `/oauth/google/callback`; client secret stays server-side | Project/client: yes. Callback activation: after domain/TLS. |
| **Apple Developer Program / Sign in with Apple** | Apple Developer membership, primary App ID, Services ID and Sign in with Apple private key | Membership/payment and Apple ownership are Connor decisions; no code attestation by this repo | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Register verified domains and separate staging/production return URLs at `/oauth/apple/callback`; private key stays server-side | Apple enrollment/App ID: yes. Website URLs: after domain/TLS. |
| **Operational/security alerts** | Initial recipient: `support@mymeridian.io` after its mailbox is live | Provider monitoring may be free/paid depending on selected service | Provider notification target; current connector code additionally supports `CONNECTOR_ALERT_WEBHOOK_URL` + `CONNECTOR_ALERT_WEBHOOK_SECRET` | Configure Fly/Upstash/provider alerts to the monitored support mailbox. The application connector-alert path requires a signed HTTPS webhook, not a bare email address; select an email-capable alert receiver/bridge before enabling it | Recipient decision: resolved. Mailbox/receiver: after domain. End-to-end test: staging. |
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
mandatory for `/readyz`; provider groups are mandatory only when that feature is
enabled, but a connector must not be marketed as live before its group is set
and verified.

| Group | Required values |
| --- | --- |
| Database and tenant boundary | `DATABASE_URL`, `MERIDIAN_TENANT_DATABASE_URL`, `DIRECT_DATABASE_URL` |
| Shopify | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` |
| Cryptography and abuse protection | `MERIDIAN_ENCRYPTION_KEY`, `MERIDIAN_CUSTOMER_ERASURE_KEY`, `MERIDIAN_RATE_LIMIT_KEY` |
| Publisher operator | `MERIDIAN_OPERATOR_EMAIL`, `MERIDIAN_OPERATOR_PASSWORD_HASH`, `MERIDIAN_OPERATOR_TOTP_SECRET`, `MERIDIAN_OPERATOR_SESSION_KEY` |
| Mandatory web-account MFA | `RESEND_API_KEY`, `MERIDIAN_EMAIL_FROM`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_VERIFY_SERVICE_SID` |
| Background work | `MERIDIAN_REDIS_URL`, `MERIDIAN_DEMO_MODE=false`, `NODE_ENV=production` |
| Ad connectors | `META_APP_ID`, `META_APP_SECRET`, `MERIDIAN_GOOGLE_ADS_CLIENT_ID`, `MERIDIAN_GOOGLE_ADS_CLIENT_SECRET`, `MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` |
| Optional web sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |
| Legal/support and alerting | `MERIDIAN_SUPPORT_EMAIL=support@mymeridian.io`, `MERIDIAN_LEGAL_ENTITY=<Connor's legal name supplied privately at configuration time>`, `MERIDIAN_SUPPORT_URL`, optional `CONNECTOR_ALERT_WEBHOOK_URL`, `CONNECTOR_ALERT_WEBHOOK_SECRET` |

## Explicit stops

Connor has resolved the intended individual publisher, domains, providers,
support recipient and infrastructure baseline. Connor must still create/own the
accounts, purchase/control the domain, supply private legal-name/phone values at
configuration time, make the required provider/Shopify submissions, approve each
paid or irreversible action, provide reviewer credentials, and authorize Gates
1–5. This repository cannot truthfully create, attest to, pay for or approve
any of them.

Reference requirements: [Fly Managed Postgres](https://fly.io/docs/mpg/),
[Resend production access](https://resend.com/docs/knowledge-base/does-resend-require-production-approval),
[Twilio Verify](https://www.twilio.com/docs/verify/api/verification),
[Google Ads developer token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token),
[Apple web sign-in](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple),
and [Shopify protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).

## Exact next step after domain purchase

1. Connor confirms registrar/DNS control of `mymeridian.io`; no payment or
   registration action is taken by this repository.
2. Create `staging.mymeridian.io` DNS only. Create the Fly staging app and use
   Fly's exact verification records; wait for HTTPS validation.
3. Add Resend's exact verification records, then verify the sender/domain.
   Confirm controlled delivery to a mailbox Connor owns before treating either
   planned address as active.
4. Create the staging-only PostgreSQL, Upstash and secret sets; do not use
   production values or data.
5. Register the listed **staging** OAuth callbacks with each available provider.
   Do not register production callbacks or update Shopify production config
   until `https://mymeridian.io` itself is live and Connor authorizes the
   relevant gate.
6. Stop and obtain explicit Gate 1 (merge) and Gate 2 (staging deployment)
   approvals before merging PR #1 or deploying staging.
