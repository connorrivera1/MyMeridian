# Protected customer data controls

This document maps the controls MyMeridian can evidence in code and the
production controls the operator must evidence before requesting Shopify
Protected Customer Data Level 2 access.

## Data minimization and separation

- Shopify scopes are read-only and limited to orders, products, fulfilments,
  inventory and reports. `read_customers` is not requested.
- Shopper street addresses and phone numbers, order notes and full checkout
  payloads are not retained. A standalone account's MFA phone is collected only
  for authentication, encrypted with AES-256-GCM and unavailable to merchant
  analytics or the operator dashboard. Webhook bodies are erased after durable
  processing.
- Development uses seeded synthetic data. Production data may not be copied to
  developer laptops, screenshots, test fixtures or support tickets.
- Connector tokens use AES-256-GCM envelopes and a deployment secret separate
  from the customer-erasure key. Passwords use a memory-hard hash, and reset
  codes are one-use and time-limited.

## Access

The publisher operator dashboard is isolated under `/operator`, rejects
merchant cookies and Shopify sessions, requires a dedicated scrypt password and
TOTP, and audits every privileged read. It exposes aggregate/store health but no
customer or order detail, merchant contact data, tokens, raw payloads, secrets,
or arbitrary database editor. Merchant access is proved by Shopify Admin
authentication or a mandatory-MFA web account linked through a
Shopify-authenticated install. PostgreSQL RLS forces every merchant request to
the authenticated shop; the merchant role cannot read identity/operator tables.
Production database and hosting access must be limited to named operators with
individual accounts, MFA and least privilege; shared accounts are prohibited.
Review access quarterly and within one business day of an operator leaving.

## Leakage prevention

GitHub Actions scans full history for credentials and runs Semgrep SAST; Dependabot
opens dependency updates and GitHub vulnerability alerts are enabled. Hosted
push protection remains unavailable on the current private-repository plan, so
the full-history gitleaks gate is mandatory. Logs must never contain
access tokens, reset codes in production, raw webhook payloads, or customer
exports. Customer exports expire through the retention worker.

## Production evidence checklist

- [ ] Repository visibility is set to the publisher's intended launch state;
      if temporarily public for review, return it to private before loading any
      production configuration or customer data.
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
