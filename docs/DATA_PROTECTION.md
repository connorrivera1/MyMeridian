# Protected customer data controls

This document maps the controls MyMeridian can evidence in code and the
production controls the operator must evidence before requesting Shopify
Protected Customer Data Level 2 access.

## Data minimization and separation

- Shopify scopes are read-only and limited to orders, products, fulfilments,
  inventory and reports. `read_customers` is not requested.
- Street addresses, phone numbers, order notes and full checkout payloads are
  not retained. Webhook bodies are erased after durable processing.
- Development uses seeded synthetic data. Production data may not be copied to
  developer laptops, screenshots, test fixtures or support tickets.
- Connector tokens use AES-256-GCM envelopes and a deployment secret separate
  from the customer-erasure key. Passwords use a memory-hard hash, and reset
  codes are one-use and time-limited.

## Access

There is no staff/admin route in the application. Merchant access is proved by
Shopify Admin authentication or a verified web account linked through a
Shopify-authenticated install. Production database and Fly access must be
limited to named operators with individual accounts, MFA and least privilege;
shared accounts are prohibited. Review the access list quarterly and within one
business day of an operator leaving.

## Leakage prevention

GitHub Actions scans full history for credentials and runs Semgrep SAST; Dependabot
opens dependency updates and GitHub vulnerability alerts are enabled. Hosted
push protection remains unavailable on the current private-repository plan, so
the full-history gitleaks gate is mandatory. Logs must never contain
access tokens, reset codes in production, raw webhook payloads, or customer
exports. Customer exports expire through the retention worker.

## Production evidence checklist

- [x] Repository is private.
- [x] Full-history gitleaks and Semgrep SAST scans run in GitHub Actions.
- [ ] GitHub-hosted secret scanning and push protection require a repository
      plan that supports Secret Protection for private repositories; the API
      rejected activation with HTTP 422 on 2026-08-11.
- [ ] Fly and GitHub operators use individual MFA-protected accounts.
- [ ] Managed Postgres encryption, backup/PITR window and network access are
      captured with dated screenshots or provider export.
- [ ] A restore drill has a successful, dated record.
- [ ] A monitored security/support address and incident commander are named.
- [ ] Incident-response drills have recorded outcomes.
- [ ] Quarterly access review has a dated owner and result.

Unchecked operating evidence is a submission blocker, not a documentation
detail.
