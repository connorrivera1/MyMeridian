# Meridian deploy plan

Canonical checkout: `/Users/connorrivera/Meridian`, branch
`feature/mymeridian-web-accounts`, with GitHub remote
`connorrivera1/MyMeridian`. The implementation is pushed to draft PR #1. No
production deployment or App Store submission has been made.

**Ads ingestion dependency.** `MERIDIAN_REDIS_URL` enables continuous
Meta/Google/TikTok polling; without it the app stays up and ad ingestion is
offline. The durable `AdSyncWindow` ledger is Postgres, so a lost Redis queue
is reconciled on the next polling cycle. Google Ads also needs its client id,
secret, and developer token configured as deployment secrets.

**Current snapshot, 2026-08-12.** This snapshot overrides stale "now" claims in
the dated audit history below. Billing is enforced, the suite has 1,156 passing
unit tests plus 72 passing opt-in PostgreSQL integration tests, all 34 migrations
apply to a fresh database, Docker and flyctl are installed, `read_all_orders` is
approved, and the development app has passed a real Shopify install, onboarding,
full-history import and test-billing approval/return flow. The remaining release
gates are production infrastructure, final business/legal identity, full
protected-customer-data approval for ShopifyQL reports, App Store registration
and listing/reviewer evidence.

**Version 2, 2026-08-05 23:58.** This supersedes the version written earlier the
same day at 18:53. That version's hosting analysis was sound and is carried
forward largely intact — the reasoning about in-process background work deciding
the host is still the right reasoning. What has changed is that three of its
facts went stale within hours of being written, and its two open questions are
now answered: there is a concrete deploy configuration in §4, and the listing
copy it declined to draft is drafted in `listing/copy.md`.

Corrections to v1 are listed in §8 rather than silently applied, because one of
them would have sent someone to run a command that no longer exists.

See `SUBMISSION.md` for the audit trail of what was fixed and why. This file is
the ordered path from here to a submitted listing.

---

## 1. Current state, verified now

| Check                             | Result                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run ci`                      | **Passes** (2026-08-11): typecheck, coverage thresholds and production build.                                                                                                                                                                                                                                                                                                                                    |
| `npx vitest run`                  | **1,156 passed, 72 skipped**. The 72 skipped cases are opt-in PostgreSQL integration tests; the explicit real-PostgreSQL run passes **72/72** after applying all 34 migrations to a fresh database.                                                                                                                                                                                                              |
| Billing enforcement               | **Implemented and tested.** `resolvePlan` reads/caches Billing API state, the app layout redirects stores without an active plan, `planAllows` enforces paid capabilities, and `/app/plan` calls `billing.request`. A real Shopify development-store test charge completed its approval and return flow without moving money.                                                                                    |
| `npx shopify app config validate` | **Passes.** On CLI 4.x, `app config` has `link`, `pull`, `use`, and `validate`; **there is no `config push`**. Config is published by `shopify app deploy` because `include_config_on_deploy = true`.                                                                                                                                                                                                            |
| Docker / flyctl                   | **Installed.** Docker CLI 29.7.1 and flyctl 0.4.79 are present. The image was previously built and booted locally (§11); the Docker daemon was stopped during this verification. flyctl is not authenticated (`fly auth whoami` returns `no access token available`).                                                                                                                                            |
| Shopify development acceptance    | **Passed for the currently testable core path.** The app installed and rendered embedded in Shopify Admin; onboarding persisted; all six monthly/annual prices rendered; Starter test billing returned active; and a zero-order store completed a full-history import with `read_all_orders`. Shopify Shipping correctly paused with an actionable error because the remaining ShopifyQL PCD approval is absent. |
| Production state                  | `Dockerfile`, `.dockerignore`, and `fly.toml` exist, but there is no Fly app, managed Postgres cluster, production origin, or deployment.                                                                                                                                                                                                                                                                        |

The code is in good shape. Nothing here blocks starting deployment work.

---

## 2. External blocker — production origin

Still true: `shopify.app.toml` has
`application_url = "https://shopify.dev/apps/default-app-home"`, `redirect_urls`
points at the same placeholder host, and every webhook `uri` is relative and
resolves against it. So the three mandatory compliance webhooks and every other
relative webhook subscription currently resolve to a host Shopify cannot
deliver to. Shopify separately rejects an `application_url`
containing the word "Shopify", so this exact string fails twice over.

The deployment files now exist, but their current Fly slug is provisional and
there is still no deployed origin. Do not replace the placeholder until the app
name is decided and the first Fly deployment returns the real stable HTTPS
origin. `SHOPIFY_APP_URL` in the local `.env` remains
`http://localhost:3000`; `.shopify/` contains only the CLI project link.

This blocks production OAuth callbacks and webhook delivery. It is not the only
critical path: Shopify access and App Store registration work can proceed before
a host exists.

---

## 3. Hosting decision — Fly.io

Carried forward from v1, and re-verified after the durable-work migration. The
deciding constraint is not framework preference: **the work is now durable in
Postgres, but this deployment still runs its worker inside the web process**:

- `afterAuth` persists a deduplicated `HISTORICAL_BACKFILL` job before returning;
  Settings and onboarding do the same for `FULL_RECOMPUTE` work.
- The backfill walks the store's entire accessible order history with no
  implicit ceiling and
  re-acquires its admin token every 40 minutes because it expects to outlive an
  hour-long access token.
- A five-minute lease is heartbeated every minute, progress and terminal writes
  are fenced to the current owner, and the saved cursor makes an interrupted run
  visible and resumable. The worker automatically reclaims expired queued work.
- The same always-on process runs the ten-second durable-webhook recovery worker
  and hourly privacy-retention sweep.

