# `mymeridian.io` Fly cutover

This checklist changes only web-hosting records. The ACME validation records
below can be added before deployment because they do not route traffic. The
apex and staging routing records must not change until the corresponding Fly
app is deployed and ready.

## Current state — 14 August 2026

- `https://mymeridian.io` still returns GoDaddy Website Builder (`Server:
  DPS`) at `13.248.243.5` / `76.223.105.230`; `www` redirects to the apex.
- `https://staging.mymeridian.io` is deployed over verified TLS and its Fly
  Machine is healthy. Its DNS and hosting must remain separate from production.
- `mymeridian-prod` remains an un-deployed Fly app record. Do not point the
  apex or `www` at it before explicit production deployment authorization.
- The apex, `www`, and staging Fly certificates are issued and active through
  the three non-routing ACME CNAMEs below.
- Microsoft 365 MX/DKIM/DMARC and Resend DNS resolve. Controlled inbound
  mailbox delivery and controlled Resend delivery have passed for
  `welcome@mymeridian.io`, `support@mymeridian.io`, and `eevee@mymeridian.io`.

Do not change any Microsoft 365 or Resend mail record during web cutover.

## Historical pre-staging snapshot — 12 August 2026

- GoDaddy nameservers are authoritative (`ns25.domaincontrol.com` and
  `ns26.domaincontrol.com`).
- The apex currently has GoDaddy Website Builder A records
  (`13.248.243.5` and `76.223.105.230`) and serves the temporary “Launching
  Soon” page over HTTPS.
- `www` is a CNAME to the apex and redirects to `https://mymeridian.io/` in the
  current GoDaddy configuration.
- Microsoft 365 mail is present: the Outlook MX record, root verification/SPF,
  `autodiscover`, both Microsoft DKIM selectors, DMARC, and the Microsoft SIP
  SRV records resolve.
- Resend mail DNS is present: `resend._domainkey`, plus the `send` MX and SPF
  records, resolve. Dashboard verification and an actual delivery have not been
  claimed from DNS evidence alone.
- Staging had not yet been routed or deployed. This was superseded by the
  current-state record above.
- Fly assigned included shared IPv4 and Anycast IPv6 ingress addresses. The
  apex, `www` and staging Let’s Encrypt certificates are issued, verified and
  active.

## Records added before deployment

These three non-routing CNAME records were added in GoDaddy and validated by
both authoritative nameservers. In GoDaddy the `Name` is relative to
`mymeridian.io`:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `_acme-challenge` | `mymeridian.io.ykrz826.flydns.net.` |
| CNAME | `_acme-challenge.www` | `www.mymeridian.io.ykrz826.flydns.net.` |
| CNAME | `_acme-challenge.staging` | `staging.mymeridian.io.lelp0dy.flydns.net.` |

These records do not replace or edit the apex A records, the existing `www`
CNAME, or any Microsoft 365/Resend record. Do not add the optional Fly
ownership TXT records unless a later `fly certs check` explicitly requires
them.

## Records allowed to change at production cutover

1. On the already-deployed production app, reconfirm the values:

   ```sh
   fly certs add mymeridian.io --app mymeridian-prod
   fly certs add www.mymeridian.io --app mymeridian-prod
   fly certs setup mymeridian.io --app mymeridian-prod
   fly certs setup www.mymeridian.io --app mymeridian-prod
   ```

2. In GoDaddy, replace only the two existing apex (`@`) A records with this
   single Fly A record, and add this Fly apex AAAA record:

   ```text
   A     @  66.241.125.144
   AAAA  @  2a09:8280:1::168:dcef:0
   ```

3. Keep the existing `www` CNAME pointing to `@`. Do not add A/AAAA records for
   `www` while that CNAME exists.
4. Do not delete, edit or consolidate any MX, mail-related CNAME, TXT, DKIM,
   DMARC, SPF or SRV record.

## Staging record

The deployed staging record is:

```text
Type: CNAME
Name: staging
Value: lelp0dy.mymeridian-staging.fly.dev
```

Staging uses its own Shopify app configuration, secrets, Postgres cluster and
Redis database. It must never reuse the production Shopify client or runtime
credentials.

## Verification before declaring cutover complete

```sh
dig +short A mymeridian.io
dig +short AAAA mymeridian.io
dig +short CNAME www.mymeridian.io
dig +short CNAME staging.mymeridian.io
dig +short MX mymeridian.io
dig +short TXT mymeridian.io
dig +short TXT _dmarc.mymeridian.io
fly certs check mymeridian.io --app mymeridian-prod
fly certs check www.mymeridian.io --app mymeridian-prod
fly certs check staging.mymeridian.io --app mymeridian-staging
curl --fail-with-body -sSIL http://mymeridian.io/
curl --fail-with-body -sSIL https://www.mymeridian.io/
curl --fail-with-body -sS https://mymeridian.io/ > /dev/null
curl --fail-with-body -sS https://mymeridian.io/privacy.html > /dev/null
curl --fail-with-body -sS https://mymeridian.io/terms.html > /dev/null
curl --fail-with-body -sS https://mymeridian.io/support > /dev/null
curl --fail-with-body -sS https://mymeridian.io/healthz > /dev/null
curl --fail-with-body -sS https://mymeridian.io/readyz > /dev/null
```

The required result is HTTP to HTTPS, `www` to apex, valid Fly TLS for both
hostnames, a 200 landing page with all local assets, public legal/support pages,
and `/readyz` reporting ready rather than merely returning a response.
