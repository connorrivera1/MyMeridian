# Shopify App Store submission checklist

Status of every requirement Shopify checks, as verified against the code and a
running instance on 2026-08-05, and re-verified from a clean checkout on
2026-08-06. Each verdict cites what was actually run or read, not what the code
comments claim.

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

**`DEPLOY_PLAN.md` now carries the whole path**: Fly.io as the host and why a
serverless one would silently truncate every store's first import, a `Dockerfile`
and `fly.toml` written against this app's build output and route table, and the
exact command sequence. Neither of those two files has been built — there is no
Docker and no flyctl on this machine — so the first `fly deploy` is a debugging
pass. The plan also corrects an instruction that would have failed at the last
step: **`shopify app config push` does not exist** on `@shopify/cli` 4.x, and
config reaches the Partner Dashboard through `shopify app deploy` instead, which
works here because `include_config_on_deploy = true`. Nothing has been deployed
and no credential has been read or written.

`redirect_urls` **is fixed** — it pointed at `/api/auth`, which is the Remix
template's default and a route this app does not have, while `authPathPrefix`
is `/auth`, so the real callback is `/auth/callback`. OAuth would have failed on
the redirect. The host still tracks `application_url`.

### 2. No Partner Dashboard configuration exists yet

Independent of the code, submission needs the following, none of which can be
done from this repo — each is written up with where it lives and what it needs in
`DEPLOY_PLAN.md` §6:

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
| Listing copy — name ≤30 chars, intro ≤100, details ≤500, features ≤80 each | **Drafted** — `listing/copy.md`, paste-ready. Every field measured against its limit rather than estimated (the first details draft read as "about 500" and was 575). Every claim traced to the code that makes it true, and it claims nothing about ad performance — see the flag below. |
| Feature media, 1600×900 or a 2–3 min video | **Missing.** |
| Demo store URL for reviewers | **Missing.** |
| Screencast of the full setup process, English or English-subtitled | **Missing, and blocked on the owner.** An automatic bounce if absent. It has to show a real OAuth install through to a first dashboard view; the app has never been installed on any store, and it cannot be filmed against the demo bypass because that bypass is exactly what the recording exists to prove is not being used. Record it during the first real install rather than staging the flow twice. |
| `extensions/` | Empty, and correctly so — Meridian ships no theme or checkout extension. |

One flag out of drafting the copy, and it is an accuracy problem rather than a
wording one: the Growth plan blurb sells "Unlimited ad channels + blended CAC"
and the Acquisition screen is built, but **there is no ad platform OAuth
anywhere in the tree** — `AdSpend` rows are written only by `prisma/seed.ts`, so
a real store shows organic and direct traffic at zero spend. The drafted copy
therefore promises nothing about ad ROI, CAC or LTV. The plan blurbs are
merchant-visible on `/app/plan` and a reviewer walks that screen during billing
review, so reconciling them is worth doing before submission. Options are laid
out in `listing/copy.md`.

### 4. Performance work before a large merchant installs

Not a hard gate at submission, but Shopify samples Core Web Vitals through App
Bridge at the 75th percentile over 28 days, and the thresholds are LCP ≤ 2.5s,
CLS ≤ 0.1, INP ≤ 200ms.

**Three of the four costs here are now fixed** — see *The dashboard did its most
expensive work twice* and *The order query read eighteen columns nothing used*
below. `loadDashboard` no longer builds a second complete analysis for the
comparison window, `loadEngineOrders` no longer hydrates fulfilment rows to add
them up in JavaScript, and it no longer reads whole `Order` and `OrderLineItem`
rows when the engine uses thirteen columns of thirty-one and nine of thirteen.
Measured on the seeded store (12,379 orders, 19,532 line items): the 30-day
window went 108ms → 72ms and the 365-day window 400ms → 247ms, on both the
reporting window and the comparison window built beside it.

What remains: `loadEngineOrders` still returns every order in the window with no
`take`, and the orders table's `PAGE_SIZE = 60` slices an already-materialised
array, so the database work is identical on page 1 and page 40. It cannot simply
take a `take` — the P&L, the ad attribution and the overhead proration are all
period-wide, so a truncated set of orders yields a confidently wrong profit
figure rather than a slow one.

Closing it properly means computing the roll-up in SQL. Two things were
established this session about what that costs, and both argue for doing it
deliberately rather than before submission:

- **The prize is smaller than it looks.** Now that the projection has landed, a
  measured prototype of the comparison window — orders without line items, plus
  a SQL `SUM(ROUND(unitCost * soldQty, 2))` per order — comes to 39ms against
  the current 75ms. Around 36ms a page load, for a second implementation of the
  COGS and payment-fee arithmetic.