Anything that provides no continuously available worker pauses those jobs. The
request is safe and the lease makes restart recovery automatic, but a production
worker must still be available for progress.

| Option              | Fit             | Why                                                                                                                                                                                                                                                                      |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fly.io**          | **Recommended** | Long-lived container, managed Postgres or bring-your-own, cheap always-on small VM, `fly deploy` from a Dockerfile, custom domain and free TLS. The durable worker runs with no architecture change.                                                     |
| Railway             | Close second    | Same long-lived-process model, easier Postgres, but usage-based pricing is less predictable. Fine as a fallback.                                                                                                                                                         |
| Render              | Viable          | Long-lived service plus managed Postgres. The free tier spins down on idle, which would kill a backfill on a cold start — paid tier from day one or not at all.                                                                                                          |
| Vercel              | **Not as-is**   | The Postgres queue is durable, but a serverless request does not provide the continuously running worker that drains it. A separate worker service would still be required. |
| ngrok / cloudflared | **Test only**   | A tunnel is enough to exercise OAuth, webhooks and billing locally (Phase 2), but Shopify does not accept a tunnel URL as `application_url` — it is not stable and disappears with the dev session. Use it to test, never to submit.                                     |

**Decision: Fly.io.** Deploy there, take the `*.fly.dev` subdomain (or attach a
real domain if there is one), set that as `application_url`, and do not block
submission on replacing the Postgres queue — Fly's model runs it correctly
today. Revisit only if worker execution moves to another service (§9).

---

## 4. Deploy configuration

✅ **Superseded 2026-08-06 — both files are now built, booted and committed.**
Docker and flyctl were installed on this machine and the Dockerfile below was
built and run; see §11 for exactly what was verified and the three corrections
to §5 that came out of it. The files now live in the repo root rather than only
here. The paragraph that used to be here said the first `fly deploy` should be
treated as a debugging pass — that is no longer the expectation, though §11
lists the two things that still cannot be checked without a Fly account.

The text below is retained verbatim as the source the committed files were
written from.

### `Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-slim AS base
ENV NODE_ENV=production
WORKDIR /app
# Prisma's query engine links against OpenSSL and the slim image has neither it
# nor the CA bundle Postgres TLS needs.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- build -----------------------------------------------------------------
FROM base AS build
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# NODE_ENV=production is inherited from base, so dev dependencies have to be
# asked for explicitly — vite, the react-router compiler and the prisma CLI are
# all needed to build.
RUN npm ci --include=dev
COPY . .
# package.json: "build": "prisma generate && react-router build"
RUN npm run build
# Drop dev dependencies, but put the prisma CLI back: the Fly release command
# runs `prisma migrate deploy` from this image, and a CLI whose version has
# drifted from @prisma/client 6.19.3 is a real and confusing failure mode.
RUN npm prune --omit=dev && npm install --no-save prisma@6.19.3

# --- runtime ---------------------------------------------------------------
FROM base
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/build        /app/build
COPY --from=build /app/prisma       /app/prisma
COPY --from=build /app/package.json /app/package.json

ENV PORT=8080
EXPOSE 8080
CMD ["./node_modules/.bin/react-router-serve", "./build/server/index.js"]
```

### `fly.toml`

```toml
app = "meridian-profit"
primary_region = "iad"

[build]

[env]
  NODE_ENV = "production"
  PORT = "8080"
  # app/lib/auth.server.ts throws at boot if this is "true" while
  # NODE_ENV=production. That is deliberate — the demo path bypasses Shopify
  # session authentication — so this is not an optional line.
  MERIDIAN_DEMO_MODE = "false"

[deploy]
  # Runs on a temporary machine before the new version takes traffic. There are
  # 16 migrations in prisma/migrations, none applied to a production database.
  release_command = "/bin/sh -lc 'DATABASE_URL=$DIRECT_DATABASE_URL npx prisma migrate deploy'"

[http_service]
  internal_port = 8080
  force_https = true

  # afterAuth waits for the atomic import claim, then the leased historical
  # import continues in-process. A machine that suspends when the request queue
  # drains would interrupt it; the cursor/lease makes that visible and resumable,
  # but an always-on process is still required to finish without intervention.
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    # Not "/". With Shopify credentials present, the index route redirects to
    # /auth/login (302) — see app/routes/home.tsx. /privacy is public,
    # unauthenticated and returns 200, which is what a health check wants.
    path = "/privacy"
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 1024
```

---

## 5. Exact deploy sequence

Run from the repo root only after choosing the Fly slug for MyMeridian.
Authentication, provisioning, secrets, deployment, and Partner Dashboard writes
change external state and incur charges; none has been run from this repository.
The task-specific shell variables below are deliberately blank decisions, not
suggested production values.

```sh
# 1. Fill these only after the Fly slug decision.
MERIDIAN_FLY_APP="<chosen-fly-app-slug>"
MERIDIAN_FLY_DB="<chosen-managed-postgres-name>"
MERIDIAN_FLY_DB_ID="<cluster-id returned by fly mpg create>"
MERIDIAN_PROD_ORIGIN="https://${MERIDIAN_FLY_APP}.fly.dev"
# Generate each lifetime key once, store it in the credential vault, and paste
# the preserved value here. Never put openssl generation inside the retryable
# `fly secrets set` command.
MERIDIAN_ENCRYPTION_KEY="<stable value retrieved from credential vault>"
MERIDIAN_CUSTOMER_ERASURE_KEY="<stable value retrieved from credential vault>"
# Generate these four once with:
#   npm run operator:provision -- publisher@example.com
# Enroll the printed authenticator URI, then retrieve every value from the
# production credential vault. Never paste the URI or raw password into Git.
MERIDIAN_OPERATOR_EMAIL="<publisher email>"
MERIDIAN_OPERATOR_PASSWORD_HASH="<scrypt hash>"
MERIDIAN_OPERATOR_TOTP_SECRET="<base32 TOTP secret>"
MERIDIAN_OPERATOR_SESSION_KEY="<stable 256-bit session and audit HMAC key>"

