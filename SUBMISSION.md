# Shopify App Store submission checklist

Status of every requirement Shopify checks, as verified against the code and a
running instance on 2026-08-05. Each verdict cites what was actually run or
read, not what the code comments claim.

Branch: `eevee/meridian-triage`. Nothing has been deployed, pushed or submitted,
and the repo has no git remote configured.

**Read this first:** everything below was verified against a locally running
server with **no Shopify API credentials**. The app has never been installed on
a real store, and no part of the OAuth, webhook-delivery or billing flow has
been exercised against Shopify itself. Where a claim below says "verified", it
means verified at the level stated — over HTTP, against the live database, or
with credentials injected into the real route modules — and the level is named
each time. See *What has not been tested* at the end.

---

## Blockers — the app cannot be submitted until these are done

### 1. `application_url` is still the CLI placeholder

`shopify.app.toml` points at `https://shopify.dev/apps/default-app-home`. Every
webhook `uri` in the file is relative and resolves against it, so **all four
mandatory compliance and app-lifecycle webhooks currently resolve to a host
Shopify cannot deliver to.** Shopify additionally rejects an `application_url`
containing the word "Shopify".

Needs a real, stable, public HTTPS origin, then `application_url` deployed with
`shopify app deploy`. This is the one item everything else waits on.

`redirect_urls` **is fixed** — it pointed at `/api/auth`, which is the Remix
template's default and a route this app does not have, while `authPathPrefix`
is `/auth`, so the real callback is `/auth/callback`. OAuth would have failed on
the redirect. The host still tracks `application_url`.

### 2. No Partner Dashboard configuration exists yet

Independent of the code, submission needs, in the Partner Dashboard:

- The three Billing API plans matching `PLANS` — Starter, Growth, Scale. The
  app creates the charges from code, so nothing needs typing in by hand, but the
  app must be opted into **manual pricing**, not Shopify App Pricing. See
  "Billing" below for why.
- A **Protected Customer Data** request approved, if CAC/LTV/payback are to work
  (`read_customers`). The app degrades honestly without it.
- A **`read_all_orders`** access request, or order history is capped at 60 days.
- An **emergency developer contact** (email + phone) — a separate field from the
  support contact.

### 3. Listing assets are partially there

| Item | State |
|---|---|
| App icon, 1200×1200 PNG | **Done** — `listing/app-icon-1200.png`, rendered from the in-app brand mark. No text, no Shopify marks, square. |
| Screenshots, 1600×900, 3–6 desktop | **Done** — six in `listing/screenshots/`, captured from the running app. |
| Privacy policy URL | **Done** — `/privacy`, public and unauthenticated. |
| Support page | **Done** — `/support`, public. |
| Support email + legal entity | **Missing.** Environment-driven (`MERIDIAN_SUPPORT_EMAIL`, `MERIDIAN_LEGAL_ENTITY`, optional `MERIDIAN_SUPPORT_URL`). Both pages render a visible "not configured" notice until they are set — deliberately, because a reviewer emails whatever is on the page and a placeholder that bounces reads as an unsupported app. |
| Listing copy — name ≤30 chars, intro ≤100, details ≤500, features ≤80 each | **Missing.** Not written. |
| Feature media, 1600×900 or a 2–3 min video | **Missing.** |
| Demo store URL for reviewers | **Missing.** |
| Screencast of the full setup process, English or English-subtitled | **Missing.** An automatic bounce if absent. |
| `extensions/` | Empty, and correctly so — Meridian ships no theme or checkout extension. |

### 4. Performance work before a large merchant installs

Not a hard gate at submission, but Shopify samples Core Web Vitals through App
Bridge at the 75th percentile over 28 days, and the thresholds are LCP ≤ 2.5s,
CLS ≤ 0.1, INP ≤ 200ms. `loadEngineOrders` hydrates every order *and every line
item* in the window with no `take`, and `loadDashboard` does it twice (current
and previous period) plus a 365-day cohort query, on every page load. The orders
table's `PAGE_SIZE = 60` slices an already-materialised array, so the database
work is identical on page 1 and page 40. Fine on the demo store, not fine on a
Scale-plan store sold as "unlimited orders". Aggregate in SQL.

