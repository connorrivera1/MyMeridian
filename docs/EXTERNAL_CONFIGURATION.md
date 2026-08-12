# External configuration handoff

[`LAUNCH_READINESS.md`](LAUNCH_READINESS.md) is the source of truth for release
status. This document is a preparation-only inventory: it neither creates an
account nor authorizes a paid service, deployment, publication, attestation or
submission.

Use two isolated environments. Staging has its own domain, Fly app, PostgreSQL
cluster, Redis instance, Shopify development app/store and provider test
credentials. Production has its own values and never receives staging data,
cookies, OAuth clients, database roles or encryption keys.

## Canonical origins and callback paths

Choose the actual values before registering callbacks:

| Environment | Canonical origin | Required paths |
| --- | --- | --- |
| Staging | `https://staging.<chosen-domain>` | `/auth/callback`, `/oauth/google/callback`, `/oauth/apple/callback`, `/connections/meta/callback`, `/connections/google/callback`, `/connections/tiktok/callback`, `/webhooks/*` |
| Production | `https://<chosen-domain>` | Same paths, on the production origin only |

Never set `APP_URL` to a different host. Leave it unset in production and use
`SHOPIFY_APP_URL` as the canonical origin. Production readiness now rejects
localhost, example and Shopify CLI placeholder origins.

## Account and credential matrix

All values below are deployment secrets, except public client IDs and Shopify
app URL/scopes. Store runtime secrets in the environment-specific hosting secret
store; keep recovery copies of long-lived encryption and operator secrets only
in Connor's approved password manager/vault. Never commit them, put them in the
browser bundle, issue tracker, screenshots or chat.

