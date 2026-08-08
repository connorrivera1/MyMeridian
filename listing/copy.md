# App Store listing copy — draft

Written 2026-08-05 (branch `eevee/meridian-triage`). Drafted from what the code
actually does, checked screen by screen against the routes and the engine, not
from the plan blurbs in `app/lib/plans.ts`.

**Everything in the boxes below is paste-ready.** Character counts are measured,
not estimated — see *Character counts* at the end for how to re-check after an
edit.

What still needs Connor is called out in *Needs the owner* at the bottom, and it
is now business facts and a screencast rather than anything about the code. The
one factual accuracy problem in here — the app selling ad channels it cannot
connect — was closed on 2026-08-06; see *Resolved*.

---

## App name — limit 30

```
Meridian Profit Analytics
```

**25 characters.** The Partner Dashboard app name is `Meridian` (`shopify.app.toml:3`)
and the handle is `meridian-profit`. Shopify allows a listing name of the form
`Brand + short descriptor` and rejects keyword stuffing, so this is about as far
as it goes.

Alternates, both within the limit:

| Option | Chars |
|---|---|
| `Meridian Profit Analytics` | 25 |
| `Meridian: True Profit` | 21 |
| `Meridian Profit & Pricing` | 25 |

---

## Introduction — limit 100

This is the line that appears under the name in search results.

```
See the true net profit of every order and product, after COGS, shipping, fees and overhead.
```

**92 characters.** It names the four cost components the app actually subtracts
(`app/engine/profit.ts:267-275`) rather than promising "insights".

---

## App details — limit 500

```
Shopify reports gross sales. Meridian reports what is left.

It imports your orders, products, cost per item and fulfilments, applies your own payment, shipping, pick-and-pack and overhead rules, and gives every order and product a true net profit figure.

See which products carry the business and which quietly bleed, and which loss leaders pay for themselves. Get prices fitted to your own price history, and know which day your warehouse falls behind.

Meridian requests no write access.
```

**491 characters**, counting the blank lines between paragraphs. The first draft
of this paragraph ran to 575 and had to be cut — the limit is tighter than it
reads, so measure rather than eyeball after any edit.

Every claim in it is load-bearing and checked:

| Claim | Where it is true in the code |
|---|---|
| imports orders, products, cost per item, fulfilments | `app/lib/backfill.server.ts:509-624`, five named stages |
| your own payment / shipping / pick-and-pack / overhead rules | four editable cost rules, `app/routes/app.settings.tsx:233-318` |
| net profit per order, product and day | `computeOrderProfit`, `computeProductProfitability`, `dailySeries` |
| which products carry the business and which bleed | `PROFITABLE` / `BLEEDING` classifications, `app/engine/products.ts:11-15` |
| loss leaders that genuinely pay for themselves | `STRATEGIC_LOSS_LEADER` needs contribution ≤ 0, ≥5 acquired customers, downstream profit covering the loss, **and** >1.25× the store's average post-first-order value — `app/engine/products.ts:220-242` |
| prices fitted to your own price history | weighted log-log OLS on the variant's own price points, `app/engine/pricing.ts:99-175` |
| which day your warehouse falls behind | 14-day forecast against demonstrated throughput, `app/engine/capacity.ts:152-182` |
| requests no write access | `scopes = "read_orders read_products read_fulfillments read_inventory"`, `shopify.app.toml:59` |

Deliberately **not** claimed: ad ROI, CAC, LTV, payback, ad-channel connections.
The in-app plan tiers have now been brought into line with this — see *Resolved*,
item 1.

---

## Feature bullets — limit 80 each

```
Net profit per order, after COGS, shipping, payment fees and overhead
```
```
Find bleeding products, and loss leaders that genuinely pay for themselves
```
```
Price recommendations fitted to your own price history, not a rule of thumb
```
```
Fulfilment backlog alerts before your warehouse falls behind, not after
```
```
Read-only. Meridian requests no write access and changes nothing
```

