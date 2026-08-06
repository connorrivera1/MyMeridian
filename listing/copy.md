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
| requests no write access | `scopes = "read_orders read_products read_fulfillments read_inventory"`, `shopify.app.toml:47` |

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
- **Demo store URL** for the reviewer to click through. Re-seed before handing
  this out: the store the URL points at is the same one the screenshots came
  from, and until `npm run db:reset` runs it still holds the invented `AdSpend`
  rows described below.
- **Three screenshots to re-capture** — `acquisition`, `overview` and `orders`
  are held in `listing/screenshots-held/`. The shipped set is at three, which is
  Shopify's floor.

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
