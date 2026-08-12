# Authentication and abuse controls

MyMeridian has three deliberately separate authentication boundaries.

## Embedded Shopify merchants

Shopify Admin requests are authenticated with Shopify's short-lived signed
session token and App Bridge. MyMeridian does not add a second signup or phone
prompt inside Shopify Admin. This preserves Shopify SSO and avoids collecting
standalone-account data from merchants who never use the external dashboard.

## Standalone merchant accounts

Primary authentication is a memory-hard scrypt password or the existing Google
or Apple OIDC provider. A primary login creates a restricted session that
cannot resolve merchant data until MFA succeeds.

Enrollment requires possession of both the normalized email address and an
E.164 phone number. Email codes are sent through Resend. Production SMS codes
are created and checked by Twilio Verify using a restricted API key; MyMeridian
does not store the SMS code. The phone number is encrypted with AES-256-GCM and
only its last four digits are available for ordinary display. Locally generated
codes are stored only as keyed hashes, expire after ten minutes, allow five
attempts and are one-use.

After both recovery channels are verified, each login requires a new email or
SMS possession code. A session without `mfaVerifiedAt` is redirected before
shop resolution and cannot enter a tenant database transaction.

Sensitive actions require a primary reauthentication plus a new email or SMS
code within the prior 15 minutes. Password accounts re-enter the password;
Google/Apple-only accounts rerun their provider flow. This gate covers store
connection, billing-plan changes, cost/settings/onboarding mutations,
connectors, pricing actions, profit exports and privacy-export downloads.

## Publisher operator

`/operator` has no trust relationship with merchant cookies or Shopify session
tokens. It uses its own scrypt credential, mandatory TOTP, replay protection,
Strict short-lived cookie, permission checks and append-only audits. See
`OPERATOR_SECURITY.md`.

## Abuse resistance

Login, signup, password reset, OAuth, Shopify install/connect, MFA,
reauthentication and operator login use a PostgreSQL-backed fixed-window limit.
The key combines scoped, keyed fingerprints of the client address and account
subject; raw IP addresses and emails are not stored in rate-limit buckets.
Counters are atomic across processes and survive deploys. Rejected responses
include `Retry-After` and no-store cache policy.

All state-changing browser requests also require a same-origin `Origin` or
`Referer`; session cookies are HTTP-only, host-bound on HTTPS, and SameSite.
OAuth state and connector state are single-use and time-limited. Webhooks are
not subject to browser limits: they verify provider signatures and use durable
delivery ids for idempotency so throttling cannot break required Shopify
delivery retries.

## Production requirements

Production readiness fails closed without valid Resend, Twilio Verify, rate
limit, encryption, database and operator configuration. Provider credentials
remain in server environment secrets. The production build scans every public
text asset for server-only variable names and configured secret values.

Before launch, externally prove email delivery and SMS delivery/check on the
production providers, revoke/recovery behavior, and the Google/Apple callback
flows. Local mocks prove application handling but cannot prove carrier or
provider availability.