**69 / 74 / 75 / 71 / 64 characters.**

A sixth, if the listing takes more than five and the Protected Customer Data
request in *Needs the owner* is approved first — it is false without it:

```
Cost to acquire a customer, and what that customer is worth after 90 days
```
**73 characters.**

---

## Testing instructions for the reviewer — limit not published

Requirements **4.5.4** and **4.5.5** say the submission must carry any account
credentials the reviewer needs to exercise the app, and that those credentials
must grant the **full** feature set. Nothing in this file, `SUBMISSION.md` or
`DEPLOY_PLAN.md` drafted this field before now, which is how it stayed invisible:
it is a form field with no asset attached to it, so it does not show up as a
missing file the way the screencast and the feature media do.

**Meridian has no login of its own.** There is no Meridian account to create, no
third-party service to connect and no API key for the reviewer to enter — the
Shopify session is the only credential. So 4.5.4 is satisfied by saying that
explicitly rather than leaving the field blank, which reads to a reviewer as an
omission rather than an answer.

```
Meridian has no separate login. There is no account to create and no third-party
service to connect — the app authenticates entirely through your Shopify
session, so installing on the demo store below gives you the full feature set
immediately.

Demo store: <DEMO STORE URL>
Storefront password: <PASSWORD>

1. Install from the listing. Meridian asks for four read-only scopes:
   read_orders, read_products, read_fulfillments and read_inventory. It requests
   no write scope and cannot change a price, an order or anything else.

2. Choose a plan when prompted. Starter ($49/mo), Growth ($149/mo) and Scale
   ($399/mo) each carry a 14-day free trial, and every charge raised on a
   development store is a test charge, so nothing is billed. Until a plan is
   active every other screen redirects to the plan page. You can move up or down
   between all three at any time from the "Plan" item in the sidebar, in-app and
   without contacting us.

3. The historical import starts on its own as install finishes — orders,
   products, cost per item and fulfilments. The dashboard fills in as it runs.

4. Then walk the sidebar:
   - Overview — net profit, revenue and margin over the selected date range.
   - Profit per order — every order with COGS, shipping, payment fees and
     overhead subtracted.
   - Products — which products are profitable, which are bleeding, and which
     loss leaders pay for themselves through what the customer buys later.
   - Acquisition — revenue and profit by channel, attributed from each order's
     UTM parameters and referring site.
   - Pricing — recommendations fitted to each variant's own price history.
   - Fulfilment — a 14-day backlog forecast against demonstrated throughput.
   Settings holds the four cost rules the figures are built from: payment
   processing, shipping, pick-and-pack, and fixed monthly overhead. Editing any
   of them re-computes every screen above.

Two areas are deliberately blank, and the app says why on screen rather than
showing a zero:

- Ad spend, CAC, ROAS and marketing efficiency on the Acquisition screen.
  Meridian does not connect to Meta, Google or TikTok yet and never infers spend
  from orders, so these stay blank on every store, demo included. The revenue
  and profit by channel on that same screen are measured from the store's own
  orders and are unaffected.
- Order history older than 60 days, unless read_all_orders has been granted.
  Shopify caps the read; the app shows a banner explaining the cap rather than
  presenting a short history as a complete one.

Support: <SUPPORT EMAIL>
```

**Three placeholders have to be real before this is pasted**, and each is
already tracked in *Needs the owner* above rather than being new work:

| Placeholder | Where it comes from |
|---|---|
| `<DEMO STORE URL>` | *Needs the owner*, item 3 — the same store the screenshots came from |
| `<PASSWORD>` | the demo store's storefront password; **delete both the line and this row** if the store is not password-protected |
| `<SUPPORT EMAIL>` | `MERIDIAN_SUPPORT_EMAIL`, *Needs the owner*, item 1 |

Every claim in the block is traced to the code that makes it true, on the same
terms as the listing copy above:

| Claim | Where it is true in the code |
|---|---|
| no login of its own; Shopify session is the only credential | no sign-up route in `app/routes.ts`; the only unauthenticated documents are `/privacy` and `/support` |
| four read-only scopes, no write scope | `shopify.app.toml:59` |
| three plans at $49 / $149 / $399 | `app/lib/plans.ts:35-70` |
| 14-day free trial on every plan | `TRIAL_DAYS = 14`, `app/lib/plans.ts` |
| charges on a development store are test charges | `billingIsTest = process.env.NODE_ENV !== "production"`, `app/lib/plan.server.ts:101`, passed to `billing.request` at `app/routes/app.plan.tsx:55-59` |
| every other screen redirects to the plan page until a plan is active | `app/routes.ts` — the `plan` route is the one child reachable without a subscription |
| plan changes are in-app and both directions | sidebar `Plan` link, `app/routes/app.layout.tsx:246-249`; `billing.request` for any of the three, `app/routes/app.plan.tsx:55-59` (requirement 1.2.3) |
| the import starts by itself at the end of install | `startBackfill` from `afterAuth`, `app/shopify.server.ts:156-163` |
| the six sidebar screens and their labels | `NAV`, `app/routes/app.layout.tsx:109-114` |
| four editable cost rules in Settings | `app/routes/app.settings.tsx:234,260,278,302` — payment processing, shipping, pick-and-pack, fixed monthly overhead |
| channel attribution from UTM and referring site | `app/lib/sync.server.ts:76-100` |
| ad spend is never inferred, and the screen says so | `app/routes/app.acquisition.tsx:217-219` |
| the 60-day cap and its on-screen banner | `app/routes/app.layout.tsx:178-188` |

One thing this field should **not** say: that the reviewer can use the demo
bypass. It ships in the bundle but is barred at boot when `NODE_ENV=production`
(known gap 5 in `SUBMISSION.md`), and pointing a reviewer at it would defeat the
screencast requirement, which exists to prove the real OAuth path works.

---

## Resolved

### 1. The ad-spend claim — taken the third way, 2026-08-06

The Growth blurb "Unlimited ad channels + blended CAC" and the Starter bullet
"One ad channel connected" (`app/lib/plans.ts`) described a capability the app
does not have. There is a `Connector` model, encrypted token storage and a UI row
for Meta, Google and TikTok, but **no OAuth flow and no platform API client
anywhere in the tree** — `provision.server.ts:97` creates every connector
`NOT_CONFIGURED` and nothing ever configures one, and the only writer of
`AdSpend` in the repo is `prisma/seed.ts:949`. So the seeded demo shows spend and
a real store shows `$0.00` forever.

That mattered more than a listing edit, because the plan blurbs are
merchant-visible on `/app/plan` and a reviewer walks that screen during billing
review while comparing the listing against a real install. The listing draft
above was already silent on ad performance; the app itself was not.

Of the three options this section used to pose, the third is taken — the plan
tiers are reworded, so nothing merchant-visible sells ad spend:

- Starter now reads **"Revenue and profit by channel"**, which is true without
  any platform token: orders are attributed to a channel from their UTM
  parameters and referring site (`sync.server.ts:76-100`), and each channel
  carries real `netRevenueCents` and `contributionProfitCents`
  (`engine/acquisition.ts:35-60`). It is ungated, so it belongs on the cheapest
  plan.
- Growth keeps its two genuine gates and nothing else: pricing recommendations
  and fulfilment capacity alerts.
- Prices, names and order caps are untouched.

A second defect surfaced underneath it. `FEATURE_MIN_PLAN.multiChannelAds` was a
**gate with no call site** — `planAllows(plan, "multiChannelAds")` appeared
nowhere in the app, while the other three gates each have real enforcement
points. It is removed. That is the same fault `plan.server.ts` was written to
fix, one layer down: a promise declared in two places and enforced in neither.