# 2. Authenticate, create the app shell, and provision managed Postgres.
fly auth login
fly launch --no-deploy --copy-config --name "$MERIDIAN_FLY_APP" --region iad
fly mpg create --name "$MERIDIAN_FLY_DB" --region iad
fly mpg attach "$MERIDIAN_FLY_DB_ID" --app "$MERIDIAN_FLY_APP"   # sets pooled DATABASE_URL

# 3. Secrets. Replace every angle-bracket placeholder before running.
#    MERIDIAN_ENCRYPTION_KEY must be generated ONCE and never rotated casually:
#    it decrypts stored connector tokens, and a new key orphans them silently.
#    MERIDIAN_CUSTOMER_ERASURE_KEY is a separate lifetime key. Preserve its
#    exact value across deploys and restores: replacing it invalidates every
#    customer-erasure guard and can let delayed imports recreate erased data.
#    SCOPES is the same approved set as the TOML, comma-delimited for runtime.
fly secrets set \
  SHOPIFY_API_KEY="<from Partner Dashboard>" \
  SHOPIFY_API_SECRET="<from Partner Dashboard>" \
  SCOPES="read_orders,read_all_orders,read_products,read_fulfillments,read_inventory,read_reports" \
  SHOPIFY_APP_URL="$MERIDIAN_PROD_ORIGIN" \
  DIRECT_DATABASE_URL="<direct URL from the MPG Connect tab>" \
  MERIDIAN_ENCRYPTION_KEY="$MERIDIAN_ENCRYPTION_KEY" \
  MERIDIAN_CUSTOMER_ERASURE_KEY="$MERIDIAN_CUSTOMER_ERASURE_KEY" \
  MERIDIAN_OPERATOR_EMAIL="$MERIDIAN_OPERATOR_EMAIL" \
  MERIDIAN_OPERATOR_PASSWORD_HASH="$MERIDIAN_OPERATOR_PASSWORD_HASH" \
  MERIDIAN_OPERATOR_TOTP_SECRET="$MERIDIAN_OPERATOR_TOTP_SECRET" \
  MERIDIAN_OPERATOR_SESSION_KEY="$MERIDIAN_OPERATOR_SESSION_KEY" \
  MERIDIAN_SUPPORT_EMAIL="<Meridian's monitored inbox on its final domain>" \
  MERIDIAN_LEGAL_ENTITY="<Meridian's actual publishing entity>" \
  --app "$MERIDIAN_FLY_APP"

# 4. Deploy with Fly's remote builder. release_command applies migrations first.
fly deploy --app "$MERIDIAN_FLY_APP"

# 5. Confirm the origin is real before pointing Shopify at it. Both are public
#    and unauthenticated, and both must show Meridian's real publisher and
#    monitored inbox rather than the explicit pre-launch configuration gap.
MERIDIAN_PRIVACY_HTML="$(curl --fail-with-body -sS "$MERIDIAN_PROD_ORIGIN/privacy")"
MERIDIAN_SUPPORT_HTML="$(curl --fail-with-body -sS "$MERIDIAN_PROD_ORIGIN/support")"
if printf '%s\n%s\n' "$MERIDIAN_PRIVACY_HTML" "$MERIDIAN_SUPPORT_HTML" | grep -Fqi "not configured"; then
  echo "Public contact configuration is still missing" >&2
  exit 1
fi
fly logs --app "$MERIDIAN_FLY_APP"          # expect no boot error

# 6. Point the app config at it. This writes to the Partner Dashboard.
#    Edit shopify.app.toml first (see below), validate, inspect the diff, then:
npx shopify app config validate
npx shopify app deploy --message "Real production origin"
```

Charge mode has no operator override. Every production charge queries
Shopify's durable `ShopPlan.partnerDevelopment` signal immediately before it is
requested; a failed lookup creates no charge. The `shop/update` webhook
invalidates the stored signal when a development store is converted to a paid
merchant store, and access remains blocked until the matching real/test
subscription can be confirmed.

Keep the two database URLs distinct. `fly mpg attach` supplies the pooled
PgBouncer `DATABASE_URL` used by the running app. Copy the separate
`direct.<cluster>.flympg.net` URL from the MPG dashboard's **Connect** tab into
`DIRECT_DATABASE_URL`; Fly's release command temporarily maps that direct value
to `DATABASE_URL` for `prisma migrate deploy`. Migrations and their advisory
locks must not run through the pooled endpoint.

### The `shopify.app.toml` edit in step 6

```toml
application_url = "<production-origin>"

