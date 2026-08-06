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
  app must be opted into **manual pricing**, not Shopify App Pricing. That is
  the non-default choice in the submission form as of 2026 and has to be made
  deliberately; requirement 1.2.1 permits it. See "Billing" below for the
  reasoning, re-verified against live docs on 6 August 2026.
- A **Protected Customer Data** request approved. **This line used to say the
  request only mattered "if CAC/LTV/payback are to work (`read_customers`)" and
  that the app "degrades honestly without it". Both halves are wrong**, and the
  live doc was re-read on 6 August 2026 to be sure of it rather than taken from
  the audit note that first flagged it:

  > "Orders … Orders, draft orders, abandoned checkouts, refunds, transactions,
  > and other data that relate to a single customer."

  Orders are themselves protected customer data, so the request gates
  `read_orders` — the scope the entire product is built on — not just the
  customer extras. Unapproved access is not a clean absence either:

  > "GraphQL requests to unapproved types will return an HTTP `200 Ok` response
  > with an error message in the `errors` hash."

  So this is a **hard gate on first submission, and the longest-lead item in
  the whole list** because it runs on Shopify's review clock rather than ours.
  Start it before anything else here.

  Which **level** to request is decided by one field. `customer { id email }`
  in the order query and `Customer.email` in the schema put Meridian at
  **Level 2** — "Customer data **including** name, address, phone, or email
  fields" — which carries extra attestations (encrypted backups, test and
  production data kept separate, a data loss prevention strategy, staff access
  limits and an access log, strong staff passwords, an incident response
  policy). Requesting Level 1 and discovering the gap later costs another round
  of Shopify's clock.

  The code side of this is now handled: an order import that is refused a field
  drops that field and keeps going rather than aborting, so a reviewer
  installing while the request is still pending gets a working dashboard with
  the refused data missing instead of an empty one. See *The import's only
  recovery path was switched off on every real store* below. That makes the
  wait survivable; it does not remove the gate.
- A **`read_all_orders`** access request, or order history is capped at 60 days.
- An **emergency developer contact** (email + phone) — a separate field from the
  support contact.

### 3. Listing assets are partially there

| Item | State |
|---|---|
| App icon, 1200×1200 PNG | **Done** — `listing/app-icon-1200.png`, rendered from the in-app brand mark. No text, no Shopify marks, square. |
| Screenshots, 1600×900, 3–6 desktop | **Done, five of six.** `fulfilment`, `pricing`, `products`, and `overview` + `orders` re-captured 2026-08-06 against a store with the invented ad spend cleared — Ad spend now reads `$0` with a dash, and the ADS column is `-$0.00` on every order. `acquisition` stays in `listing/screenshots-held/`: re-captured it is accurate and unshippable, four blank headline tiles over a channel table of dashes. Two above Shopify's floor of three, so the listing no longer depends on it. See *The listing was still selling the ad channels* below. |
| Privacy policy URL | **Done** — `/privacy`, public and unauthenticated. |
| Support page | **Done** — `/support`, public. |
| Support email + legal entity | **Missing.** Environment-driven (`MERIDIAN_SUPPORT_EMAIL`, `MERIDIAN_LEGAL_ENTITY`, optional `MERIDIAN_SUPPORT_URL`). Both pages render a visible "not configured" notice until they are set — deliberately, because a reviewer emails whatever is on the page and a placeholder that bounces reads as an unsupported app. |
| Listing copy — name ≤30 chars, intro ≤100, details ≤500, features ≤80 each | **Drafted** — `listing/copy.md`, paste-ready. Every field measured against its limit rather than estimated (the first details draft read as "about 500" and was 575). Every claim traced to the code that makes it true, and it claims nothing about ad performance — see the flag below. |
| Feature media, 1600×900 or a 2–3 min video | **Missing.** |
| Demo store URL for reviewers | **Missing.** |
| Screencast of the full setup process, English or English-subtitled | **Missing, and blocked on the owner.** An automatic bounce if absent. It has to show a real OAuth install through to a first dashboard view; the app has never been installed on any store, and it cannot be filmed against the demo bypass because that bypass is exactly what the recording exists to prove is not being used. Record it during the first real install rather than staging the flow twice. |
| `extensions/` | Empty, and correctly so — Meridian ships no theme or checkout extension. |

The one accuracy flag out of drafting the copy was recorded as **closed** on
2026-08-06 and was not — the fix reached `plans.ts` and the Acquisition banner,
and the listing media it was really about was never looked at. Reopened and now
closed for real; see *The listing was still selling the ad channels* below. The
sentence that used to sit here claimed nothing merchant-visible sold ad
performance, which was the claim that stopped anyone checking.

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