---

## Fixed this session

### Every install would have failed

`Session` was missing `refreshToken` and `refreshTokenExpires`.
`@shopify/shopify-app-session-storage-prisma` 9.x emits both on every
`storeSession()` unconditionally, so Prisma rejected the write with
`PrismaClientValidationError` and **no session was ever stored** — the app could
not complete a token exchange. Verified by driving a real upsert with the exact
row shape the adapter produces against the live database inside a rolled-back
transaction; the `Session` table had stood at zero rows. The schema comment says
its shape is "dictated by" the adapter; it had been copied from a pre-9.x README.

### Expiring offline access tokens

Public apps created on or after **1 April 2026** must use expiring offline
access tokens; all public apps must by **1 January 2027**. Meridian is new, so
the first date applies. `future.expiringOfflineAccessTokens` is now on. This is
not merely an opt-in — with the flag off the library sends `expiring: 0` on
every token exchange, actively requesting the non-expiring token the platform is
retiring.

Consequence handled: tokens now live about an hour, and the admin client handed
to the backfill from `afterAuth` closed over one frozen `Session`. On exactly
the large stores where the import runs longest, every request after the hour
mark would have failed authentication and left a plausible-looking partial
dataset. The import now re-acquires through `unauthenticated.admin()`, which
runs `ensureValidOfflineSession`.

### Billing was declared two ways and enforced in neither

Three Billing API plans in `shopify.server.ts`, managed-pricing wording in the
toml and the subscription webhook, and no `billing.check`, `billing.require` or
`billing.request` anywhere. `Subscription.plan` was read only to render a badge.
Every feature sold as Growth- or Scale-only was served to every store.

Settled on the **Billing API**, which is forced rather than stylistic: since
28 April 2026 Shopify App Pricing no longer sends `app_subscriptions/update`,
and the only way to read a plan under it is the Partner API — an
organisation-level credential the app does not hold and cannot obtain from a
merchant session.

- `lib/plan.server.ts` resolves the plan from `billing.check`, caches it in the
  `Subscription` row for ten minutes, and falls back to the stored row when
  Shopify is unreachable rather than locking out a merchant who has paid.
- Pricing and Fulfilment need Growth; cohort value and payback curves need
  Scale. Capacity alerts no longer leak onto a Starter overview or the nav badge.
- The pricing action re-checks the plan — a form post never goes through the
  loader, so a loader-only gate is decoration.
- A store with no active charge is redirected to `/app/plan` from every route.
- `/app/plan` does upgrade *and* downgrade in-app via `billing.request`, which
  requirement 1.2.3 asks for. The old copy said "change plans from the Shopify
  admin billing screen" and gave no link.

Verified against the running app: forcing the demo to Starter shows upgrade
notices on Pricing, Fulfilment and the Acquisition cohort section; forcing it to
no plan redirects `/app`, `/app/orders` and `/app/settings` to `/app/plan` while
`/app/plan` itself still renders 200.

### App Bridge is now the first script in the head

`AppProvider` renders it from inside `<body>`. `root.tsx` emits it in `<head>`
instead, preceded by the `<meta name="shopify-api-key">` tag App Bridge reads at
load — without which session tokens are never minted and Shopify collects no Web
Vitals at all, which is a silent failure. The layout drops `AppProvider`'s
`embedded` prop so the script is not registered twice, and reproduces the
`shopify:navigate` listener it installed alongside it. Verified against a
running server with credentials set: `app-bridge.js` is script index 0 in
`<head>`. Suppressed for the seeded demo, which App Bridge would redirect out of
the app.

### The import silently lost cost

Every collection nested inside a product or an order was requested with a fixed
`first:` and no `hasNextPage` check. Missing variants and missing line items both
remove cost, and removed cost reads as margin:

- A product with more than 100 variants gave the rest no `Variant` row, so their
  line items snapshotted zero cost and reported 100% margin.