| Service / exact product | Account or product Connor needs | Cost / review | MyMeridian value(s) | Register / configure | Can happen before deployment? |
| --- | --- | --- | --- | --- | --- |
| **Fly.io Apps** | One Fly organization and two apps: `mymeridian-staging` and the final production app name, both in `iad` | Production compute is paid; no Shopify-style review | Hosting deployment authorization; runtime secret store | Attach staging/production custom domains and require HTTPS | Account and app names: yes. Public callbacks: after each origin exists. |
| **Fly Managed Postgres** | One isolated cluster per environment, same region as its app | Paid; Fly documents Managed Postgres plans, backups and pooling | `DATABASE_URL` (system pooled), `MERIDIAN_TENANT_DATABASE_URL` (tenant pooled), `DIRECT_DATABASE_URL` (migration direct) | Create `meridian_app_system` and `meridian_app_tenant` exactly as `DATABASE_SECURITY.md`; keep migration owner separate | Account decision: yes. Roles/URLs: after cluster creation. |
| **Managed Redis** | One isolated Redis 6+ compatible instance per environment for BullMQ | **Provider is not selected in this repository; Connor must choose/authorize it.** Cost and review depend on provider | `MERIDIAN_REDIS_URL` only | TLS/private networking where provider supports it; never share with staging | Provider decision: yes. URL: after instance creation. |
| **Domain registrar + authoritative DNS** | Ownership/control of `<chosen-domain>` and optional `staging.<chosen-domain>` | Domain purchase normally paid; no app review | No secret; DNS records and final `SHOPIFY_APP_URL` | Add Fly verification/AAAAA or CNAME records exactly as Fly supplies; TLS is then verified at Fly | Domain can be bought and DNS zone prepared now; final record values require Fly app/domain step. |
| **Resend Transactional Email** | Resend team, verified sending domain, production API key | Free tier exists but has quotas; paid plan may be required for volume. No production approval according to Resend | `RESEND_API_KEY`, `MERIDIAN_EMAIL_FROM` | Add Resend's domain DNS records; sender must use verified domain | Account/domain verification: yes. Send a real controlled test after staging deploy. |
| **Twilio Verify** | Twilio account, restricted API key and one Verify Service | Trial exists but is constrained; successful production verifications are usage-billed | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_VERIFY_SERVICE_SID` | Configure Verify Service with SMS channel, Fraud Guard/rate limits and allowed geographies; no callback is required by this app | Account/service: yes. Controlled real SMS test after staging deploy. |
| **Shopify Partner Dashboard** | Partner organization, one staging/development app and one production public app | Partner/account identity, billing and App Store review are external gates | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | Production app: real application URL, `/auth/callback`, relative GDPR/webhook routes from `shopify.app.toml`; set `automatically_update_urls_on_dev = false` in the deployed production config | Partner account and staging app: yes. Production URLs/config: only when production origin exists. |
| **Meta for Developers / Marketing API** | Meta developer account, business-owned app, Marketing API use case | Access/review may be required for production access; Meta decision is external | `META_APP_ID`, `META_APP_SECRET` | Valid OAuth redirect URI: `https://<origin>/connections/meta/callback` | App creation: yes. Exact callback: once origin is chosen. |
| **Google Cloud + Google Ads manager account** | Google Cloud project with web OAuth client, plus a Google Ads manager account/API Center developer token | OAuth consent configuration and Google Ads developer-token access are external; production access level depends on Google review | `MERIDIAN_GOOGLE_ADS_CLIENT_ID`, `MERIDIAN_GOOGLE_ADS_CLIENT_SECRET`, `MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN` | Authorized redirect URI: `https://<origin>/connections/google/callback`; enter functioning company URL and monitored API contact in Google Ads API Center | Cloud project/manager account: yes. Callback/production consent screen: once origin and identity exist. |
| **TikTok for Business / Marketing API** | TikTok for Business developer/Marketing API app | Provider approval/access is external; any spend is subject to TikTok account terms | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | Redirect URI: `https://<origin>/connections/tiktok/callback` | Account/app request: yes. Callback activation: once origin exists. |
| **Google Identity** | Google Cloud OAuth web client for MyMeridian web-account sign-in | Account normally free; consent-screen verification can be required depending on publishing/scopes | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Authorized redirect URI: `https://<origin>/oauth/google/callback` | Project/client: yes. Callback: once origin exists. |
| **Apple Developer Program / Sign in with Apple** | Apple Developer membership, primary App ID, Services ID and Sign in with Apple private key | Membership/payment and Apple ownership are Connor decisions; no code attestation by this repo | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Registered domain plus return URL: `https://<origin>/oauth/apple/callback` | Apple enrollment/App ID: yes. Website URL: once origin exists. |
| **Alert destination** | A monitored incident/support endpoint or alert provider selected and owned by Connor | Not selected in the repo; may be paid | Optional `CONNECTOR_ALERT_WEBHOOK_URL`, `CONNECTOR_ALERT_WEBHOOK_SECRET` | HTTPS receiver verifies signed alert payloads; do not use a personal unmonitored endpoint | Decision/receiver: yes. End-to-end test after staging deploy. |
| **ShipStation test account** | Controlled ShipStation account and API credential for connector acceptance | Provider plan/access is external | Encrypted merchant-provided credential; no publisher-wide runtime secret | Configure test webhook if the controlled account supports it | Account: yes. Test after staging deploy. |

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
| Legal/support and alerting | `MERIDIAN_SUPPORT_EMAIL`, `MERIDIAN_LEGAL_ENTITY`, `MERIDIAN_SUPPORT_URL`, optional `CONNECTOR_ALERT_WEBHOOK_URL`, `CONNECTOR_ALERT_WEBHOOK_SECRET` |

## Explicit stops

Connor must supply/authorize: organization ownership, payment method, legal
entity, privacy/terms statements, domain purchase, the monitored support and
emergency contacts, provider-app ownership, billing choice, Shopify protected
customer-data request answers, reviewer credentials, and every production
credential. This repository cannot truthfully create, attest to, pay for or
approve any of them.

Reference requirements: [Fly Managed Postgres](https://fly.io/docs/mpg/),
[Resend production access](https://resend.com/docs/knowledge-base/does-resend-require-production-approval),
[Twilio Verify](https://www.twilio.com/docs/verify/api/verification),
[Google Ads developer token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token),
[Apple web sign-in](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple),
and [Shopify protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).