### Git state re-verified clean; `AUDIT-LIVE-REQUIREMENTS-2026-08-06.md`'s findings are already resolved

A prior deputy's handoff flagged that a *later* run had hit
`isolated_worktree_reconciliation_required` — i.e. work stranded on an
unmerged worktree/branch again, the recurring failure mode for this project.
Re-checked from scratch this session: `git worktree list` shows exactly two
worktrees (`/Users/connorrivera/Meridian` on `eevee/meridian-triage`,
`/Users/connorrivera/Meridian-wt-113` on `eevee/meridian-deputy-113`);
`git log eevee/meridian-triage..eevee/meridian-deputy-113` is empty, so
deputy-113's work is fully merged and nothing is stranded. `git fsck
--unreachable` turns up eight dangling commits, all `git stash` autostash
artefacts or a pre-amend duplicate of a commit already on the branch — none of
them unique unmerged work. `main` is 62 commits behind `eevee/meridian-triage`
with nothing unique to `main`. Nothing needed reconciling this pass; the branch
is exactly where the last verified handoff (`825a1dd`, then `29ad5ec`) left it.

Separately, `AUDIT-LIVE-REQUIREMENTS-2026-08-06.md` (untracked, owner-visible
audit notes, left in place) turns out to already be resolved on this branch for
every finding checked against current code:
- **N1's code-side mitigation** ("the import's only recovery path…", directly
  below) — done, commit `cdf940b`.
- **N2** (privacy policy falsely claiming no shopper contact details are
  held) — done, commit `9199895`; `app/routes/legal.privacy.tsx` now discloses
  the stored email explicitly and consistently.
- **N5** (GDPR webhook assembling a full export inside Shopify's 5-second
  response window) — done, commit `7edec96`; `handleWebhook` now responds 200
  as soon as the delivery is verified and claimed, and runs the handler after.
- **N6** (App Bridge absent on the root error document) — done, no dedicated
  commit found by message but present in code:
  `app/root.tsx`'s `errorDocumentApiKey()` handles exactly this case.
Only genuinely new/unresolved findings from that audit are N3 (app name
collision — a business decision, not a code fix) and N4 (Billing API vs App
Pricing — a deliberate choice to make at submission, not a defect). Recorded
here so the next deputy doesn't re-derive this.

### `loadDashboard` — the loader every dashboard screen goes through — now has its own test

Known gap #7 named it directly: `loadDashboard` (`app/lib/route-data.server.ts`)
had no test, despite being upstream of every dashboard route
(`app.overview.tsx`, `app.orders.tsx`, `app.products.tsx`, `app.fulfilment.tsx`,
`app.acquisition.tsx`, `app.pricing.tsx`). Added
`app/lib/route-data.test.ts` — 12 cases covering the one piece of arithmetic
unique to the function (the previous-period window tiles the current one, no
gap, no overlap, same length), that `isDemo` is threaded through to
`resolveRange`'s `anchorToData` rather than hardcoded, that each downstream
loader gets the range it owns, that `resolvePlan` is called with the shop
context, and that the demo shop gets every capability regardless of
`grantedScopes`. `resolveRange`, `capabilitiesForShop` and
`loadShopAnalytics`/`loadPeriodProfit` are already covered elsewhere
(`app/data/ranges.test.ts`, `app/lib/scopes.test.ts`,
`app/data/analytics.test.ts`), so this test only pins the wiring between them,
matching the mocking style already used in `recompute.test.ts` and
`webhooks.hmac.test.ts`. Verified the test isn't vacuous by temporarily
breaking the previous-period arithmetic in `route-data.server.ts` (`to:
range.from.getTime()` instead of `range.from.getTime() - 1`), confirming the
test failed, then reverting — `git diff` on that file is empty.

Also re-confirmed while scoping this: known gap #7's other half,
"none of [the six non-GDPR webhooks] has an HMAC-rejection test of its own,"
is already stale — `app/routes/webhooks.hmac.test.ts` (commit `d075cc4`)
covers exactly that. Text below corrected to match.

What's still genuinely untested: 20 of 21 route loaders remain uncovered
(`app.orders.tsx`, `app.products.tsx`, `app.fulfilment.tsx`,
`app.acquisition.tsx`, `app.pricing.tsx`, `app.settings.tsx`, `app.plan.tsx`,
`app.layout.tsx`, `auth.*`, `home.tsx`, `legal.*`) — most are thin wrappers
over `loadDashboard` or already-tested pieces, but none has a test asserting
that wiring specifically. `loadEngineOrders` is also still unbounded (Blocker
4) — deliberately not touched this pass; SUBMISSION.md already documents why a
SQL roll-up is a session of its own (three time zones in one statement) rather
than a quick fix, and this pass wasn't going to rush that with no live
database to differential-test against.

Baseline before this change: typecheck clean, vitest 348/348 in 29 files,
`verify-data.ts` exit 0 twice, byte-identical
(`fe961cfb99bbc1d17f906fe7c242768e871b21304fa15b8a40ef5c99dad237b6`), build
clean. After: typecheck clean, vitest 360/360 in 30 files (348 + 12 new,
nothing else changed), `verify-data.ts` exit 0 twice, same SHA (test-only
change, no data or schema touched), build clean.

### The import's only recovery path was switched off on every real store

A field Shopify refuses is a capability difference rather than a failure, and
the plumbing for that has been right for a while: access-denied comes back as
HTTP 200 with an `errors` hash, and `gql` raises `ShopifyFieldError` so the
caller can ask again with a narrower query.

The caller narrowed exactly one way. It assumed every field error was
`customerJourneySummary`, and it only attempted the retry when the journey was
still enabled — and the journey is enabled from `capabilities.customers`, which
reads `read_customers`, which is **not one of the four scopes in
`shopify.app.toml`**. So on every non-demo store the flag was false before the
first request went out, and the entire recovery path was dead code. Any refused
field aborted the whole import; the merchant got a dashboard of zeroes and a
failed sync.

That is the state a reviewer installs in. Scopes granted and the protected
customer data request approved are two separate permissions (see Blocker 2), so
fields can be refused on a store that granted every scope the app asks for.

The degrade is now decided by the error message instead of guessed: the first
optional group still in the query that the message implicates is dropped, in
order of how little is lost — journey, then customer identity, then fulfilments.
Customer access takes the journey with it, since it is the same shopper and a
second round trip to be told so again buys nothing. A refusal naming a field the
import cannot do without still throws, because degrading there would store a
store's orders with no money on them. Each pass disables at least one group, so
a store that refuses everything terminates instead of looping on the refusal.

Seven new tests in `app/lib/backfill-field-access.test.ts`, four of which fail
against the old code. `cdf940b`.

### Two things were correct and nothing would have noticed them changing

No defect behind either of these — both paths were already right. What was
missing was anything that would fail if they stopped being.

**HMAC on the six webhooks that are not compliance topics.**
`webhooks.gdpr.test.ts` proves `customers/data_request`, `customers/redact` and
`shop/redact` answer 401 to an unverified request, because that is the check
Shopify's automated review runs. Nothing proved it for `orders`, `products`,
`fulfillments`, `app/uninstalled`, `app_subscriptions/update` or
`app/scopes_update` — and those are the ones that write the merchant's numbers.
An unverified `orders/create` reaching `syncOrderFromShopify` books revenue from
a payload anyone on the internet can POST. All six go through `handleWebhook`,
so they were covered by construction, which is exactly what a route that quietly
stopped calling it would still satisfy.

`app/routes/webhooks.hmac.test.ts` drives the real route modules against real
verification with only the database and the sync layer mocked: forged signature,
signature from the wrong secret, absent header and empty header on each, every
one asserting that no `WebhookEvent` row and no downstream write happened —
a 401 that had already written is a passing status code and a breach. A positive
control per endpoint stops the suite passing by rejecting everything, and three
`handleWebhook` promises that nothing checked are now checked: a replayed
delivery id is suppressed rather than booked twice, a throwing handler still
answers 200 so Shopify does not retry until it disables the subscription, and
`refunds/create` is not fed to the order sync. Verified by breaking the source
twice — removing the missing-signature guard fails 12, reading the shop and
topic straight off the headers instead of verifying fails 12 — then reverted.

**`runBackfill` itself.** The four `backfill-*.test.ts` files cover the import's
pieces — GraphQL errors, the resume cursor, nested-collection pagination, the
fulfilment rows — and not one of them calls `runBackfill`. So the orchestration
was untested, and it is where the expensive mistakes live: clearing `syncCursor`
on success and keeping it on failure are one line each, in opposite directions,
and getting either backwards costs a merchant the whole walk or skips the store
entirely. `app/lib/backfill.test.ts` adds 23 covering that pair, the failure
path and its 500-character truncation, the resume arithmetic, both capability
branches, the per-order writes (refunds summed across every refund touching a
line, cost snapshotted with "0" for an unknown variant rather than a 100%
margin), and `backfillIsStale`. The expiring-token fix is driven through
`runBackfill` with a clock that ages past the limit mid-import, so it proves
`refreshingAdminClient` is wired in rather than merely present. Verified by
breaking the source twelve ways, one test failing per break, all reverted.

`verify-data.ts` against live Postgres is byte-identical to its output before
this work, which it must be — nothing here touched a line of application code.

### The day the clocks went forward fell out of the chart

`dailySeries` builds the daily buckets behind the Overview and Orders charts. It
created them by adding a fixed 86,400,000ms to `range.from` and reading the
*local calendar day* off each stamp. Those two things disagree the moment the
shop's zone changes offset inside the window: the stamps drift an hour against
the local clock, and once the drift carries one across midnight a real calendar
day gets no bucket. Every order placed that day then hit the `!bucket` branch
and was dropped from the chart, while the headline KPI row beside it — computed
from the same orders by a different path — still counted them.

Nothing exotic was needed to fire it. The default 30-day range, an
`America/New_York` store, and a dashboard loaded in the hour after local
midnight on 2026-03-20 produced a series with no bucket for 2026-03-08 at all.
Measured, not reasoned about: a probe over all 24 hourly anchors across both
2026 transitions reported `MISSING 2026-03-08` for exactly the anchor that put
the stride within an hour of midnight, which is why it survived being read.

The walk now steps one *calendar* day at a time, anchored on local midday —
twelve hours of slack against a transition that moves an hour. `DailyPoint`
carries the day it belongs to as a `key`, so buckets are no longer identified by
an instant that has to be re-derived. A new `series.test.ts` asserts the emitted
days equal the days the window genuinely spans, for every hourly anchor across
both northern transitions and both southern ones.

Separately, `app.orders.tsx` formatted those buckets with
`toLocaleDateString` and no `timeZone`. That runs in the loader, so a bucket
keyed in the shop's zone was captioned in the *server's* — off by a day for any
store west of it. It now states the shop's zone.

`verify-data.ts` is byte-identical: it does not build a series.

### The warehouse's days were cut on someone else's midnight

`rebuildCapacityDays` is the source of every figure on the Fulfilment screen —
backlog, throughput, the capacity ceiling, days-to-clear. All three of its raw
statements grouped with a bare `date_trunc('day', …)`. Those columns are
`timestamp without time zone` holding UTC, so that cuts the day on UTC midnight:
**4pm** for a Los Angeles store. Every order placed in the merchant's evening —
the busiest hours they have — was received on tomorrow's row. The backlog, the
throughput and the ceiling every alert is measured against were built on a day
boundary the warehouse does not work to, and one that disagreed with the day
every other screen buckets by, which uses the shop's zone via `dayKey`.

The demo store cannot show this, and that is why it lasted. Checked against the
live database: the seed places orders only between 08:00 and 23:59 UTC, which is
00:00 to 15:59 in the store's own Los Angeles zone. All 12,379 orders, and every
fulfilment (all stamped 15:00 UTC), fall on the same calendar day either way —
zero shifted. The one configuration where the bug does nothing is the one
configuration that ships.

Each statement now reads the stored instant as UTC and renders it in the shop's
zone before truncating. An unusable or missing `timezone` falls back to UTC,
because Postgres throws on a zone name it does not know and this runs at the very
end of an import — a bad value would have cost the merchant the entire walk.

Proved against real Postgres rather than asserted: the rebuild was run against
the demo database and its 187 rows diffed against the 184 already stored. Every
`ordersReceived`, `ordersFulfilled`, `unitsFulfilled` and `backlogEnd` matched
exactly. The only differences were the ones the function has always had when run
outside the seed — it writes `staffedHours` as 0 and extends the series to today
— so the snapshot was restored and `verify-data.ts` is byte-identical.

`rebuildCapacityDays` had no test at all before this, which is to say the
split-shipment rule fixed earlier this session was held in place by nothing. A
new `backfill-capacity.test.ts` covers all three statements and the arithmetic
on their results, including the `MAX("shippedAt") GROUP BY "orderId"` collapse.

### The one ad channel with no row at all

The Settings screen renders one row per `Connector`, so a provider with no row
is not shown as "Not configured" — it is not shown at all. `TIKTOK_ADS` was in
that position: declared in the schema enum, labelled and given a purpose string
on the Settings screen, and created by `prisma/seed.ts` — but never created by
`ensureShopProvisioned`. The demo store therefore listed a TikTok Ads connector
that no real install could ever produce, while the engine went on computing
TikTok CAC, LTV:CAC and ROAS beside a table that did not mention TikTok.

That is the same defect as the listing copy that sold channels the app cannot
connect, one layer down: the demo showing a merchant something the product does
not do. Provisioning now writes one row per provider, `NOT_CONFIGURED` for
everything except Shopify, and `provision.test.ts` reads the enum rather than
restating the list — so adding a provider without provisioning it fails.

A store installed before a provider existed has no row for it either. Those are
backfilled on reinstall with `skipDuplicates`, which leaves a connected row's
token, display name and sync stamp untouched. Deliberately not done on every
call: `ensureShopProvisioned` runs on every authenticated request, and reinstall
is already a write.

### The range parameter that would rewrite a lifetime as a window

Known gap 7 from the previous session, closed. `writeCustomerAggregates` builds
`ordersCount`, `lifetimeRevenue`, `lifetimeProfit` and `firstOrderAt` from only
the orders the recompute loaded, then writes them under lifetime names. Bounded
to a window those become window totals wearing a lifetime label, and
`firstOrderAt` is dragged forward to the earliest order *in the window* —
undoing what `reconcileFirstOrder` settles, on the same column whose time-zone
handling was fixed the session before.

All four callers passed no range, so it never fired. The parameter was public,
optional, and shaped exactly like a safe incremental-update knob: a loaded gun
left on the table. It is gone. Anyone who wants an incremental recompute now has
to solve the lifetime-aggregate problem first, which is the conversation the
default was hiding. Three tests hold the function to one argument and to loading
from the epoch.

### The listing was still selling the ad channels

The fix below stopped `/app/plan` and the Acquisition screen selling ad-platform
capability the app does not have, and this document then recorded the problem as
closed: *"nothing merchant-visible sells ad spend, CAC or ROAS any more."*

The listing screenshots are checked into this repo and are more merchant-visible
than any screen in the app — they are what someone reads while deciding whether
to install, and what the reviewer compares against a real install. Three of the
six still sold it:

- `acquisition.png` — Blended CAC $54.56, Paid spend $80.2K, Marketing efficiency
  6.50×, Platform over-claim $211.8K, and a channel table giving Facebook, Google
  and TikTok Ads a spend, a CAC, a claimed-vs-measured ROAS and a **Profitable**
  verdict.
- `overview.png` — an **Ad spend $80.2K** headline tile.
- `orders.png` — an **ADS** column with a figure on every order, −$112.11 on the
  first row.

`products.png` was checked and kept: it names ad spend as one of the costs
allocated to a product, which stays true at zero, and every figure on it comes
from orders. `fulfilment.png` and `pricing.png` carry no ad figure.

**The cause was one layer below the screenshots.** They were captured from the
seeded demo store, and `prisma/seed.ts:949` fabricated `AdSpend` for every
campaign for every day. That store is not a private fixture — it is the source of
the listing media and the target of the demo store URL a reviewer is given. So
the seed was the last thing in the repo still producing figures nothing else can
produce, and fixing only the screens would have left it writing them back.

Fixed: the seed no longer writes `AdSpend`, and the three screenshots are held in
`listing/screenshots-held/` with a README naming what each one advertised and the
re-capture steps. `CAMPAIGNS` and per-order UTM attribution are untouched, so the
demo still shows channel revenue and contribution profit — the capability Starter
genuinely sells.

`app/lib/listing.test.ts` carries the guard: the seed may not write `AdSpend`, no
shipped screenshot may be byte-identical to a held original, `acquisition.png`
stays held while there is no connector, the set stays within Shopify's three-to-six
band, and this document may not carry the sentence that declared the flag closed.
Verified to fail by reverting each in turn. Lift it with the guard in
`plan.test.ts`, in the same change that ships a real connector.

**Re-captured 2026-08-06.** `overview.png` and `orders.png` are shipped again and
the set is at five. The blocker was two things and neither was the app: the
database still held 1,288 `AdSpend` rows from the old seed, and no renderer had
been found — `/Applications/Google Chrome.app` exits headless here without
writing a file. Playwright's `chrome-headless-shell` is already cached under
`~/Library/Caches/ms-playwright/` and screenshots cleanly; that is the capture
path to reuse. The rows were cleared surgically rather than by `npm run db:reset`,
which Prisma refuses to run for an AI agent without Connor's explicit consent:
delete the `AdSpend` rows, then re-run the same engine tail the seed runs
(`recomputeShopProfitability` + `generatePricingRecommendations`) so the
persisted per-order `adCostAttributed` and customer aggregates are rewritten from
the empty spend set. Result: 0 spend rows, 0 orders with non-zero ad cost, 12,379
orders and 9,192 customers recomputed, unattributed ad spend $0.00.

**Still open on the media:** `acquisition.png`, and it is now a product gap rather
than an accuracy one. Feature media and the demo store URL are also still missing.

### The app sold ad channels it cannot connect

Starter advertised "One ad channel connected" and Growth "Unlimited ad channels +
blended CAC" on `/app/plan`, a screen the Shopify reviewer walks during billing
review while comparing the listing against a real install. Neither is true and
neither can be made true at runtime: there is no ad-platform OAuth flow and no
platform API client anywhere in the tree, `provision.server.ts:97` creates every
connector `NOT_CONFIGURED` and nothing ever configures one, and the only writer of
`AdSpend` in the repo is `prisma/seed.ts:949`. The seeded demo shows spend; every
real store shows `$0.00` for the life of the install.

Underneath it, `FEATURE_MIN_PLAN.multiChannelAds` was a **gate with no call
site** — `planAllows(plan, "multiChannelAds")` appears nowhere in the app, while
`pricing`, `capacity` and `cohorts` each have real enforcement points. It could
not have had one, because there is no capability to withhold. This is the same
fault `plan.server.ts` exists to fix, one layer down: sold in two places,
enforced in neither.

Fixed: both claims removed, the dead gate deleted. Starter now reads "Revenue and
profit by channel", which needs no platform token — orders are attributed to a
channel from their UTM parameters and referring site (`sync.server.ts:76-100`)
and each channel carries real `netRevenueCents` and `contributionProfitCents`.
Growth keeps its two genuine gates. **Prices, plan names and order caps are
unchanged.**

`plan.test.ts` now carries the guard instead of the intention: `no plan sells ad
spend, CAC or ROAS` fails on any plan whose copy contains `ad channel`, `ad
spend`, `cac`, `roas` or `blended`, with a message naming the reason. It was
verified to fail by putting the old Growth bullet back, then reverted. Lift it in
the same change that ships a real connector, not before.

The Acquisition screen already degraded honestly on zero spend — CAC and
marketing efficiency render `—` rather than a misleading `0` — but gave no
reason, while the missing-`read_customers` case on the same screen explains
itself in full. It now carries a banner stating that no ad platform is connected,
that spend is never inferred from orders, and that the channel revenue and profit
below are measured from the merchant's own orders and are unaffected.

Verified: 223 tests pass (was 221), typecheck clean, `npm run build` clean, and
against a running dev server `/app/plan` renders the new bullets with no trace of
the old ones and `/app/acquisition` still returns 200. The banner itself was
confirmed to render by inverting only its condition against the seeded store —
which has spend, so it is correctly absent in normal operation — and reverting.

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

Settled on the **Billing API**. That choice stands, but the reasoning
originally given for it does not survive contact with the current docs, and is
restated below.

#### Re-verified against live docs, 6 August 2026

Every quote here was fetched from shopify.dev on 6 August 2026, not recalled.

**The decision is unchanged: ship on the Billing API.** It remains expressly
permitted for a new public app. Requirement 1.2.1 is titled "Use Shopify App
Pricing or the Shopify Billing API", and reads: *"Apps that use off-platform
billing cannot be distributed through the Shopify App store. Your app must use
Shopify App Pricing or the Shopify Billing API for any app charges."* There is
no new-app carve-out in 1.2.x, and no published sunset date for the Billing
API. As of today Shopify's own migration tooling is at phase one — plan
preparation only; *"preparing plans in the tool doesn't migrate your existing
shops or subscriptions"* — so the path that would move subscriptions has not
shipped.
<https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements>,
<https://shopify.dev/changelog/prepare-your-app-for-migration-to-shopify-app-pricing>

**What was right.** *"After April 28, 2026, Shopify App Pricing no longer sends
webhooks for subscription changes. Use the Partner API and URL redirect
parameters instead."* The `app_subscriptions/update` reasoning in
`plan.server.ts`, `shopify.app.toml` and `webhooks.app-subscriptions.tsx` is
accurate. Note the removal applies only to the App Pricing path — the topic is
still live for the Billing API, which is what this app is on.
<https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing>

**What was wrong, and is corrected here.** The claim that the Partner API is
"an organisation-level credential the app does not hold and cannot obtain from
a merchant session" is a category error. It is *our own* Partner org's
credential, generated in our own dashboard and held as a backend secret:
*"Access the Active Subscription and Historical Events APIs through the Partner
API with Partner API credentials"*, where *"{org_id} is the organization ID
shown in your Partner Dashboard URL"*. Nothing about it is merchant-granted.
There is also a second mechanism the original reasoning missed entirely — the
`plan_handle` URL redirect parameter, *"The plan that the merchant is subscribed
to"*, delivered when a merchant selects or confirms a plan, which is readable
from an ordinary session. So App Pricing is not unreadable from a merchant
session, and this repo should not claim it is: a reviewer can falsify that
sentence in one page load.
<https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/migrating-to-shopify-app-pricing>

**The honest reasoning, which is a cost argument and not an impossibility
one.** App Pricing would require a second credential and a non-Admin-API
dependency — *"Update code that uses the GraphQL Admin API to check
subscription status, such as billing.check() or currentAppInstallation queries,
to use the Partner API equivalents"* — plus redirect-parameter handling to
cover changes between polls, replacing a `billing.check` that reads from the
same Admin session as everything else in the app. That is real work against a
billing implementation that is finished, tested and gated, for no requirement
gain. Not migrating.

**The cost of the choice, stated plainly.** App Pricing is now Shopify's
default: *"Shopify App Pricing is the default option when you submit a new
public app for approval"*, and *"the default and recommended approach for all
apps published on the Shopify App Store"*, with the Billing API described as
*"still supported for existing apps and outlier pricing models Shopify App
Pricing doesn't cover"*. Choosing manual pricing is therefore an explicit
opt-out at submission and may draw a reviewer question. The answer to that
question is 1.2.1, quoted above. Requirement **1.2.3** is the one that has to
hold under manual pricing, because App Pricing would handle it for us — in-app
upgrade *and* downgrade without contacting support or reinstalling. It is
implemented and listed below.
<https://shopify.dev/docs/apps/launch/billing>,
<https://shopify.dev/docs/apps/launch/billing/manual-pricing>

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

### Every returning customer counted as an acquisition

CAC, LTV:CAC, payback, each channel's verdict and every product's loss-leader
label all rest on one fact — which order was the customer's first. Three places
needed it and all three inferred it from position inside the loaded window
rather than reading `Order.isFirstOrder`, the column `reconcileFirstOrder` and
`reconcileFirstOrdersForShop` exist to keep honest, and which `loadEngineOrders`
was already selecting onto every `EngineOrder`.

Journeys are built from the orders loaded *for* the reporting window, so a
customer acquired two years ago who reorders this month has their earliest
visible order read as an acquisition. `computeChannelPerformance` carried a
filter meant to prevent precisely that:

```ts
// Only customers actually acquired inside the window — mixing in customers
// acquired earlier would deflate CAC.
j.acquiredAt >= options.periodStart && j.acquiredAt <= options.periodEnd
```

It cannot work. Every journey's `acquiredAt` is inside the window by
construction, so the bounds excluded nothing and the comment documented a
guard that was a no-op.

Measured against the demo database, on the range the dashboard actually
defaults to:

| Window | Customers seen | Counted as new | Actually new | Facebook CAC shown | True |
|---|---|---|---|---|---|
| 30 days (default) | 2,951 | 2,951 | 2,068 | $53.87 | **$62.24** |
| 7 days | 724 | 724 | 450 | $53.55 | **$67.78** |
| 6 months (`verify-data`) | 9,192 | 9,192 | 9,192 | $67.13 | $67.13 |

CAC is the denominator of LTV:CAC and the bar payback is measured against, so
one deflated number flatters three at once and can carry a channel's verdict
from MARGINAL to PROFITABLE. `computeCampaignPerformance` had the same defect
with no date filter at all. `computeDownstreamValue` had it too, and there it
decides a headline label: a clearance mug that acquired nobody was reported as
a deliberate `STRATEGIC_LOSS_LEADER`, credited with six customers and $420 of
other people's repeat purchases — confirmed by running the engine both ways.

`CustomerJourney` now carries `acquiredInWindow`, taken from the order's own
flag, and everything that divides by "customers acquired" filters on it. So
does the LTV curve: a customer acquired before the lookback has a false day
zero and a timeline missing its opening orders, and averaging them in measures
a fragment of a journey against a whole CAC. `loadCohortRows` reads the one
extra boolean this needs, pinned by its own projection test.

It survived because the test that claimed to cover it handed January orders to
a February `periodStart` — input no loader can produce. Rewritten against a
realisable window, it fails. Six of the seven new tests fail against the
previous engine.

`verify-data.ts` is byte-identical. Its window spans the demo store's entire
history (2026-02-01 to 2026-08-04, and the earliest order is 2026-02-01), so
every customer in it really was acquired inside it and there is nothing here
for the fix to change — which is also why six months of demo data never showed
the bug, and why the third row of that table matches.

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
| Unverified webhook returns 401 | Done | 401 on every one of the nine endpoints, and now guarded by tests on all nine rather than by a check someone ran once — forged signature, signature from the wrong secret, absent header, empty header, each asserting no write happened, plus a positive control. The single most-failed automated check |
| Webhook idempotency | Done | `X-Shopify-Webhook-Id` claimed before handling; a replayed delivery returns 200 and writes nothing |
| `app/uninstalled` cleanup | Done | Deletes sessions, stamps `uninstalledAt` |
| `app/scopes_update` | **Added** | Keeps `grantedScopes` honest under managed installation |
| Reinstall re-imports | Done | Reinstall used to leave `syncStatus = COMPLETE`, skipping the backfill |
| Billing: one model, enforced | **Fixed** | Billing API; `billing.check` gating; in-app upgrade *and* downgrade |
| Read-only scopes | Done | `read_orders read_products read_fulfillments read_inventory`; no write scope; accepted price changes are recorded, never pushed |
| GraphQL Admin API only | Done | No REST calls anywhere; new public apps may not use REST |
| Webhook API version | Done | `2026-07`, matching `@shopify/shopify-api` 13.1.0 |
| Production build | Done | `npm run build` clean |
| Test suite | Done | **348 tests, 29 files, all passing** (verified 2026-08-06 17:29 on the merged branch, `npx vitest run`) |
| Engine output unchanged by the query work | Done | `npx tsx scripts/verify-data.ts` against live Postgres, diffed byte-for-byte against its output before the change |
| Typecheck | Done | Clean |
| Config validity | Done | `shopify app config validate` passes |
| Every route renders | Done | 12 routes served 200 from a running server, with real computed figures. Re-checked on the merged branch 2026-08-06 17:32: `/app`, `/app/orders`, `/app/products`, `/app/acquisition`, `/app/fulfilment`, `/app/settings`, `/app/plan`, `/privacy` and `/support` all 200 with content, `/` 302 as designed — the orders screen and the fulfilment figures specifically, since the DST and day-boundary fixes land under both |

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
   spend. **No longer a listing risk** — nothing merchant-visible sells ad spend,
   CAC or ROAS any more, the screen says plainly why those figures are blank, and
   a test fails if the claim returns. It is now a missing feature rather than a
   false promise, which is a gap Shopify does not bounce a submission for. The
   wiring that *did* exist is now consistent: every provider in the enum gets a
   connector row at install, so the Settings screen shows all three ad platforms
   sitting at "Not configured" rather than omitting TikTok entirely.
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
7. **Route loaders are still mostly untested — narrower than it was.** The six
   non-GDPR webhook *actions* now have their own HMAC-rejection tests
   (`app/routes/webhooks.hmac.test.ts` — real HMAC verification against every
   route module, per-route write assertions, plus the answer-before-work and
   replay-suppression behaviour). `loadDashboard` — the loader every dashboard
   screen goes through, which builds the comparison window — now has its own
   test too (`app/lib/route-data.test.ts`, 12 cases): the previous-period
   window tiles the current one with no gap and no overlap and is the same
   length, `isDemo` is threaded through to `anchorToData` rather than fixed,
   `resolvePlan`/`loadShopAnalytics`/`loadPeriodProfit` are called with the
   right arguments, and the demo shop gets every capability regardless of
   `grantedScopes`. Checked each assertion actually bites by breaking the
   previous-period arithmetic and confirming the test failed, then reverted.
   What's still untested: the other 20 route loaders (`app.orders.tsx`,
   `app.products.tsx`, `app.fulfilment.tsx`, `app.acquisition.tsx`,
   `app.pricing.tsx`, `app.settings.tsx`, `app.plan.tsx`, `app.layout.tsx`,
   `auth.*`, `home.tsx`, `legal.*`) have no dedicated test, though most are thin
   wrappers over already-tested loaders. The layer below them is now covered:
   `series.ts`, `provision.server.ts` and `rebuildCapacityDays` all gained
   their first tests this session, and each one had a real defect in it.
8. **The chart components format dates in the browser's zone.**
   `app/design/charts.tsx` renders `point.date` with `toLocaleDateString` and no
   `timeZone`, client-side, so a merchant travelling — or simply a laptop set to
   a different zone from the store — reads axis labels that can sit a day off
   the buckets behind them. The loader-side instance of this is fixed and
   `DailyPoint` now carries an unambiguous `key`; threading the shop's zone
   through to the components is the remaining half.
9. **`CapacityDay.staffedHours` and `maxDailyCapacity` are written by the seed
   and zeroed by the rebuild.** `rebuildCapacityDays` has no source for staffed
   hours and writes `"0"`, and it recomputes the ceiling from observed
   throughput. On the demo store the seeded values (16/40 hours, ceiling 95)
   differ from what a rebuild produces (0, ceiling 102), so a re-import would
   quietly change the Fulfilment screen. Harmless on a real store, which never
   had staffed hours to lose, but the demo and the product disagree.

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
