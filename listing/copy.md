# MyMeridian App Store listing copy — activation blocked

Originally drafted 2026-08-05 and updated against the completed product on
2026-08-11. Every current claim is checked against a merchant-reachable route,
worker and entitlement rather than inferred from a plan name.

The public identity is **MyMeridian**. The copy remains activation-blocked only
on facts that cannot be invented in the repository: production/support URLs,
review-store credentials and the final screencast.

What still needs Connor is called out in *Needs the owner* at the bottom, and it
is now business facts and a screencast rather than anything about the code. The
one factual accuracy problem in here — the app selling ad channels it cannot
connect — was closed on 2026-08-06; see *Resolved*.

---

## App name — limit 30

```
MyMeridian
```

**10 characters.**

---

## Introduction — limit 100

This is the line that appears under the name in search results.

```
See order and product profit after COGS, shipping, fees and overhead; missing ad spend is disclosed.
```

**100 characters.** It names the four cost components the app actually
subtracts (`app/engine/profit.ts:267-275`) and discloses the live input that is
not connected rather than calling the result complete net profit.

---

## App details — limit 500

```
Shopify reports gross sales. MyMeridian reports profit from available inputs.

It imports orders, products, item costs and fulfilments, then applies payment, shipping, pick-and-pack and overhead models. Missing costs and ad spend stay visible instead of becoming zero.

Connect Meta, Google, TikTok or ShipStation for measured spend and carrier costs. Get profit alerts, exports and weekly summaries.

MyMeridian requests no write access.
```

**444 characters**, counting the blank lines between paragraphs. The first draft
of this paragraph ran to 575 and had to be cut — the limit is tighter than it
reads, so measure rather than eyeball after any edit.

Every claim in it is load-bearing and checked:

| Claim | Where it is true in the code |
|---|---|
| imports orders, products, cost per item, fulfilments | `app/lib/backfill.server.ts:509-624`, five named stages |
| your own payment / shipping / pick-and-pack / overhead rules | four editable cost rules, `app/routes/app.settings.tsx:233-318` |
| qualified profit per order, product and day | `computeOrderProfit`, `computeProductProfitability`, `dailySeries`; missing COGS, modeled costs and unavailable ad spend are disclosed separately |
| which products carry the business and which bleed | `PROFITABLE` / `BLEEDING` classifications, `app/engine/products.ts:11-15` |
| prices fitted to post-install observed history | weighted log-log OLS on price points Meridian records from first observation onward; pre-install history is never invented |
| which day your warehouse falls behind | 14-day forecast against demonstrated throughput, `app/engine/capacity.ts:152-182` |
| requests no write access | `scopes = "read_orders,read_all_orders,read_products,read_fulfillments,read_inventory,read_reports"`, `shopify.app.toml:72` |

Deliberately **not** claimed: protected-customer cohort LTV/payback or
location-specific capacity. Ad connections are now merchant-managed and spend
is imported only after a provider completes a real sync.

---

## Feature bullets — limit 80 each

```
Profit per order after COGS, shipping, payment fees and configured overhead
```
```
Connect Meta, Google, TikTok and ShipStation without contacting support
```
```
Catch margin drops, refund spikes, carrier drift and missing product costs
```
```
Schedule weekly profit summaries and export accountant-ready order detail
```
```
Read-only. MyMeridian requests no write access and changes nothing
```

Every bullet remains below Shopify's 80-character limit.

---

## Testing instructions for the reviewer — limit not published

Requirements **4.5.4** and **4.5.5** say the submission must carry any account
credentials the reviewer needs to exercise the app, and that those credentials
must grant the **full** feature set. Nothing in this file, `SUBMISSION.md` or
`DEPLOY_PLAN.md` drafted this field before now, which is how it stayed invisible:
it is a form field with no asset attached to it, so it does not show up as a
missing file the way the screencast and the feature media do.

The embedded installation path requires no second signup or login. MyMeridian
also offers an optional web account so a Scale merchant can switch stores
outside Shopify Admin; that path is not required to review the embedded app.
Provider test credentials must be supplied in Shopify's secure reviewer fields
if the reviewer is expected to exercise Meta, Google, TikTok or ShipStation.