[auth]
redirect_urls = [ "<production-origin>/auth/callback" ]
```

`/auth/callback` and not `/api/auth` — `authPathPrefix` is `/auth`, and the
Remix template's default path is a route this app does not have. That was
already fixed; it just has to keep tracking the host.

The webhook `uri` values are relative and need no edit at all. That is the whole
point of them being relative, and it is why fixing `application_url` fixes all
relative webhook destinations at once.

**Change one more line in the production config at the same time, or this will
come undone:**

```toml
[build]
automatically_update_urls_on_dev = false   # keep true until a production origin exists
```

While it is `true`, `shopify app dev` rewrites `application_url` and
`redirect_urls` in this file to whatever tunnel it opened. Run `shopify app dev`
once after going live, deploy without re-reading the diff, and production is
pointed at a dead tunnel. The alternative, if the convenience is wanted during
Phase 2, is a second linked config — `shopify app config link` writes
`shopify.app.<name>.toml` and `shopify app config use` switches between them —
so the dev tunnel never touches the production file.

For now the canonical config deliberately remains `true`: changing it while the
URL is still the placeholder would break the convenient tunnel rewrite used by
`shopify app dev` without protecting any real production URL. Once production
exists, either turn it off in the production config or keep a separate linked
development config.

`include_config_on_deploy = true` is already set, which is what makes
`shopify app deploy` publish `application_url` and the webhook subscriptions
with the version. There is no separate config-push step; see §8.

---

## 6. Partner Dashboard — human only

None of this is code and none of it can be done from this repo. It needs a
signed-in Partner account.

**Public identity — decided: MyMeridian.** The repo config, app UI, landing page,
legal pages and listing draft use MyMeridian because a published Shopify app
already uses Meridian. The linked development app still displays the former
dashboard name; change it only through the safe config-release path after the
production origin exists, and keep the Fly slug and remaining brand assets on
the chosen identity.

**a. Opt into manual pricing (Billing API), not Shopify App Pricing.**
Partner Dashboard → the app → Pricing. The app creates its own charges from
`PLANS` in `app/shopify.server.ts`, so no plan needs typing in by hand, but the
app must not be on managed App Pricing. Note that App Pricing is now the
**default** selection here, so this is an explicit opt-out and may draw a
reviewer question; requirement 1.2.1 permits either, in as many words. The
reasoning is a cost argument, not an impossibility one: since 28 April 2026 App
Pricing sends no subscription webhooks, and plan reads move off the Admin API
onto the Partner API plus the `plan_handle` redirect parameter — a second
credential and a non-Admin-API dependency, for no requirement gain, against a
billing implementation that is already finished and gated. Re-verified against
live shopify.dev docs on 6 August 2026; quotes and URLs are in `SUBMISSION.md`
§ "Billing". An earlier version of this paragraph said App Pricing plans could
not be read from a merchant session at all, which is wrong. The three plans are
Starter $49/mo or $490/yr, Growth $129/mo or $1,290/yr, and Scale $299/mo or
$2,990/yr, all USD with a 14-day trial.

**b. Protected Customer Data request, Level 2 — gates `read_orders`, not just
`read_customers`. This is a hard gate, and it is the single longest-lead item
on this whole page.**
Partner Dashboard → the app → API access → Protected customer data. A form with
a written justification and a data-handling questionnaire.

An earlier version of this paragraph said the request only mattered for
`read_customers` — "if CAC/LTV/payback are to work" — and that the app
"degrades honestly without it". Both halves were wrong, corrected in
`SUBMISSION.md` (§"What actually blocks submission") after re-reading the live
doc on 6 August 2026:

> "Orders … Orders, draft orders, abandoned checkouts, refunds, transactions,
> and other data that relate to a single customer."

Orders are themselves protected customer data, so the request gates
`read_orders` — the scope the entire product is built on, already requested in
`shopify.app.toml` today — not just the customer extras. Unapproved access is
not a clean absence either:

> "GraphQL requests to unapproved types will return an HTTP `200 Ok` response
> with an error message in the `errors` hash."

So without approval the order query itself comes back redacted and the app
computes nothing. **Start this before anything else in this section** — it
runs on Shopify's own review clock, separate from app review, and nothing else
here is gated by Shopify's clock the way this is.

Request **Level 2**, not Level 1: `customer { id email }` in the order query
(`app/lib/backfill.server.ts:387`) and `Customer.email` in the schema put
Meridian at Level 2 — "Customer data **including** name, address, phone, or
email fields" — which carries extra attestations (encrypted backups, test and
production data kept separate, a data loss prevention strategy, staff access
limits and an access log, strong staff passwords, an incident response
policy). Requesting Level 1 and discovering the gap later costs another round
of Shopify's clock.

ShopifyQL adds a separate, broader platform gate for the `shipping_labels`
report: Shopify requires the Level 2 request to cover **name, address, phone and
email** before it exposes that aggregate report. MyMeridian does not query or
persist shopper name, address or phone. Requesting those three additional field
approvals is therefore necessary to unlock Shopify Shipping costs, but it does
not authorize adding those fields to MyMeridian's queries or storage.

**c. `read_all_orders` access request — approved 2026-08-11.**
Shopify granted the separate request. The scope is now present in the app config,
and a real development-store install verified that a zero-order store is still
correctly recognized as having complete history rather than falsely showing the
60-day-limit warning.

**d. Emergency developer contact.**
Partner Dashboard → the app → App setup. Email **and phone**, and it is a
different field from the support contact on the listing. Needs Connor's real
phone number.

**e. Meridian support domain, publisher and email.**
Set these only after Meridian's own domain, monitored inbox and publishing
entity are selected. `/privacy` and `/support` intentionally show an explicit
pre-launch configuration gap until then; do not borrow another product's legal
identity to make the pages look complete.

**f. Demo store URL for the reviewer.**
A development store in the Partner org with the app installed and enough real
data to click through. Depends on Phase 2.

---

## 7. Listing

Copy exists in **`listing/copy.md`** under the chosen MyMeridian identity, and
its reviewer instructions include monthly and annual Billing API prices. It is
not paste-ready because the demo-store URL, storefront password and monitored
MyMeridian support email still need owner values.

Assets state:

| Item                                       | State                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App icon 1200×1200                         | File exists; verify it matches the final MyMeridian wordmark before upload                                                                                                   |
| Screenshots 1600×900                       | **Locally refreshed.** Six current files were captured and visually checked on 2026-08-11. Re-capture from the final real review store only if its data or identity differs. |
| Privacy policy URL                         | Done — `/privacy`, public                                                                                                                                                    |
| Support page                               | Done — `/support`, public                                                                                                                                                    |
| Name / intro / details / features          | **Drafted and measured** under MyMeridian; re-check after any copy edit                                                                                                      |
| Meridian domain, publisher + support email | **Owner** — §6e; must belong to Meridian, not another product                                                                                                                |
| Feature media (1600×900 or 2–3 min video)  | **Done locally** — `listing/feature-media-1600x900.png`; dimensions are enforced by the listing test                                                                                                 |
| Demo store URL                             | **Missing** — §6f                                                                                                                                                            |
| Setup screencast                           | **Missing — automatic bounce without it**                                                                                                                                    |

The screencast is the one that cannot be worked around. A real development-store
install and first dashboard view now work, so the technical prerequisite is
met. The final recording still needs the chosen public identity, populated
reviewer store and production-like setup; it cannot use the demo bypass.

The Scale cohort claim has been removed without expanding access:
`read_customers` remains absent and no paid plan promises LTV/payback. Scale is
now differentiated by scheduled weekly profit summaries, advanced CSV exports
and multi-store portfolio access at $299/month or $2,990/year. Growth includes
self-service Meta, Google and TikTok connections plus anomaly alerts. Provider
application approval and production credentials remain deployment activation
work, not missing product code.

The remaining catalogue is also scoped to what the runtime enforces. Plan copy
does not claim order-volume limits, because billing never counts or blocks
monthly orders; Scale does not claim location-specific capacity, because the
capacity rebuild currently writes one store-wide `primary` series; and public
copy does not expose the dormant customer-lifecycle product classifier. Prices
are unchanged. The redesigned Acquisition page is now useful without spend, so
a fresh screenshot is included in the refreshed six-image set; only the old
fabricated-spend image remains held as provenance.

---

## 8. Corrections to v1 of this plan

v1 was accurate when written at 18:53. Four things have changed since, three of
them because the work landed:

1. **`shopify app config push` does not exist.** v1's step 8 said to run it. On
   the pinned CLI (`@shopify/cli ^4.6.0`, checked with `npx shopify app config