- An 80-line wholesale order lost roughly 40% of its COGS.
- Refund line items were truncated the same way, understating refunds.

Now paginated. Only records that actually overflow cost a follow-up request.

### New SKUs showed 100% margin

`products/create` and `products/update` never wrote `unitCost` — the payload does
not carry it, cost lives on the InventoryItem, and only the install-time backfill
ever read it. A SKU added after install topped the most-profitable list until
someone happened to re-import. The webhook now makes a targeted follow-up query
for variants lacking a measured cost, gated on `read_inventory` because asking
for that field without the scope fails the whole query rather than nulling it.

### Pricing decisions were one-way and silent

The action returned `{ok:false}` with a 200 on every failure and the route never
read `useActionData`, so a failed Accept was a button that did nothing and said
nothing. The loader queried `PENDING` only and regeneration permanently excludes
an actioned variant, so after Accept nothing anywhere showed what had been
accepted and an accidental Dismiss was unrecoverable. Every branch now reports,
and a "Decided" table restores. Verified live: Accept moves the row to `APPLIED`
and banners; Restore returns it to `PENDING` and clears `actionedAt`; a
non-existent id now reports the failure.

### Fulfilment updates were dropped on arrival

`fulfillments/update` is subscribed in the toml and was being delivered.
`syncFulfillmentFromShopify` matched an existing row on
`(shopId, orderId, createdAt)` — and an update repeats the original
`created_at` verbatim, so every update matched, returned early and changed
nothing. Cancellations and carrier corrections never reached the row, and two
shipments created in the same second collapsed into one, undercounting the
shipped series `rebuildCapacityDays` is built from.

Fulfilments now carry Shopify's own id (`shopifyId`, unique per shop, written by
the backfill as well) and the sync upserts on it. The column is nullable so rows
imported before it existed still load; the first update to one of those adopts
it by timestamp rather than writing a second row beside it. Two consequences of
the same fix: a cancelled fulfilment no longer keeps a `shippedAt`, and the
order's `fulfillmentStatus` is derived from whether any fulfilment is still
active instead of being stamped "fulfilled" unconditionally — an order whose
only shipment was cancelled read as shipped forever.

Verified against the live database on a scratch shop, then deleted: two
same-second shipments produce two rows, the update lands as cancelled/FedEx with
`shippedAt` cleared, the order flips to unfulfilled only when both are
cancelled, and a pre-migration row is adopted rather than duplicated. The seven
new tests were run against the old code first — five fail there.

### The first order was decided by which webhook arrived first

`syncOrderFromShopify` set `isFirstOrder` by counting the customer's orders that
precede the one being written. Correct only if orders arrive in the order they
were placed, which webhook delivery does not promise. A second order delivered
first finds nothing earlier and takes the flag; the genuine first order arriving
later also finds nothing earlier, so both stayed flagged and nothing demoted the
impostor. New customers are counted off that flag and CAC is spend divided by
new customers, so the acquisition screen overstated the count and understated
the cost. The same misordering pinned `firstOrderAt` and `acquisitionChannel` to
whichever order created the customer row — putting the spend and the customer it
bought in different channel columns.

`reconcileFirstOrder` now settles it after the order is stored, from all of the
customer's orders: earliest wins, ties fall to the order number Shopify issues
in sequence, and the customer row is repointed at that order. Idempotent, so
redelivery reaches the same answer. The import had the same hole from the other
side — `firstOrderSeen` only knows the current run, so a resumed import, one
that stops at `MAX_ORDERS`, or one on a shop whose webhooks already wrote newer
orders sees only a slice of the customer; `reconcileFirstOrdersForShop` settles
the whole shop in one statement at the end of the import.

Five new tests, run against the old code first — four fail there. The raw
statement was proved against the live database on a scratch shop, since no
prisma mock can say whether a window function partitions correctly: it flags
exactly the earliest order per customer, leaves guest orders untouched, and a
second run changes nothing. Scratch shop deleted after.

### The data export was assembled and then thrown away

