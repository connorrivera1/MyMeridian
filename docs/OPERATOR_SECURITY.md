# Meridian publisher operator dashboard

`/operator` is an internal control plane for the app publisher. It is not a
Shopify embedded route, does not load App Bridge, and never accepts a merchant
Shopify session, MyMeridian web-account cookie, or `ShopMembership` role.

## Authentication boundary

- The only operator identity is provisioned through four production secrets:
  `MERIDIAN_OPERATOR_EMAIL`, a scrypt password hash, a 160-bit TOTP secret, and
  a separate 256-bit session/audit HMAC key.
- Password and a six-digit RFC 6238 authenticator code are both mandatory.
  A code is accepted only once; the last accepted TOTP counter is advanced
  atomically in PostgreSQL so concurrent replay fails.
- Five failed attempts per email or source-address hash in 15 minutes trigger
  a 15-minute rate limit. Unknown emails still perform a scrypt derivation and
  every outcome returns a generic message.
- Operator sessions use a dedicated `__Host-mymeridian_operator_session`
  cookie in production: Secure, HttpOnly, SameSite=Strict and Path=/. They have
  an eight-hour absolute lifetime and a 30-minute idle lifetime. Session token
  values are never stored; PostgreSQL holds SHA-256 hashes only.
- The only role is `publisher`, with explicit `metrics:read` and `stores:read`
  permissions. Merchant roles cannot be promoted into it because the operator
  session model has no relation to `User`, `WebSession`, or `ShopMembership`.

Provision credentials in a private terminal:

```sh
npm run operator:provision -- publisher@example.com
```

Enroll the returned `otpauth://` URI immediately, move the four environment
values and initial password into the production credential vault, retain an
offline recovery copy, and clear terminal scrollback. Never put the TOTP secret,
password, password hash, session key, or enrollment URI in GitHub, support
tickets, screenshots, logs, or reviewer materials.

## Authorization, audit and response controls

Every successful and denied privileged route read is written to the append-only
`OperatorAuditEvent` ledger. Login success/failure, TOTP replay, dashboard reads,
store-support reads and logout are separately named. The ledger stores keyed
hashes of operator identity, IP address and user agent—not the raw values—and
keeps the path without its query string. Retain audit events for 365 days and
review denied access and unexpected store reads at least weekly.

Operator responses are `no-store`, deny framing, disable indexing and referrers,
restrict browser capabilities, and use a dedicated Content Security Policy.
The cookie cannot authenticate `/app`; merchant cookies cannot authenticate
`/operator`.

## Protected Customer Data minimization

The overview uses aggregate counts and subscription/operational status. The
store view selects only shop domain, subscription state, installation/sync
timestamps, granted scope names, connector status, job counts and completeness
counts. It does not select or render:

- customer records or merchant email;
- order numbers, line items, products, addresses or shopper identifiers;
- webhook or notification payloads and notification recipients;
- connector account identifiers, display names, tokens or webhook secrets;
- raw sync, webhook, connector or background-job errors.

Operational alerts contain a generic failure category, attempt count, time and
shop domain. Raw errors remain in the existing restricted logs/database and
must not be copied into this dashboard without a separate data-minimization
review.

## Privileged actions

There are no operator mutation routes in this release. The dashboard cannot
edit a database row, change a subscription, impersonate a merchant, export
customer data, reconnect a provider or retry a job. This is intentional.

Any future support action requires a separate threat model and must be a named,
narrow server operation—not a generic record editor. It must re-check an
explicit permission, require same-origin POST and a target-specific confirmation,
be idempotent where feasible, show the exact effect before execution, and write
success or failure to the operator audit ledger. Merchant impersonation and
arbitrary SQL/database editing remain prohibited.

## Production runbook

1. Provision the operator identity and set all four values as deployment secrets.
2. Apply the operator-security migration before accepting traffic.
3. Confirm `/readyz` fails when any operator secret is absent or malformed.
4. Confirm a merchant Shopify session and a MyMeridian cookie both redirect
   `/operator` to `/operator/login`.
5. Sign in with password + TOTP, then confirm the same TOTP code cannot create a
   second session.
6. Confirm `/operator` and a store-support page send every documented response
   security header and no App Bridge script.
7. Inspect `OperatorAuditEvent` for the login and both reads, then sign out and
   confirm the cookie is cleared and the session is revoked.
8. Review the route after every schema expansion; adding a protected field to a
   merchant model does not authorize adding it to an operator select.