--help`) the subcommands are `link`, `pull`, `use` and `validate`. Config is
   pushed by `shopify app deploy`, which works here because
   `include_config_on_deploy = true`. Following v1 literally would have failed
   at the last and most important step.
2. **Test count.** v1 said 178 tests in 16 files and this section previously
   recorded intermediate milestones. The current baseline is the §1 result:
   **1,156 passed and 72 skipped** in the default run; the explicit
   real-PostgreSQL integration run passes **72/72** after all 34 migrations.
3. **`Shop.syncCursor` is no longer write-only.** v1 listed "written but never
   read" as a fast-follow. Commit `200a350` reads it; an interrupted import now
   resumes from the cursor instead of restarting.
4. **`Order.fulfillments(first: 10)` is no longer a silent truncation.** v1
   listed it as an outstanding gap. Commit `e98b83d` refetches at 250 when
   `fulfillmentsCount` says there are more.

v1's §5 also treated the dashboard loaders as an unbounded fast-follow. The
runtime is now memory-bounded and whole-history recompute is month-sliced; see
§9 for the remaining supported-volume boundary.

---

## 9. Worklist

### Must happen before submission

- **Protected Customer Data request, Level 2** (§6b). The longest-lead item on
  this page and a hard gate — start it first, everything else can proceed in
  parallel while it's on Shopify's clock.
- **Authenticate to Fly, provision Managed Postgres, deploy, and set the real
  `application_url`** (§2–§5). Cannot exercise OAuth or webhooks without it.
- **Partner Dashboard items** (§6a, §6d) and the refreshed listing assets in §7.
- **Buy Meridian's domain and set its own publisher/support identity** (§6e),
  or a reviewer sees the explicit pre-launch configuration gap.

### Done this session, previously on this list

- **`read_all_orders`.** Shopify approved the request, the scope is in config,
  and the full-history path was exercised in a real development-store install.
- **Core development-store acceptance.** Embedded install, onboarding, monthly
  and annual pricing, test-billing approval/return and zero-order full-history
  completion were verified in Shopify Admin.

- **Dashboard loaders.** Two of the three costs named in `SUBMISSION.md`
  blocker 4 are fixed. `loadEngineOrders` no longer hydrates every fulfilment
  row to add two columns up in JavaScript — Postgres does the sum
  (`fdd75cb`). And `loadDashboard` no longer builds a second complete
  `ShopAnalytics` for the comparison window, which was running a second 365-day
  cohort scan, a second capacity query, a second product-meta query and four
  engine passes on every page load in order to read eight scalars (`381e47f`).
  Both were proved number-for-number: 15 new tests, and `verify-data.ts` output
  byte-identical against live Postgres.

### Current supported-volume state

- **Large accepted analytics windows use the materialized profit ledger.** The
  engine still refuses to truncate an order window. Above its full-hydration
  threshold, analytics switch to exact materialized order fields and SQL
  product roll-ups, validate that every order was computed, and fail visibly if
  the ledger is incomplete. This removes the former 60,000-order refusal without
  inventing partial P&L.
- **Orders paging is closed in code.** `loadOrderPage` uses PostgreSQL keyset
  cursors for recent, best and worst sorts, binds cursors to range/channel/sort,
  fetches at most 61 rows, and falls back to the exact live engine while the
  materialized ledger is incomplete. Forward/backward and concurrency-safe
  behavior is covered against real PostgreSQL.
- **Backfill and recompute request ownership is closed.** Both are deduplicated
  `RecalcJob` kinds persisted before the request returns, claimed with leases,
  retried with backoff and recovered after restart. A production deployment
  still needs an always-available worker, which Fly provides in the chosen
  topology.
- **Real-Shopify import coverage remains the missing proof.** Backfill has 29
  direct orchestration tests plus pagination, resume, field-access and real-
  PostgreSQL claim suites. What those cannot prove is the first historical walk
  against Shopify's live GraphQL responses; Phase 2 remains that acceptance run.

---

## 10. Phases

```
Phase 0 — Decisions and access requests (start immediately)
  0a. DONE: MyMeridian is the non-confusable public identity
  0b. Expand the saved PCD request to ShopifyQL's required name/address/phone/
      email coverage; read_all_orders is already approved

