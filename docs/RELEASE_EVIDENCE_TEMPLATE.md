# Staging and production release evidence template

Use one copy per release per environment. This document is intentionally
sanitized: do not record secrets, tokens, cookies, phone numbers, customer
identifiers, order content, raw webhook payloads, SQL output, or private
support/reviewer credentials.

Current release authority is [`LAUNCH_READINESS.md`](LAUNCH_READINESS.md). A
completed staging record does not authorize production; a completed production
record does not authorize Shopify submission or public launch.

## Release identity

| Field | Record |
| --- | --- |
| Environment | `staging` / `production` |
| UTC start/end | |
| Release commit/image | |
| Actor / approver | |
| Gate authorization reference | |
| Fly app / region / VM size | |
| Postgres cluster plan / Redis plan | |
| Synthetic development store | masked identifier only |

## Configuration and isolation

- [ ] HTTPS canonical origin is correct; no placeholder/tunnel/localhost URL.
- [ ] `/healthz` passes and `/readyz` is ready.
- [ ] Production artifact scan is clean.
- [ ] Separate environment secrets, encryption keys, database and Redis are in
  use; no production data exists in staging.
- [ ] Actual tenant/system database roles prove cross-tenant denial and only
  intended system-worker access.
- [ ] Migration set applied cleanly; no schema drift.
- [ ] Redis enqueue, retry, lease-expiry reclaim and worker restart recovery
  pass.

## External-flow verification

| Flow | Result / sanitized evidence reference |
| --- | --- |
| Shopify install + embedded session + onboarding | |
| Historical import + interruption/resume | |
| Billing approve / decline / return / plan gate | |
| Valid/invalid/duplicate/retried webhook | |
| Uninstall/reinstall | |
| GDPR data request and redaction | |
| Meta lifecycle | |
| Google Ads lifecycle | |
| TikTok lifecycle | |
| ShipStation lifecycle | |
| Google sign-in lifecycle | |
| Apple sign-in lifecycle | |
| Email delivery + code expiry/replay | |
| SMS delivery + code expiry/replay | |
| Operator MFA / reauthentication / audit record | |
| Monitoring alert delivery + acknowledgement | |

## Resilience and capacity

| Check | Result / metric / evidence reference |
| --- | --- |
| Backup schedule, encryption, retention and access | |
| Isolated restore drill; RPO / RTO | |
| Baseline load p50 / p95 / p99 / failure rate | |
| 15-minute launch load metrics | |
| 30-minute soak metrics | |
| CPU / memory / DB connections / DB latency | |
| Queue depth / throughput / webhook delay | |
| Redis outage recovery | |
| Failed deployment / migration recovery | |
| Security-incident exercise | |

## Decision

- [ ] All blocking security, tenant isolation, financial correctness, billing,
  authentication and data-durability results passed.
- [ ] Failures are linked to owned remediation; unresolved blockers prevent the
  next gate.
- [ ] Staging completion: request explicit Gate 3 only.
- [ ] Production completion: request explicit Gate 4 only.
- [ ] Shopify approval/public activation: request explicit Gate 5 if Shopify
  presents a separate irreversible activation.