```
MyMeridian requires no separate signup on the Shopify installation path. Follow
the steps below inside Shopify Admin. An optional web login exists for returning
Scale users, but the reviewer does not need it to reach the embedded product.

Demo store: <DEMO STORE URL>
Storefront password: <PASSWORD>

1. Install from the listing. Meridian asks for four read-only scopes:
   read_orders, read_products, read_fulfillments and read_inventory. It requests
   no write scope and cannot change a price, an order or anything else.

2. Choose Scale monthly ($299/month) to expose the full reviewable feature set,
   including Pricing, Fulfilment, weekly summaries, CSV export and multi-store
   portfolio access. Scale is also $2,990/year; Starter is $49/month or $490/year,
   Growth is $129/month or $1,290/year,
   and Scale is $299/month or $2,990/year. Annual billing gives two months free.
   Every plan carries a 14-day free trial. The supplied development store uses a
   Shopify test charge, so nothing is billed. Until a plan is active every other
   paid analytics screen redirects to the plan page. The authenticated Privacy
   requests screen remains available so subscription cancellation cannot block a
   shopper export. You can move up or down between all three plans at any time
   from the "Plan" item in the sidebar, in-app and without contacting us.

3. The historical import starts on its own as install finishes. Before plan
   selection, onboarding shows the first imported 30-day figures and asks the
   merchant to confirm payment, shipping, pick-and-pack and overhead inputs.

4. Then walk the sidebar:
   - Overview — qualified profit, revenue and margin over the selected date
     range, with modeled or missing costs and unavailable ad spend disclosed.
   - Profit per order — every order with COGS, shipping, payment fees and
     configured overhead subtracted; ad spend remains unavailable.
   - Products — contribution from available inputs; products with missing COGS
     receive no profitability verdict.
   - Acquisition — revenue and qualified contribution by channel, attributed
     from each order's UTM parameters and referring site.
   - Pricing — recommendations fitted only after Meridian observes enough
     post-install price history; a new install reports insufficient data.
   - Fulfilment — a 14-day backlog forecast against demonstrated throughput.
   - Privacy requests — shopper exports remain collectable without a paid plan.
   Settings holds the four modeled cost rules, reporting preferences, streamed
   CSV export and self-service Meta, Google Ads, TikTok Ads and ShipStation
   connections. Editing a cost recomputes every screen above.

These inputs and analyses are deliberately unavailable, and the app says why on
screen rather than showing a zero:

- Customer-lifecycle product classifications, customer counts, CAC, lifetime
  value and payback. MyMeridian does not request read_customers in this release.
  Product contribution remains available from recorded order values and the
  configured cost inputs, with modeled assumptions and missing COGS flagged. Historical imports
  cannot read customer-journey attribution and therefore fall back to Direct;
  new-order webhooks retain landing and referring signals when Shopify supplies
  them.
- Order history older than 60 days, unless read_all_orders has been granted.
  Shopify caps the read; the app shows a banner explaining the cap rather than
  presenting a short history as a complete one.

Support: <MERIDIAN SUPPORT EMAIL>
```

**Three placeholders have to be real before this is pasted**, and each is
already tracked in *Needs the owner* above rather than being new work:

| Placeholder | Where it comes from |
|---|---|
| `<DEMO STORE URL>` | *Needs the owner*, item 3 — the same store the screenshots came from |
| `<PASSWORD>` | the demo store's storefront password; **delete both the line and this row** if the store is not password-protected |
| `<MERIDIAN SUPPORT EMAIL>` | Meridian's own monitored inbox, *Needs the owner*, item 1 |

Every claim in the block is traced to the code that makes it true, on the same
terms as the listing copy above:

| Claim | Where it is true in the code |
|---|---|
| no login of its own; Shopify session is the only credential | no sign-up route in `app/routes.ts`; the only unauthenticated documents are `/privacy` and `/support` |
| four read-only scopes, no write scope | `shopify.app.toml:59` |
| monthly prices $49 / $129 / $299 and annual prices $490 / $1,290 / $2,990 | `app/lib/plans.ts` |
| 14-day free trial on every plan | `TRIAL_DAYS = 14`, `app/lib/plans.ts` |
| the supplied development store uses a test charge | `resolveBillingChargeMode` re-reads Shopify's `ShopPlan.partnerDevelopment` immediately before every production `billing.request`; `shop/update` invalidates the stored signal and forces subscription revalidation after a store conversion |
| paid analytics screens redirect to the plan page until a plan is active | `app/routes/app.layout.tsx` and `requireActivePlan`; Plan and authenticated Privacy requests remain entitlement-exempt |
| plan changes are in-app and both directions | sidebar `Plan` link, `app/routes/app.layout.tsx:246-249`; `billing.request` for any of the three, `app/routes/app.plan.tsx:55-59` (requirement 1.2.3) |
| the import starts by itself at the end of install | `startBackfill` from `afterAuth`, `app/shopify.server.ts:156-163` |
| the nine app screens and their labels | `NAV` and `TITLES`, `app/routes/app.layout.tsx` |
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
`NOT_CONFIGURED` and nothing ever configures one. At the time this defect was
found, `prisma/seed.ts` was the only `AdSpend` writer and made the demo disagree
with every real store; that seed writer and its fabricated rows are now gone.

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
- Prices and plan names are untouched. The unenforced order-volume blurbs are
  removed; they were copy, not a billing or runtime limit.

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
saying no ad platform had completed a sync, that spend is never inferred from orders, and
that the channel figures below contain order-derived revenue plus qualified
contribution from the available recorded and modeled cost inputs.