Phase 1 — A real origin
  1a. fly auth login; choose the Fly app slug after Phase 0a
  1b. fly launch; fly mpg create/attach (Managed Postgres)
  1c. fly secrets set  (credentials + real support/legal values)
  1d. fly deploy with the remote builder; verify /privacy and /support
  1e. Edit shopify.app.toml: application_url, redirect_urls,
      automatically_update_urls_on_dev = false
  1f. shopify app deploy  (publishes config to the Partner Dashboard)
  -> Unblocks webhook delivery, the OAuth callback, and everything after

Phase 2 — Exercise it for real
  2a. A Partner development store
  2b. DONE on the development store: install, session storage and token exchange
  2c. Zero-order full-history completion is verified; repeat on representative
      order volume after a populated reviewer store is available
  2d. Fire each webhook for real: place an order, request and redact customer
      data, uninstall and reinstall
  2e. DONE with a Shopify test charge: approval, return redirect and active plan
  2f. Record the setup screencast during this pass
  -> Unblocks the screencast, and confidence in everything above

Phase 3 — Partner Dashboard        Phase 4 — Listing
  §6a manual pricing                 4a. DONE: MyMeridian + annual-plan copy
  §6b protected customer data        4b. Feature media
  §6c read_all_orders                4c. Re-shoot every screenshot from final UI
  §6d emergency contact              4d. Attach the Phase 2 screencast
  §6f demo store URL
  -> Both run in parallel with each other and with the tail of Phase 2.
     Start 3b and 3c first: they run on Shopify's clock, not ours.

Phase 5 — Submit
  5a. npx shopify app config validate
  5b. Submit for review
```

Critical path: Phase 0's access requests run on Shopify's clock and should start
now. Phase 1 blocks Phase 2; Phase 2's real install blocks the screencast and
blocks knowing the backfill survives real data. Phases 3 and 4 run alongside.

---

## Where this leaves it

The local code gate is green: `npm run ci` passes, with 1,156 unit tests passing
and 72 opt-in integration tests skipped, coverage thresholds met, and a clean
production build. The explicit real-PostgreSQL integration run passes 72/72
against a fresh database after all 34 migrations. Billing is enforced in code
and its Shopify test-charge approval/return flow has been exercised.

What remains before submission is infrastructure, external approval, business
decisions, assets, and real-platform proof:

- Shopify Shipping reconciliation has `read_reports`, but the `shipping_labels`
  dataset still needs Level 2 Protected Customer Data approval covering name,
  address, phone and email. MyMeridian does not query or persist name, address
  or phone; this is ShopifyQL's access gate.
- ShipStation's immediate reconciliation webhook is registered only after
  `SHOPIFY_APP_URL` becomes the real public HTTPS origin; until then its tested
  five-minute reconciliation fallback is the only reachable path.

1. **Nobody has run a deploy.** The host is picked and, as of 2026-08-06, the
   §4 files are built and booted rather than merely written (§11). What is left
   is a final app/Fly name, Fly authentication, Managed Postgres, and the
   production sequence in §5. flyctl is installed but not authenticated.
2. **The core development-store path has run.** Embedded installation,
   onboarding, session storage, the zero-order full-history path and a Shopify
   test billing approval/return were verified. Representative order-volume
   backfill, production webhook delivery and production billing remain unproven.
3. **Owner/Partner decisions remain:** expanded Protected Customer Data Level 2
   coverage, MyMeridian domain/support identity, App Store
   registration attestations and payment, emergency contact, demo-store
   details, and the setup screencast. Screenshots and 1600×900 feature media are
   ready locally.

---

## 11. Build verification, 2026-08-06

§1 and §4 both rested on "this machine has no Docker and no flyctl". That is no
longer true, so the claim §4 could not make has now been checked.

**Tooling installed:** flyctl 0.4.79 (`~/.fly/bin`, added to `~/.zshrc`), and
Colima 0.10.3 + Docker CLI 29.7.1 as the container runtime — Docker Desktop was
never installed and Colima needs no license and no GUI. Docker daemon 29.5.2,
4 CPU / 6 GB / 40 GB, `vz` VM type.

### What was verified against the actual image

| Check                                           | Result                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker build .`                                | **Succeeds**, first attempt, no edits to §4's Dockerfile. 790 MB image.                                                                                                                                                   |
| Prisma client survives `npm prune --omit=dev`   | **Yes.** `require('@prisma/client')` loads and reports 6.19.3, and `libquery_engine-linux-arm64-openssl-3.0.x.so.node` is present in the runtime stage. This was the step most likely to silently break, and it does not. |
| `openssl` / `ca-certificates` in base           | **Load-bearing and correct.** The computed binary target is `openssl-3.0.x`, which is what bookworm-slim provides once those packages are installed.                                                                      |
| Server boots                                    | **Yes.** `react-router-serve` comes up and is serving in about two seconds, so fly.toml's 20s `grace_period` is comfortable.                                                                                              |
| `GET /privacy`                                  | **200.** The health check path in fly.toml is right.                                                                                                                                                                      |
| `GET /support`                                  | **200.**                                                                                                                                                                                                                  |
| `release_command` — `npx prisma migrate deploy` | **Runs from inside the image** against a real Postgres. The current migration-set proof is repeated in the release verification below; the Prisma CLI reinstalled after the prune resolves without a network fetch.       |
| `/privacy` and `/support` contact block         | Both show an explicit pre-launch configuration gap while Meridian's domain, publisher and monitored inbox are unset.                                                                                                      |
| `fly.toml`                                      | Parses, and every key lands where Fly's schema expects it. `fly config validate` itself needs an account and was not run.                                                                                                 |
| `npx vitest run`                                | **Historical 2026-08-06 result:** 290 tests in 24 files, all passing. The current baseline is in §1.                                                                                                                      |