`plan.test.ts` carries the guard rather than the intention: `no plan sells ad
spend, CAC or ROAS` fails on any plan whose copy contains `ad channel`, `ad
spend`, `cac`, `roas` or `blended`, with a message naming why. Verified to fail
by putting the old Growth bullet back. **Lift that test in the same change that
ships a real connector, and not before.**

The Acquisition screen degrades honestly on zero spend — CAC and marketing
efficiency render `—` rather than `0` — but gave no reason, while the missing
`read_customers` case on the same screen explains itself. It now carries a banner
saying no ad platform is connected, that spend is never inferred from orders, and
that the channel figures below are measured from the merchant's own orders and are
unaffected.

---

## Needs the owner

### 1. Support email and legal entity

`MERIDIAN_SUPPORT_EMAIL` and `MERIDIAN_LEGAL_ENTITY` (and optionally
`MERIDIAN_SUPPORT_URL`) are unset, so `/privacy` and `/support` currently render
an explicit "not configured" notice — deliberately, so a reviewer never emails an
address that bounces. These need a genuinely monitored inbox and the legal entity
the app is published under (sole trader / LLC / Ltd). Both are business
decisions; neither can be guessed. See `app/lib/brand.server.ts:13-24`.

### 2. The setup screencast — an automatic bounce if missing

Shopify requires a screencast of the full setup flow, in English or with English
subtitles, and rejects the submission outright without one. It cannot be recorded
yet: it has to show a real OAuth install and the first dashboard view, the app
has never been installed on any store, and it cannot be filmed against the demo
bypass because that is exactly the path the recording is meant to prove works.

This is not a copy task and nothing in this file unblocks it. It comes free with
Phase 2 in `DEPLOY_PLAN.md` — record it during the first real install rather than
staging it twice.

### 3. Still missing from the listing, unrelated to copy

- **Feature media** — one 1600×900 image or a 2–3 minute video.
- **Demo store URL** for the reviewer to click through. The store behind it is the
  same one the screenshots come from, and its invented `AdSpend` rows were cleared
  on 2026-08-06 — the local database now holds none.
- **One screenshot still held** — `acquisition`, in `listing/screenshots-held/`.
  Re-captured against the cleaned store it is accurate and unshippable: four blank
  headline tiles over a channel table of dashes. It comes back with a connector.
  `overview` and `orders` were re-captured and are shipped, so the set is at five
  of a possible six rather than sitting on Shopify's floor of three.

### 4. The ad-spend claim was not closed where it mattered — 2026-08-06

*Resolved* item 1 below fixed the plan tiers and added the Acquisition banner,
and then this file and `SUBMISSION.md` both recorded the accuracy problem as
closed. The listing media was never checked. Three of the six screenshots led
with blended CAC, paid spend, marketing efficiency, per-channel ROAS and a
per-order ADS column — every figure of which is a dash or a zero on a real store.

The cause was the demo seed, which fabricated `AdSpend` and was the only writer
of that table anywhere in the repo. The seed no longer does. Details, and the
re-capture steps, are in `listing/screenshots-held/README.md`.

The drafted copy above was already silent on ad performance and needed no change.
The lesson is that "merchant-visible" includes everything checked into `listing/`,
not just the routes.

---

## Character counts

Measured with `String.length`, not estimated — the first pass at the details
paragraph was eyeballed at "about 500" and was actually 575. To re-check after an
edit, put the text in a file and run:

```sh
node -e 'console.log(require("fs").readFileSync(process.argv[1],"utf8").replace(/\n$/,"").length)' /tmp/draft.txt
```

Measured for the drafts above on 2026-08-05:

| Field | Limit | Draft |
|---|---|---|
| Name | 30 | 25 |
| Introduction | 100 | 92 |
| Details | 500 | 491 |
| Feature 1 | 80 | 69 |
| Feature 2 | 80 | 74 |
| Feature 3 | 80 | 75 |
| Feature 4 | 80 | 71 |
| Feature 5 | 80 | 64 |
| Feature 6 (conditional) | 80 | 73 |
