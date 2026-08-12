# Security policy

MyMeridian processes Shopify order and customer-linked commerce data. Security
reports must not be filed as public GitHub issues because doing so can disclose
an exploit before merchants are protected.

## Reporting a vulnerability

Use the private vulnerability-reporting form in this repository's **Security**
tab. The production operator must also configure a monitored security address
before launch and publish it on `/support`; until that address exists, the app
is not submission-ready.

Do not include live access tokens, customer exports, order payloads, database
backups, or encryption keys in a report. Describe how to reproduce the issue
with synthetic data instead.

## Response targets

- Acknowledge a credible report within two business days.
- Begin containment immediately for active credential exposure or unauthorized
  protected-customer-data access.
- Coordinate disclosure only after a fixed release is deployed and affected
  merchants and Shopify have received any legally required notice.

The complete operating procedure is in
[`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md).

The publisher-only dashboard has a separate password + TOTP boundary,
append-only privileged-access ledger, PII-minimized read models and no database
editing surface. Provisioning, review and response controls are documented in
[`docs/OPERATOR_SECURITY.md`](docs/OPERATOR_SECURITY.md).