### 2. Cohort LTV was removed from Scale — 2026-08-10

Scale sold **"Cohort LTV and payback curves"**, but the requested OAuth scopes do
not include `read_customers`. That protected scope must not be requested before
Shopify approves it, so no real subscriber could use the plan's headline feature.
The claim and its paid gate are removed from the in-app and public price lists.
The underlying engine remains dormant for a future approved release; it is not a
paid entitlement today.

Acquisition now keeps the truthful order-derived core visible on current scopes:
orders, net revenue and contribution profit by channel. Customer metrics and ad
metrics are layered on only when their real inputs exist, with the historical
Direct fallback disclosed on screen rather than hidden.

### 3. Customer-lifecycle product and location-specific capacity claims were removed — 2026-08-10

The product engine retains customer-lifecycle classification code for a future
release with approved `read_customers` access, but the current listing, landing
page, Products route and Pricing route do not expose or sell it. Negative-margin
products are presented only from available recorded and modeled order inputs;
products with missing COGS receive no profitability verdict.

Scale also no longer claims location-specific fulfilment modelling. The current
rebuild aggregates every fulfilment into a single `primary` capacity series, so
the public catalogue now promises only the store-wide backlog and capacity work
that exists end to end. Prices are unchanged.

---

## Needs the owner

### 1. Meridian domain, publisher and support email

Buy Meridian's domain, then create a genuinely monitored inbox on it and set
`MERIDIAN_SUPPORT_EMAIL` and `MERIDIAN_LEGAL_ENTITY` to Meridian's own facts.
The app and standalone legal drafts intentionally expose the pre-launch gap
until these are known; do not reuse another product's domain or terms.

### 2. The setup screencast — an automatic bounce if missing

Shopify requires a screencast of the full setup flow, in English or with English
subtitles, and rejects the submission outright without one. A real development-
store install and first dashboard view now work. Record the final version after
the public identity and populated reviewer store are ready; it cannot use the
demo bypass because that is exactly the path the recording must prove is absent.

### 3. Still missing from the listing, unrelated to copy

- **Feature media** — one 1600×900 image or a 2–3 minute video.
- **Demo store URL** for the reviewer to click through. The store behind it is the
  same one the screenshots come from, and its invented `AdSpend` rows were cleared
  on 2026-08-06 — the local database now holds none.
- **The six listing screenshots were refreshed at 1600×900 on 2026-08-11.**
  Overview, Orders, Products, Acquisition, Pricing and Fulfilment were captured
  from the current seeded review dataset and visually checked. Re-capture from
  the final real review store only if its identity or data differs. The old held
  Acquisition image remains provenance and must not be restored.

### 4. The ad-spend claim was not closed where it mattered — 2026-08-06

*Resolved* item 1 below fixed the plan tiers and added the Acquisition banner,
and then this file and `SUBMISSION.md` both recorded the accuracy problem as
closed. The listing media was never checked. Three of the six screenshots led
with blended CAC, paid spend, marketing efficiency, per-channel ROAS and a
per-order ADS column — every figure of which is a dash or a zero on a real store.

The cause was the demo seed, which fabricated `AdSpend` and was the only writer
of that table anywhere in the repo. The seed no longer does. Details, and the
re-capture steps, are in `listing/screenshots-held/README.md`.

The draft now also says the release has no ad-spend connector and avoids calling
its measured result complete net profit. The lesson is that "merchant-visible"
includes everything checked into `listing/`, not just the routes.

---

## Character counts

Measured with `String.length`, not estimated — the first pass at the details
paragraph was eyeballed at "about 500" and was actually 575. To re-check after an
edit, put the text in a file and run:

```sh
node -e 'console.log(require("fs").readFileSync(process.argv[1],"utf8").replace(/\n$/,"").length)' /tmp/draft.txt
```

Measured for the current MyMeridian draft on 2026-08-11:

| Field | Limit | Draft |
|---|---|---|
| Name | 30 | 10 |
| Introduction | 100 | 100 |
| Details | 500 | 444 |
| Feature 1 | 80 | 75 |
| Feature 2 | 80 | 70 |
| Feature 3 | 80 | 75 |
| Feature 4 | 80 | 71 |
| Feature 5 | 80 | 64 |