`customers/data_request` built the full report for the named shopper — customer
record, every order, every line item — wrote 2,000 characters of it to the
application log, stamped the WebhookEvent as processed, and returned. Nothing
stored it. The route's own comment said the export was "recorded for the merchant
to collect from Settings", Settings had no such surface, and `/privacy` told the
world that "we return everything held about the named customer to the merchant".
Three claims, none of them true: the merchant had a 30-day legal clock and
nothing to answer it with. It also put a shopper's email and order history in the
application log, which is not a place to keep personal data.

Exports now land in a `DataRequest` row (migration `20260805210901`, applied) and
appear in Settings → **Customer data requests**, one line per request with the
customer, when it arrived, what it contains, and a Download JSON button; taking
it stamps `collectedAt` so the audit trail records that the merchant actually
had it. The upsert is keyed on Shopify's delivery id, so a retried webhook
updates the single export rather than stacking copies of one shopper's data. An
export is a second copy of that data, so two things bound it: it is deleted 31
days after the request whether or not it was collected — purged on every read of
the list, so nothing expired is ever offered — and `customers/redact` now deletes
any export still held, including when the customer row has already gone.
Erasure that leaves the export behind erases nothing. The log line is counts
only. `/privacy` now describes what the code does.

Twelve new tests plus five on the webhooks, the latter run against the old code
first — all five fail there. Then driven end to end against real Postgres on a
scratch shop: signed webhook → row stored with both orders and their line items,
31-day window, a retried delivery still one row, collection stamped once and
refused the second time, another shop unable to mark or see it, redaction
deleting the export while the two orders survive anonymised, expiry sweeping an
uncollected export at 32 days, and `shop/redact` cascading it away. Scratch shop
deleted. The Settings surface itself was checked in the running app, not only in
tests: the card renders the request and the collect POST flips it to Collected.

### Other

- `app/scopes_update` webhook added. `grantedScopes` was written only in
  `afterAuth`, so a later grant or revocation left it stale forever — and the
  import gates its GraphQL fields on that record, where stale-permissive fails
  the whole query.
- `@@unique([orderId, shopifyId])` on `OrderLineItem`. Line items are deleted
  and recreated outside a transaction, so two concurrent deliveries of one order
  could interleave into duplicates and double that order's COGS and units.
  Checked for existing duplicates first: none.
- `/privacy` and `/support` added, public and unauthenticated.

---

## Verified working

| Requirement | Verdict | Evidence |
|---|---|---|
| OAuth via token exchange + managed install | Done | `AppDistribution.AppStore` selects `createTokenExchangeStrategy`; no legacy install flag in the toml |
| Expiring offline access tokens | **Fixed** | `future.expiringOfflineAccessTokens` on; `Session` carries the refresh columns |
| Session persistence | **Fixed** | Was failing outright; see above |
| Embedded app, session-token auth | Done | `isEmbeddedApp: true`, bearer-token detection in `app/lib/auth.server.ts` |
| App Bridge first script in `<head>` | **Fixed** | Script index 0, preceded by the api-key meta tag — checked in a rendered document |
| Auth callback route | Done | `authPathPrefix: "/auth"` + splat route; `redirect_urls` path corrected |
| `customers/data_request` | **Fixed** | HMAC-verified; 200 signed, 401 unsigned, 401 tampered, 405 on GET. The export is now stored and collectable from Settings, expires after 31 days, and is verified end to end against Postgres |
| `customers/redact` | Done | Same; anonymises orders in place rather than deleting them, and deletes any held data export |
| `shop/redact` | Done | Same; purges sessions and cascades the shop delete |
| Unverified webhook returns 401 | Done | 401 on every endpoint. The single most-failed automated check |
| Webhook idempotency | Done | `X-Shopify-Webhook-Id` claimed before handling; a replayed delivery returns 200 and writes nothing |
| `app/uninstalled` cleanup | Done | Deletes sessions, stamps `uninstalledAt` |
| `app/scopes_update` | **Added** | Keeps `grantedScopes` honest under managed installation |
| Reinstall re-imports | Done | Reinstall used to leave `syncStatus = COMPLETE`, skipping the backfill |
| Billing: one model, enforced | **Fixed** | Billing API; `billing.check` gating; in-app upgrade *and* downgrade |
| Read-only scopes | Done | `read_orders read_products read_fulfillments read_inventory`; no write scope; accepted price changes are recorded, never pushed |
| GraphQL Admin API only | Done | No REST calls anywhere; new public apps may not use REST |
| Webhook API version | Done | `2026-07`, matching `@shopify/shopify-api` 13.1.0 |
| Production build | Done | `npm run build` clean |
| Test suite | Done | **188 tests, 17 files, all passing** (verified 2026-08-05 19:53, `npx vitest run`) |
| Typecheck | Done | Clean |
| Config validity | Done | `shopify app config validate` passes |
| Every route renders | Done | 12 routes served 200 from a running server, with real computed figures |

