# Security incident response

Owner: production operator. Review cadence: before launch and every six months.

## Severity

- **SEV-1:** confirmed unauthorized access to customer/order data, leaked
  Shopify/provider/database credential, destructive production access, or an
  active exploit.
- **SEV-2:** credible vulnerability with no confirmed access, sustained loss of
  privacy webhook processing, or backup/restore failure.
- **SEV-3:** blocked probe, isolated availability issue, or low-risk defect.

## First hour

1. Open a private incident record with UTC timestamps and name one incident
   commander. Never paste credentials or customer payloads into it.
2. Preserve Fly, Shopify, GitHub, database and connector-health logs. Record
   hashes/export receipts; do not alter source evidence.
3. Contain the narrowest credential or component: revoke exposed tokens,
   disable the affected connector, rotate the database credential, or stop the
   app only when continued operation would expand harm.
4. If `MERIDIAN_ENCRYPTION_KEY` is exposed, revoke every stored third-party
   token before rotating it; rotation alone makes ciphertext unreadable but
   does not revoke the provider credentials.
5. If `MERIDIAN_CUSTOMER_ERASURE_KEY` is exposed, preserve the old value for
   evidence, rotate deliberately, and rebuild erasure guards before any import
   can run. Never replace it casually during an ordinary deploy.

## Investigation and notification

Determine the affected shops, data categories, first/last known access, and
whether information was exfiltrated or only exposed. Use database and provider
records, not assumptions. Notify Shopify through the Partner Dashboard and
affected merchants when the facts or applicable law require it. Legal notice
decisions belong to qualified counsel; the incident record must capture who
made them and when.

## Recovery

Deploy the fix through reviewed CI, validate `/readyz`, replay durable webhook
and recalculation queues, verify GDPR endpoints, and monitor error/connector
health for at least one full polling interval. Rotate only credentials that are
in scope. Complete a retrospective within five business days and turn every
preventable cause into an owned corrective action.

## Drill evidence

Twice yearly, run a synthetic token-leak exercise and a privacy-webhook outage
exercise. Record date, participants, detection time, containment time, gaps,
and completed follow-ups. A written policy without a recorded drill is not
operating evidence.
