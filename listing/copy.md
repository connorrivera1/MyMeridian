# App Store listing copy — draft

Written 2026-08-05 (branch `eevee/meridian-triage`). Drafted from what the code
actually does, checked screen by screen against the routes and the engine, not
from the plan blurbs in `app/lib/plans.ts`.

**Everything in the boxes below is paste-ready.** Character counts are measured,
not estimated — see *Character counts* at the end for how to re-check after an
edit.

Two things in here need Connor before this can be submitted, and they are called
out in *Needs the owner* at the bottom. One of them is a factual accuracy
problem, not a taste problem.

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
See *Needs the owner*, item 1 — this is the accuracy problem.

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

## Needs the owner

### 1. The ad-spend claim — an accuracy decision, not a wording one

The Acquisition screen, and the Growth plan blurb "Unlimited ad channels +
blended CAC" (`app/lib/plans.ts`), describe a capability the app does not have
yet. There is a `Connector` model, encrypted token storage and a UI row for Meta,
Google and TikTok, but **no OAuth flow and no platform API client anywhere in the
tree** — `AdSpend` rows are only ever written by `prisma/seed.ts`. On a real
store the Acquisition screen shows organic and direct traffic with zero spend.

So the draft above says nothing about ad performance. Shopify's review compares
the listing against what the app does on a real install, and a listing that
promises blended CAC on a store that will show `$0.00` spend is the kind of thing
that gets a submission bounced rather than queried.

Connor's call, and it is one of three:

- **Ship the copy as drafted** — accurate today, undersells the built screens.
- **Build the ad connectors first**, then add the CAC/LTV bullet. This is real
  work, not a listing edit.
- **Reword the plan tiers** so "unlimited ad channels" is not sold either. The
  plan blurbs are merchant-visible on `/app/plan` and a reviewer walks that
  screen during billing review.

### 2. Support email and legal entity

`MERIDIAN_SUPPORT_EMAIL` and `MERIDIAN_LEGAL_ENTITY` (and optionally
`MERIDIAN_SUPPORT_URL`) are unset, so `/privacy` and `/support` currently render
an explicit "not configured" notice — deliberately, so a reviewer never emails an
address that bounces. These need a genuinely monitored inbox and the legal entity
the app is published under (sole trader / LLC / Ltd). Both are business
decisions; neither can be guessed. See `app/lib/brand.server.ts:13-24`.

### 3. The setup screencast — an automatic bounce if missing

Shopify requires a screencast of the full setup flow, in English or with English
subtitles, and rejects the submission outright without one. It cannot be recorded
yet: it has to show a real OAuth install and the first dashboard view, the app
has never been installed on any store, and it cannot be filmed against the demo
bypass because that is exactly the path the recording is meant to prove works.

This is not a copy task and nothing in this file unblocks it. It comes free with
Phase 2 in `DEPLOY_PLAN.md` — record it during the first real install rather than
staging it twice.

### 4. Still missing from the listing, unrelated to copy

- **Feature media** — one 1600×900 image or a 2–3 minute video.
- **Demo store URL** for the reviewer to click through.

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