### The one fix the build required

**`.dockerignore` did not exist, and the Dockerfile needs one.** §4 runs
`npm ci --include=dev` and _then_ `COPY . .`. With no ignore file, the host's
`node_modules` is copied straight over the freshly installed Linux tree — every
native binary in it, Prisma's query engine included, is darwin-arm64. `COPY . .`
also swept in `.env`, baking the local Postgres URL and Shopify keys into the
image layers. Both are fixed by the committed `.dockerignore`; nothing in §4's
two files was changed.

### Corrections discovered here and folded into §5 on 2026-08-10

1. **The old §5 had no `fly auth login`.** `fly launch` fails with
   `no access token available` on this machine. The current sequence logs in
   first.
2. **`fly launch` otherwise stops and asks about the existing `fly.toml`.** It now
   exists in the repo root, so the command prompts to reuse it. Answer yes, or
   pass `--copy-config` to skip the question. Do **not** let it write its own
   Dockerfile — it will not, because one is already present, which is the
   outcome §5's "decline" note was after.
3. **`fly postgres` is now the _unmanaged_ option and says so.** flyctl 0.4.79
   prints a banner: unmanaged Postgres "is not supported by Fly.io Support and
   users are responsible for operations, management, and disaster recovery",
   pointing at `fly mpg` (Managed Postgres) instead. §5's commands still exist
   and still work. But this is a profitability tool holding a store's entire
   order history, and choosing who owns disaster recovery for it is a decision
   worth making deliberately rather than by following a command written before
   the banner appeared. `fly mpg create` / `fly mpg attach` are the managed
   equivalents.

   **Decided 2026-08-08: Fly Managed Postgres (`fly mpg`), same region as the
   app (`iad`).** See §12 for the reasoning, the commands, and the restore
   procedure. The old §5 `fly postgres create/attach` lines are superseded and
   have now been replaced with `fly mpg` in the current sequence.

Two further things were confirmed while the image was up, both of which back
claims made elsewhere in this file: the container idles at **51 MiB** serving
requests, so §4's 1024 MB VM has room, and booting with
`MERIDIAN_DEMO_MODE=true` while `NODE_ENV=production` **does** abort the
process. This is now defense in depth rather than the only boundary: production
builds alias the demo lookup to a fail-closed stub, and the build scans every
emitted server file for the demo domain and seeded-authentication signature.
The build fails if either survives bundling, regardless of runtime `NODE_ENV`.

### Two things that still cannot be checked here

- **A full amd64 build.** This is an Apple Silicon Mac, so the image built and
  booted above is arm64; Fly machines are x86_64. Building the whole Dockerfile
  for `linux/amd64` locally does not work, but for a reason that has nothing to
  do with this app: esbuild's Go binary crashes under qemu user-mode emulation
  (`failed to load config from /app/vite.config.ts` → "The service was
  stopped", with a Go goroutine dump from
  `esbuild/cmd/esbuild/service.go`). Rosetta would emulate x86_64 well enough,
  but Colima would not register it as the binfmt handler here. **This is an
  emulation artifact and not a defect — nothing in the normal path emulates
  anything.** Plain `fly deploy` builds on Fly's own remote builder, which is
  native amd64, from this same Dockerfile.

  The part of the image that genuinely is architecture-dependent was checked on
  amd64 directly, since it is the only part that could break: in an
  `--platform linux/amd64` container, `npm ci` against this exact lockfile
  succeeds, `prisma generate` emits
  `libquery_engine-debian-openssl-3.0.x.so.node` — matching the OpenSSL 3.0.20
  that bookworm-slim ships — and `new PrismaClient()` loads it. Everything else
  in the image is plain JavaScript.

  What follows from this is one rule: **do not run `fly deploy --local-only`**
  on this machine. It would either fail the same way, or push an arm64 image to
  an amd64 machine. The default remote builder is correct; let it do the work.

- **The app name.** `meridian-profit` is assumed free on Fly; confirming that
  needs an account. If it is taken, the new name has to change in four places
  at once: `app` in `fly.toml`, `SHOPIFY_APP_URL` in §5 step 3, and
  `application_url` plus `redirect_urls` in `shopify.app.toml`.

Nothing in this verification touched a Fly account, a Shopify secret, or the
Partner Dashboard. The commands in §5 remain unexecuted external steps.

---

## 12. Database: the decision, and disaster recovery

**Decided 2026-08-08. Fly Managed Postgres (`fly mpg`), region `iad`, matching
`fly.toml`'s `primary_region`.** This section supersedes §5's
`fly postgres create/attach`.

### Why

Three things drove it, in order of weight.

1. **The import and recovery workers are database-heavy.** Order ingestion now
   commits the source-watermarked header, customer association and child rows in
   one advisory-locked transaction; it is no longer the old six-independent-
   writes path. Co-locating Postgres still avoids multiplying every page and
   worker lease operation by cross-region latency. A healthy run renews a
   five-minute lease every minute, so duration alone never makes it stale; the
   one-hour rule exists only for legacy rows created before leases were added.