The webhook rows are verified at handler level: the running dev server has no
Shopify credentials, so over plain HTTP every webhook endpoint answers 503
before HMAC logic runs. They were re-checked by injecting a test secret and
driving the real route modules against the real Postgres database. `GET → 405`
was confirmed over real HTTP on all endpoints. The 503s themselves prove the
thrown-`Response` → HTTP-status mapping works end to end, since the 503 is
thrown from the same function that throws the 401.

---

## Known gaps that are not blockers, in rough priority order

1. **Dashboard loaders are unbounded.** See Blocker 4.
2. **`Order.fulfillments(first: 10)` is still a hard cap.** It is a plain list
   in the Admin API, not a connection, so there is no `hasNextPage` to follow.
   An order with more than ten fulfilments loses the rest.
3. **Order-level stored profit is a write-only cache.** `recompute` writes
   `Order.netProfit`, but every dashboard figure is recomputed on the fly and
   nothing reads it back except `contributionProfit` for cohort LTV.
4. **Ad platform connectors are not wired to live OAuth.** Modelled and
   encrypted end to end, but Facebook/Google/TikTok have no OAuth flow, so on a
   real store the acquisition screen shows organic and direct traffic with zero
   spend. The plan copy sells "unlimited ad channels".
5. **Backfill and recompute run in-process.** Correct on a long-lived server,
   wrong on serverless where the process may not outlive the response. Both
   belong in a job queue before deploying there.
6. **The demo auth bypass ships in the production bundle.** Guarded by a
   boot-time throw when `NODE_ENV=production` and by Shopify-signal detection,
   which is solid, but the whole guard depends on `NODE_ENV` being set correctly
   at deploy. A reviewer reading the source will pause here.
7. **The local `.env` still lists withdrawn scopes.** It reads
   `read_customers,read_reports,read_analytics` alongside the real four.
    `.env.example` and the toml were corrected, but the file the dev server
    actually reads was not — and `capabilitiesForShop` falls back to
    `process.env.SCOPES`, so this instance claims CAC/LTV capability it does not
    have. Untouched here because it is a gitignored local credentials file.

---

## What has not been tested

No part of this has run against Shopify. There are no API credentials on this
machine — `.env` has no `SHOPIFY_API_KEY` or `SHOPIFY_API_SECRET`, and the
server was started with `npm run dev` rather than `shopify app dev`. So none of
the following has been exercised even once:

- A real OAuth install, or the token exchange that the session fix repairs.
- Real webhook delivery from Shopify, with Shopify's own HMAC.
- `billing.check` / `billing.request` against a real charge, including the
  approval screen and the return redirect.
- The historical import against a real store's catalogue and orders — including
  the pagination and cost fixes, which were unit-tested against a scripted admin
  client but never against Shopify.
- Anything inside the admin iframe: App Bridge session tokens, `frame-ancestors`,
  the embedded launch path.

The next step is `shopify app dev` against a development store. Given the
session-storage defect, it is likely that **no install has ever succeeded**, so
that run should be treated as the first real test of the whole flow rather than
a regression check.