- **Raw SQL over these timestamp columns is genuinely treacherous, and that is
  now demonstrated rather than argued.** The first prototype of that aggregate
  silently dropped 21 orders, because a `Date` bound into `$queryRaw` and
  compared against a `timestamp without time zone` column is rendered in the
  *session* time zone — a four-hour shift on this machine, and one that follows
  DST. Chasing that down is what surfaced the real `firstOrderAt` defect fixed
  below. A roll-up would also have to reproduce `dayKey`'s `Intl` bucketing in
  the *merchant's* zone for ad attribution and overhead, while the column is
  naive UTC and the session is a third zone. Three time zones in one statement
  is where the next silent divergence lives.

One encouraging finding for whoever picks it up: `allocate` distributes overhead
and ad spend by largest-remainder and sums to exactly its input, so the period
*totals* are reproducible in SQL even though the per-order split is not. The
obstacle is the time bucketing, not the profit formula. It wants a
live-database differential test asserting the SQL roll-up equals the engine's
on real data, which is a session of its own.

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

### A split shipment counted as several orders shipped

The Fulfilment screen exists to warn a merchant *before* the warehouse falls
behind, and for any store that splits a shipment it could not. Backlog is
cumulative orders received minus cumulative orders shipped, but received
counted orders while shipped counted **fulfilment rows** — so an order sent in
three parcels retired three orders from a backlog it had only ever added one
to. `Math.max(0, ...)` pinned the result at zero for ever. The capacity
ceiling, which is the busiest day the warehouse has actually had, was inflated
by the same factor, so no real day ever reached it and no alert ever fired.

Three defects on one path:

- **`itemCount` was the whole order's units written onto every shipment of
  it.** A 12-unit order in three parcels recorded 36 units shipped. It is now
  the shipment's own `totalQuantity`, which the import had never asked for.
- **`shippedAt` was stamped unconditionally by the import** while the webhook
  cleared it for a cancelled shipment — one column, two writers, two meanings,
  so a shipment cancelled and re-made counted twice. Both now use
  `fulfillmentDidShip`, and `rebuildCapacityDays` filters on `shippedAt IS NOT
  NULL` rather than writing a second definition of "shipped" in SQL.
- **`fulfillments(first: 10)` truncated silently.** It is a plain list in the
  Admin API, not a connection, so there is no `hasNextPage` to follow — the
  documentation calls `first` a truncation. `fulfillmentsCount` now says how
  many the order really has and a truncated order is refetched at 250, which
  is above any real order since a fulfilment covers at least one line item.
  This closes the last unpaginated collection in the import.

An order is now counted on the day its **last** shipment left — one still
partly in the building has not been fulfilled — while units stay on the day
they physically shipped, because that is the throughput question.

Nine new tests; five fail against the old mapping. `rebuildCapacityDays` is raw
SQL that no mock can judge, so it was driven against real Postgres on a scratch
shop: split shipments, a cancelled one, and an order completing across two
days. Six of those fourteen checks fail against the old query, including the
backlog pinned at 0 and a ceiling of 6 where the store completed 2. Scratch
shop and script deleted.

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

### The dashboard did its most expensive work twice

Every headline in the product carries a change against the preceding window of
the same length, and `loadDashboard` got that comparison by building a second
complete `ShopAnalytics`. So every page load ran a **second 365-day cohort scan**
— the one query deliberately unbounded by the reporting window — plus a second
capacity query, a second product-meta query, and the product, channel, campaign
and capacity engines, and then read eight scalars off the result and threw the
rest away.

`loadPeriodProfit` loads orders, ad spend and cost rules and calls the same
`computeProfitForPeriod` over the same orders. Deliberately not a second way of
computing profit: a comparison figure derived differently from the figure it is
compared against would be a second definition of profit, which costs more than
the query it saves. The returned shape stays `previous.period`, so no route
changed. It reuses a warm full build of the same window, caches on the same key
otherwise, and is cleared by the same invalidation — a comparison window that
survived a recompute would show a delta against numbers that no longer exist.

Separately, `loadEngineOrders` was hydrating every fulfilment row of every order
in the window to add two columns together in JavaScript. A store that splits
shipments paid for that per parcel rather than per order. It is a `groupBy` now.
Both columns are `Decimal(12,2)`, so there is no sub-cent remainder for `SUM` to
accumulate and no rounding for it to move: summing before the cents conversion is
exactly the number summing after it produced. An order with no fulfilments has no
group row, which reads as the same zero the empty array did, and zero still means
"not known yet" rather than "shipped for free", so it still falls back to the
merchant's cost rule.

Fifteen new tests. The load-bearing one asserts deep equality between the lean
roll-up and the full build's rather than spot-checking net profit, and one covers
a window straddling two calendar months — a lean path that dropped the range
argument would bill a full month's rent against a partial month while still
agreeing on revenue and COGS. One more pins the aggregate's `where` clause, since
an aggregate that forgot the window filter would read the whole table and still
look correct on a small store. Then proved where it counts: `verify-data.ts`
against live Postgres, **byte-identical to its output before the change**.