2. **The requirement is backups, not a platform.** The gap this closes is that
   nothing backed the database up at all. Managed Postgres gives automated
   backups and point-in-time recovery as a property of the service.

3. **Nothing here needs a BaaS.** The app is plain Postgres and its raw SQL uses
   portable PostgreSQL features. Tenant isolation is defense in depth: every
   merchant query is shop-scoped in application code, while forced RLS runs
   merchant routes through a separate `NOBYPASSRLS` login and transaction-local
   shop/user context. The privileged migration/worker/operator identity is not
   exposed to merchant routes. Supabase and Neon would both work, but neither is
   required; see `docs/DATABASE_SECURITY.md` for provisioning and verification.

### Provisioning

Requires a logged-in flyctl (`fly auth login`) and starts billing.

```
fly mpg create --name <chosen-managed-postgres-name> --region iad
# Record the cluster ID returned by create; `attach` takes that ID, not the name.
fly mpg attach <cluster-id> --app <chosen-fly-app-slug>   # sets pooled DATABASE_URL
```

Set `DIRECT_DATABASE_URL` from the MPG dashboard's separate direct connection
string as shown in the canonical command block above. `fly.toml` maps that
value to `DATABASE_URL` only inside `prisma migrate deploy`; the application
continues using the pooled URL supplied by attach. The release command applies
the schema on first deploy. **Verified 2026-08-08** against a throwaway PostgreSQL 16
cluster: all migrations present at that checkpoint applied cleanly to an empty database,
`prisma migrate diff` reports no drift between the migrations and
`schema.prisma`, the seed's full recompute runs the chunked raw-SQL `UPDATE`
path successfully, and the analytics read path completes over 12,379 orders and
19,532 line items in ~1.4 s at a ~49 MB peak footprint. Nothing in the
migration path is unproven any more.

This split is required now, not a future optimization: Fly MPG attaches the
pooled PgBouncer URL by default, while Prisma's migration engine requires a
direct connection.

### RTO / RPO

State them honestly, because half the data is not reconstructible.

|                                 | Value                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO — Shopify-derived data**  | Backup interval. Source fields are re-fetchable only inside the history Shopify still exposes. Historical COGS snapshots, observed price changes and data older than the accessible order window are not reconstructible. |
| **RPO — merchant-entered data** | **Backup interval, and nothing else.** Not reconstructible from Shopify at any price.                                                                                                                                     |
| **RTO**                         | Restore time of the managed snapshot, plus a redeploy. Minutes, not the previously-unbounded "recreate and hope every merchant notices the banner".                                                                       |

**What a restore must recover, because re-importing cannot:**

- `CostRule` — the merchant's shipping, pick-pack, payment and overhead
  figures. This is the dangerous one: `provision.server.ts` writes defaults for
  a store that has none, so losing it fails **silently** — every profit figure
  is quietly wrong rather than visibly missing.
- `PriceChange` — the price history the elasticity model is fitted to.
  `sync.server.ts` says it directly: it cannot be reconstructed.
- `Connector` — credentials and configuration.
- `DataRequest` and unprocessed `WebhookEvent` rows — held shopper exports and
  mandatory compliance work cannot be recreated after loss.
- `CustomerErasure` together with the exact external
  `MERIDIAN_CUSTOMER_ERASURE_KEY` that keyed it. The table is in the database;
  the secret is not. Back up that secret in the production credential vault
  and never generate a replacement during restore, or the guards become
  unusable and delayed Shopify history can recreate erased shoppers.
- The exact external `MERIDIAN_ENCRYPTION_KEY`; restored connector tokens are
  unusable without it.
- Order history older than 60 days for a store without `read_all_orders`.

### Restore procedure

1. `fly mpg list` — find the cluster and confirm the backup/PITR window.
2. Restore to a new cluster at the chosen timestamp (`fly mpg restore`; check
   `fly mpg restore --help` for the current flag spelling before relying on it).
3. `fly mpg attach <restored> --app meridian-profit` to repoint `DATABASE_URL`.
4. Confirm the app still has the preserved `MERIDIAN_CUSTOMER_ERASURE_KEY` and
   `MERIDIAN_ENCRYPTION_KEY`. If restoring into a replacement Fly app, set the
   exact values recovered from the credential vault; do not generate either
   key again.
5. `fly deploy` — `release_command` runs `prisma migrate deploy`, which is a
   no-op if the snapshot is already at the current migration.
6. **Verify before announcing recovery.** Check `CostRule` first, since its
   loss is the silent one:
   ```
   select "shopId", kind, active, origin, "confirmedAt", "percentRate",
          "fixedPerOrder", "updatedAt"
     from "CostRule" order by "shopId", kind;
   ```
   Then confirm order counts per shop against what the merchant expects, and
   re-run a recompute so materialised profit matches the restored rules.
7. Only re-run a backfill for shops with a genuine gap — it is expensive, and
   a configured diagnostic `MERIDIAN_MAX_BACKFILL_ORDERS` limit must be removed
   or raised before the run can complete.

**Locally rehearsed 2026-08-12.** A custom-format `pg_dump` restored into an
isolated disposable PostgreSQL database; counts matched for migrations, shops,
cost rules, price history, connectors, privacy requests/erasures, webhook
events, orders and queued jobs, and Prisma reported no schema difference. The
temporary database was dropped and the dump moved to Trash. This proves the
repository/local PostgreSQL procedure, not Fly Managed Postgres point-in-time
recovery, provider retention or production-key recovery; those remain mandatory
production acceptance evidence.