### The order query read eighteen columns nothing used

`loadEngineOrders` selected every column of every order and every line item in
the window and then mapped thirteen of `Order`'s thirty-one and nine of
`OrderLineItem`'s thirteen into `EngineOrder`, dropping the rest one function
later. The dropped ones still cost a read, a transfer and a parse on every
dashboard load, on both the reporting window and the comparison window.

Eight of them are the materialised profit `Decimal`s — `cogsTotal`, `netProfit`,
`contributionProfit` and the rest that `recompute` writes — which are the
expensive kind to waste, since Prisma inflates every `Decimal` into a
`Decimal.js` instance before the mapping gets a chance to ignore it. Leaving
them unread is also the honest thing: nothing on this path should be able to
mistake a write-only cache for an input.

Same rows, same `where`, same `orderBy`, same values — a projection, not a
change of shape. 30-day window 108ms → 72ms, 365-day 400ms → 247ms on the seeded
store. Five new tests pin the column list exactly rather than sampling it, since
a `select` is the one query where adding a field is silent and removing one
surfaces much later as `undefined` read as zero money, plus one that maps a row
carrying only the projected columns so the mapping cannot quietly reach for an
unselected one. `verify-data.ts` against live Postgres is byte-identical to its
output before the change.

### A customer's first order was stored in the server's time zone

`writeCustomerAggregates` wrote `Customer.firstOrderAt` through a raw statement
casting a bound `Date` straight to `::timestamp`. Postgres renders a bound
instant in the *session* time zone before that cast, and the cast then discards
the offset — so the stored value was shifted by whatever `TimeZone` the
connection had. Proved against the live database inside a rolled-back
transaction, writing one known instant three ways:

| Instant | Prisma ORM | `::timestamp` | `::timestamptz AT TIME ZONE 'UTC'` |
|---|---|---|---|
| 2026-03-01T02:30Z | 0h | **−5h** | 0h |
| 2026-03-15T02:30Z | 0h | **−4h** | 0h |
| 2026-08-03T23:53Z | 0h | **−4h** | 0h |

Not a constant error: the offset follows DST, so two orders either side of a
transition move by different amounts and no single correction undoes it.

Every other writer of that column goes through Prisma and stores UTC —
`syncCustomer`, `reconcileFirstOrder`, the backfill and the seed. So this was one
column with two writers and two meanings, the same shape as the `shippedAt`
defect above. `reconcileFirstOrder` exists precisely to settle which order came
first, and the next `recompute` would move the answer it had just settled. The
date is also handed to the shopper in the GDPR export built by
`data-request.server.ts`, which is a poor place to be four hours wrong.

It stayed invisible because a server running in UTC has a zero offset — the one
configuration where this does nothing. It would have read as correct in
production on Fly and wrong on every developer machine, which is the worst way
round for a bug to sit. Four new tests assert the generated SQL; two fail
against the old cast.

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
| Test suite | Done | **221 tests, 21 files, all passing** (verified 2026-08-06 00:18, `npm test`) |
| Engine output unchanged by the query work | Done | `npx tsx scripts/verify-data.ts` against live Postgres, diffed byte-for-byte against its output before the change |
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

1. **`loadEngineOrders` is still unbounded**, and the orders table still pages a
   materialised array. The duplicated comparison-window build, the fulfilment
   row hydration and the whole-row read are all fixed; see Blocker 4 for the
   measured cost of the remaining piece (~36ms a page load) and for why it needs
   a deliberate SQL roll-up with a live-database differential test rather than a
   `take`.
2. **Order-level stored profit is a write-only cache.** `recompute` writes
   `Order.netProfit`, but every dashboard figure is recomputed on the fly and
   nothing reads it back except `contributionProfit` for cohort LTV.
3. **Ad platform connectors are not wired to live OAuth.** Modelled and
   encrypted end to end, but Facebook/Google/TikTok have no OAuth flow, so on a
   real store the acquisition screen shows organic and direct traffic with zero
   spend. The plan copy sells "unlimited ad channels".
4. **Backfill and recompute run in-process.** Correct on a long-lived server,
   wrong on serverless where the process may not outlive the response. Both
   belong in a job queue before deploying there.
5. **The demo auth bypass ships in the production bundle.** Guarded by a
   boot-time throw when `NODE_ENV=production` and by Shopify-signal detection,
   which is solid, but the whole guard depends on `NODE_ENV` being set correctly
   at deploy. A reviewer reading the source will pause here.
6. **The local `.env` still lists withdrawn scopes.** It reads
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
