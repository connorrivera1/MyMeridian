# MyMeridian

A unified profitability dashboard for Shopify stores. Revenue, COGS,
fulfilment, payment fees and overhead resolved into one number a merchant can
act on. That number is calculated from available recorded and modeled inputs.
Growth and Scale merchants can connect Meta Ads, Google Ads and TikTok Ads;
until a connector is healthy and synced, ad spend is disclosed as unavailable
and the result is qualified rather than marketed as complete net profit.

Built as a real embedded Shopify app: React Router 7, Prisma/PostgreSQL,
read-only Shopify scopes and the mandatory GDPR webhooks. Billing is enforced:
the app resolves the active Billing API subscription, redirects an unsubscribed
store to the plan screen, gates paid features, and re-checks the plan before a
protected pricing mutation.

The seeded local demo is development-only. Production builds resolve its shop
lookup to a fail-closed stub and scan every emitted server file; the build fails
if the demo domain or seeded-authentication implementation survives bundling.

Publisher operations live under a separate `/operator` security boundary with
dedicated scrypt credentials, mandatory TOTP MFA, one-time-code replay
protection, short-lived Strict sessions and append-only access auditing. Its
business/system dashboard and store-support view expose aggregate status only;
they deliberately exclude customer/order detail, merchant contact data, tokens,
payloads and raw provider errors, and provide no arbitrary database editor. See
[`docs/OPERATOR_SECURITY.md`](docs/OPERATOR_SECURITY.md).

**Release status:** [`docs/LAUNCH_READINESS.md`](docs/LAUNCH_READINESS.md) is
the sole current release record. It names verified local evidence separately
from production, legal, payment, provider-approval and Shopify-review gates.
The dated deployment and submission files are implementation history and
runbooks, not a substitute for that matrix.

---

## Installing on a development store

This is the local development path. The CLI supplies the linked app credentials
and temporary tunnel URLs, but production submission still requires the Partner
Dashboard decisions and access requests listed above.

**1. Prerequisites** — a free [Shopify Partner account](https://partners.shopify.com),
and local Postgres.

**2. Create a development store.** Partner Dashboard → _Stores_ → _Add store_ →
_Development store_. Any plan.

**3. Set up locally.**

```bash
npm install
createdb meridian
cp .env.example .env
```

Fill in `DATABASE_URL`, and generate the token-encryption key:

```bash
openssl rand -base64 32
```

Then migrate:

```bash
npm run db:migrate
```

**4. Link and run.**

```bash
npm run shopify:dev
```

The CLI logs you in, offers to create the app in your Partner account, writes
`client_id` into `shopify.app.toml`, opens a tunnel, rewrites the app URLs to
match it, and injects `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SCOPES` into
the process. You do not need to put any of those in `.env`.

For a production-hosted App Store review, charge mode is not inferred from
`NODE_ENV`, a display label, or an operator override. MyMeridian re-reads
Shopify's durable `ShopPlan.partnerDevelopment` signal immediately before every
production charge, so the supplied development store receives a test charge.

**5. Install it.** Press `p` to open the install link, pick your dev store,
approve the scopes. MyMeridian provisions the shop, registers webhooks, and starts
importing immediately — progress shows at the top of every page.

### Making the dashboard say something

A brand-new dev store has no data, so the import will finish with nothing to
analyse. Two things are worth doing in the store's admin first:

**Set "Cost per item" on your products.** Products → variant → _Cost per item_.
This is the single most important field in the whole setup — it is what the
import reads as COGS via `inventoryItem.unitCost`. Without it every margin in
the app is fiction, and variants missing it are recorded as `ESTIMATED` rather
than silently treated as free.

**Create some orders.** Admin → Orders → _Create order_, add products, then
_Mark as paid_. A dozen orders across a couple of weeks is enough for the profit,
product and fulfilment screens to be meaningful. Mark some as fulfilled so the
capacity model has throughput to learn from.

Then hit **Re-import** in _Costs & connections_, or just place an order — the
webhooks keep everything current from that point on.

### Compliance webhooks

All three mandatory privacy webhooks are enabled in `shopify.app.toml`, as
`compliance_topics` entries with relative URIs. Relative means they resolve
against `application_url`, so they follow the dev tunnel and the production host
automatically — there is no hostname to remember to change, which is what the
old absolute-URL block kept getting wrong.

| Topic                    | Handler                                         |
| ------------------------ | ----------------------------------------------- |
| `customers/data_request` | `app/routes/webhooks.gdpr.data-request.tsx`     |
| `customers/redact`       | `app/routes/webhooks.gdpr.customers-redact.tsx` |
| `shop/redact`            | `app/routes/webhooks.gdpr.shop-redact.tsx`      |

Each verifies HMAC before touching the database, answers an unverified request
`401`, a valid one `200`, and a `GET` `405`. `app/routes/webhooks.gdpr.test.ts`
signs real requests and asserts exactly that contract; the same cases have also
been run over HTTP against a live server.

`customers/redact` anonymises orders in place rather than deleting them, so the
personal data goes without silently rewriting the merchant's financial history.

The one thing still outstanding is that `application_url` is the CLI's
placeholder. Until it points at a real public HTTPS host, these endpoints
resolve to somewhere Shopify cannot reach.

### Permissions decide what the app can honestly claim

Scopes are not all-or-nothing. MyMeridian records what the store actually granted
and gates its GraphQL fields on it, because requesting an unauthorised field
fails the _entire_ query rather than returning null for that field.

| Scope               | Without it                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_orders`       | Nothing works. Essential, and itself gated by an approved Protected Customer Data request.                                                                                                                                                                                                                                                                                         |
| `read_products`     | No catalogue or pricing analysis. Essential.                                                                                                                                                                                                                                                                                                                                       |
| `read_inventory`    | **No COGS.** Margins read as ~100% and every profit figure is overstated. Requested by default; not protected data.                                                                                                                                                                                                                                                                |
| `read_customers`    | No CAC, LTV, payback or customer-lifecycle product classification. **Protected customer data** — needs an approved request in the Partner Dashboard, not just the scope.                                                                                                                                                                                                           |
| `read_fulfillments` | No capacity forecasting. MyMeridian writes no capacity data at all rather than inferring a backlog that only ever grows.                                                                                                                                                                                                                                                           |
| `read_reports`      | No Shopify Shipping label-cost reconciliation. Shopify also requires Level 2 Protected Customer Data approval covering name, address, phone and email before it exposes the `shipping_labels` ShopifyQL schema. MyMeridian does not query or persist shopper name, address or phone; those additional approvals are a ShopifyQL access gate, not additional collection by the app. |

Missing permissions surface in _Costs & connections → Data access_, and the
affected screens explain what is unavailable instead of rendering a zero.

### Two things that will surprise you

- **Full order history is approved.** Shopify approved `read_all_orders` on
  2026-08-11 and the scope is requested with `read_orders`. MyMeridian can now
  backfill beyond Shopify's default 60-day window for lifetime profitability,
  repeat-customer cohorts and seasonal trends. The app still records the scopes
  each shop actually granted and warns if an older installation has not yet
  granted the extended window.
- **Ad spend requires an explicit merchant connection.** Growth and Scale
  merchants can connect Meta, Google or TikTok from inside the embedded app.
  CAC, ROAS and marketing efficiency stay unavailable rather than zero until a
  selected account has synced. Historical imports without customer access
  cannot read journey attribution and fall back to Direct; new-order webhooks
  retain landing/referring signals when Shopify supplies them.

### Tax and carrier reconciliation

Every order stores Shopify's authoritative total tax plus auditable jurisdiction
components. The splitter classifies EU VAT and US state/county/city/district
sales-tax lines, separates merchandise tax from shipping tax, handles inclusive
prices and compound lines, and uses exact integer largest-remainder allocation.
The components therefore always add back to Shopify's order total, including
one-cent rounding differences. Unknown detail is retained as an explicit
`UNALLOCATED` component instead of being guessed.

Shopify Shipping costs are read from the ShopifyQL `shipping_labels` report when
`read_reports` is granted and Shopify has approved Level 2 protected-customer-data
access covering name, address, phone and email. That four-field approval is a
ShopifyQL platform gate: MyMeridian does not query or persist shopper name,
address or phone. ShipStation uses its v2 label feed. Both sources are
retained as observations and matched by Shopify order GID, numeric ID or order
name. Equal totals corroborate each other; conflicting totals remain auditable
and only the most complete, newest source is applied. Voids, refunds and currency
mismatches remove stale measured costs before profitability is recomputed. The
worker runs on process start and every five minutes. Shopify fulfillment
webhooks trigger the same reconciliation immediately. A production ShipStation
credential automatically registers its `fulfillment_shipped_v2` webhook with a
random per-connector authentication header; the poll remains the recovery path
for missed events and late label voids. Database leases prevent two app
instances from duplicating a provider read or alert.

### Self-service connections and connector health

Ad credentials are encrypted at rest. A five-minute health routine validates
Meta through token debugging plus live ad-account access, Google Ads through
accessible-customer access, and TikTok through its authorized-advertiser
endpoint. A valid token with no accessible advertiser account is treated as a
disconnect, not a healthy empty integration. Google tokens are refreshed
before expiry. An independently verified standby token is promoted only after
the provider confirms the primary credential is no longer authorized; timeouts,
rate limits and provider outages never rotate credentials. A confirmed
disconnection is marked and sends a signed HTTPS alert immediately when a
receiver is configured. Other failures use exponential backoff and alert on the
third consecutive check. Alert delivery failures are retained as health events
instead of being silently swallowed.

Merchants connect and disconnect Meta Ads, Google Ads and TikTok Ads through
provider OAuth from _Costs & connections_. The callback uses a one-use, hashed,
expiring state value; tokens are encrypted at rest, and merchants choose the
account MyMeridian should sync. ShipStation is connected with an API key in the
same screen and registers an authenticated webhook when the app has a public
HTTPS origin. The operator command below remains only as a recovery and support
tool; it is not the normal merchant onboarding path:

```bash
MERIDIAN_CONNECTOR_TOKEN='<secret>' npm run connector:configure -- \
  --shop store.myshopify.com --provider shipstation

# Google also accepts MERIDIAN_CONNECTOR_REFRESH_TOKEN and an expiry timestamp.
MERIDIAN_CONNECTOR_TOKEN='<access>' \
MERIDIAN_CONNECTOR_REFRESH_TOKEN='<refresh>' \
npm run connector:configure -- --shop store.myshopify.com --provider google \
  --expires-at 2026-08-11T18:00:00Z

# A standby credential is encrypted but not promoted until its live probe passes.
MERIDIAN_CONNECTOR_TOKEN='<standby>' npm run connector:configure -- \
  --shop store.myshopify.com --provider meta --standby
```

Provider probes need the corresponding variables in `.env.example`. Set
`CONNECTOR_ALERT_WEBHOOK_URL` to an HTTPS receiver and
`CONNECTOR_ALERT_WEBHOOK_SECRET` to authenticate its
`X-Meridian-Signature: sha256=...` payload. Never reuse or rotate
`MERIDIAN_ENCRYPTION_KEY` casually: existing connector ciphertext depends on it.
When `SHOPIFY_APP_URL` is a public HTTPS origin, ShipStation provisioning also
creates or repairs the authenticated fulfillment webhook. Until that production
origin exists, the command stores the credential and reports that only the
five-minute fallback can run.

## Running the demo without Shopify

```bash
npm run setup     # migrate + seed
MERIDIAN_DEMO_MODE=true npm run dev
```

Open http://localhost:3000/app — six months of generated orders, computed by the
same engine that runs against live data.

The demo is only ever served to a genuinely unauthenticated visitor. Any request
carrying a Shopify signal — `shop`, `host`, `embedded` or `id_token` params, or
an App Bridge bearer token — goes through `authenticate.admin` instead. Demo mode
**throws at boot** if `NODE_ENV=production`: it bypasses session authentication
and must never be reachable there.

| Command                                          |                                                             |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `npm run shopify:dev`                            | Run against a real store via the Shopify CLI                |
| `npm run dev`                                    | Dev server (demo / no Shopify)                              |
| `npm run db:migrate`                             | Apply migrations                                            |
| `npm test`                                       | Test suite (930 unit tests; 57 PostgreSQL tests are opt-in) |
| `npm run test:coverage`                          | Tests with coverage thresholds enforced                     |
| `npm run ci`                                     | Everything CI runs: typecheck, coverage, build              |
| `npm run typecheck`                              | Types                                                       |
| `npm run db:reset`                               | Drop, migrate, re-seed                                      |
| `npm run db:seed`                                | Re-seed the demo store                                      |
| `npx tsx scripts/verify-data.ts`                 | Print the full P&L, products, channels, capacity            |
| `npx tsx scripts/elasticity-accuracy.ts --sweep` | Elasticity recovery vs the seed's known values              |

---

## Guarding main

This repository has **no git remote**, so there is no CI service and no
pull-request review — and it has more than one writer, since an agent system
also commits here. The gate that actually protects `main` is a pre-commit hook,
and hooks are not cloned. Enable it once per checkout:

```bash
git config core.hooksPath .githooks
```

It runs typecheck and the test suite when any `.ts`, `.tsx`, `.css` or `.json`
file is staged, and refuses the commit if either fails. Docs-only commits skip
it. To bypass deliberately: `git commit --no-verify`.

`.github/workflows/ci.yml` runs the fuller set — typecheck, coverage
thresholds, build, a from-empty migration apply against a real Postgres, and a
dependency audit. The feature branch is connected to GitHub and these checks
run on its draft pull request.

Coverage is measured over `app/engine`, `app/lib` and `app/data` — the code the
suite targets most deeply. Route and design-system `.tsx` files remain outside
the coverage denominator, but server-rendered regressions now cover Overview,
Orders, Products, Acquisition, Pricing, Settings, Plan, the app layout, Privacy
requests, Fulfilment, the embedded Shopify login entry, the marketing-home
resource route, both legal wrappers and chart date labels. The browser-level
Shopify install flow still needs production end-to-end coverage. Thresholds are
floors set just under the current measurement, so the build fails on regression
rather than on ambition.

## Architecture

```
app/
  engine/     Pure functions. No Prisma, no React. Where the maths lives.
  data/       Prisma -> engine input translation, and the assembled picture.
  lib/        Auth boundary, webhooks, sync, recompute, crypto.
  design/     Tokens, primitives, hand-built SVG charts.
  routes/     Ten app screens and thirteen webhook endpoints.
```

**The engine is the product.** `app/engine/` holds pure functions with no
database or framework dependency, which is what makes them testable and why the
numbers can be trusted. Everything else is plumbing around it.

### Money

All arithmetic is integer. Prices and revenue in **cents**; unit costs in
**micros** (1e4), because Shopify stores COGS at 4dp and multiplying by quantity
before rounding is materially more accurate than rounding first.

Fixed overhead is split with a largest-remainder allocation, so the parts sum to
exactly the total. Order-level profit reconciles to the P&L to the cent.

### Profit

```
net revenue = subtotal − discounts + shipping charged − refunds(ex-tax)
            − COGS − fulfilment − payment fees − attributed ad spend
            = contribution profit
            − allocated overhead
            = net profit
```

Decisions worth knowing about:

- **Tax is never revenue.** It is collected for a tax authority and excluded
  throughout. Refunds are reduced to their ex-tax share before being netted off,
  or a fully refunded order drives revenue negative.
- **Processor fees are charged on the original total**, including tax and
  shipping, and are _not_ returned on refunds — which is what Stripe and Shopify
  Payments actually do.
- **COGS is snapshotted onto the line item** at order time. A supplier price rise
  next month must not retroactively change what last quarter earned.
- **Ad spend is allocated equally** across a channel-day's orders, not weighted
  by order value. An ad does not cost more because the basket was larger.
- **Spend on days with no orders is not dropped.** It is real money, so it is
  charged against profit as unattributed rather than quietly vanishing.
- **Overhead is prorated.** A rolling 30-day window straddling two calendar
  months is charged one month of rent, not two.
- **Margin against zero or negative revenue reports "—"**, not 26,000%.

### Products

Contribution profit per product, with order-level shipping, payment,
pick-and-pack and any recorded ad cost allocated by revenue share. Fixed monthly
overhead remains an order-net-profit cost and is not pushed into product
contribution. A product with sold units but missing COGS receives no profitable
or bleeding verdict; modeled inputs stay visibly qualified.

### Acquisition

The current release attributes order-derived revenue and qualified contribution
to channels from UTM and referring signals and can import spend from a
merchant-selected Meta, Google or TikTok account. Until a connector is healthy
and synced, spend, CAC, ROAS and marketing efficiency remain unavailable rather
than becoming zero. The dormant cohort engine is also hidden because the requested
scope set does not include `read_customers`; unmeasurable cohort checkpoints
remain represented as “not yet”, never `0.00×`.

### Pricing

A weighted log-log regression of demand share on price, per variant, from the
price history MyMeridian observes from installation onward; pre-install history is
unknown and never backfilled from the current price.

The regressand is the product's **share of store-wide demand**, not raw units.
This matters enormously: a growing store's volume rises over time and price
changes correlate with time, so a naive units-vs-price fit hands the store's
growth to whichever price happened to be in force later. On the demo store that
turns a true −2.1 elasticity into −6.6, or flips its sign outright.

Realised prices (net of discounts) are bucketed in steps proportional to list
price, as an errors-in-variables control.

Guard rails, all enforced and tested:

- Moves capped at ±25%, floored at a 15% contribution margin.
- Below the confidence threshold it reports `INSUFFICIENT_DATA` rather than
  inventing an elasticity.
- A **positive** fitted elasticity is reported as a broken fit — something other
  than price moved demand — not as pricing headroom.
- Customer-lifecycle hold logic remains in the engine for a future approved
  `read_customers` release, but it is dormant: current routes and public copy do
  not surface or sell it.

Estimates on observational data are attenuated; that is a genuine property of the
data, not a bug, and is exactly why the caps and confidence gating exist. The
estimator is verified exact against clean synthetic demand in the test suite.

### Capacity

Built on _observed_ throughput, not a number typed in at onboarding. Trailing
14-day fulfilment rate, day-of-week demand factors, and a 14-day forward
simulation where overflow rolls into the next day. Alerts fire before the SLA
breaks, not after.

---

### The historical import

Webhooks only ever describe what happens next, so install triggers a paginated
Admin GraphQL backfill (`app/lib/backfill.server.ts`) — shop profile, then
products with their real `inventoryItem.unitCost`, then orders with line items,
refunds and fulfilments — before rebuilding the capacity series and recomputing
profitability.

It is deliberately paginated rather than using bulk operations: bulk adds async
polling and JSONL retrieval for a payoff that only matters above roughly a
hundred thousand orders. What does matter is in there — cost-based throttle
backoff, a resumable cursor, and a capability probe for
`customerJourneySummary`, which is not readable on every store and degrades to
referrer-based attribution instead of failing the run.

`afterAuth` persists a deduplicated `HISTORICAL_BACKFILL` job before returning,
then wakes the durable worker because Shopify's OAuth redirect cannot wait for
store history. A five-minute lease is renewed every minute; owner-fenced
progress and terminal writes, plus a saved cursor, make interruption visible and
safely resumable after a process restart.

### Cost history and restatement

A variant's cost is a step function over time (`VariantCost`), not a column.
`Variant.unitCost` is still there — every catalog read wants today's number and
none of them want a timeline — but it is the denormalised head of the history
rather than the truth.

That distinction is what makes a wrong cost fixable. Snapshotting COGS onto the
line item preserved March correctly, and also made March unfixable: a merchant
who imported a bad cost, or who only learned the freight component a month
later, had no way to correct the past. Now a correction is a row with a past
`effectiveAt`, which is a different act from raising a price today.

**Saving a cost changes no reported number.** Restating is separate, explicit and
audited (`app/lib/restatement.server.ts`), and it happens in a fixed order:

1. **Freeze.** Every affected merchant-local month with no `PeriodSnapshot` gets
   one, holding the figures as they were reported. Those numbers never change
   again.
2. **Refuse.** A month the merchant has CLOSED does not move unless the request
   names closed periods explicitly — and the refusal happens before any write,
   so a five-month window cannot half-apply.
3. **Rewrite.** Line-item COGS is re-derived from the cost timeline at each
   order's own `processedAt`, never from today's cost, in one `UPDATE` driven by
   a lateral over `VariantCost`.
4. **Record.** Every month that moved gets an append-only `PeriodRestatement`
   saying what it said before, what it says now, and why.

The baseline for step 4 is measured after a preliminary recompute, not from the
live ledger. Monthly overhead is prorated across the days a period covers, so the
in-progress month's allocation drifts daily whether or not a cost changed —
measured on the seeded store, a $180 COGS correction otherwise reported an
$8,002 fall in net profit, $7,822 of which was overhead catching up. A log that
attributes unrelated drift to the merchant's correction is worse than no log.

### Bundle deconstruction

A 3-pack has no cost of its own; it costs three of something else. `BundleComponent`
holds that graph, and the rollup resolves each bundle's **timeline** — not a
number — because a merchant restating March needs the pack's March cost, which no
snapshot of today's components can give them.

Nested packs resolve depth-first with an explicit in-progress set, so a mapping
that makes a bundle contain itself is reported as a cycle rather than overflowing
the stack. Unpriced components, absurd nesting and non-positive quantities are
all reported rather than resolved to a plausible-looking number — treating an
unpriced component as free understates COGS, which is the one direction of error
a profit tool must not make quietly.

### Ad-spend ingestion

Meta, Google, and TikTok spend polling is optional and uses BullMQ/Redis only
as a scheduler. The `AdSyncWindow` Postgres ledger is the source of truth: a
flushed queue, stopped worker, or delayed platform restatement is reconciled on
the next polling cycle. Foreign-currency spend is converted against immutable
daily `ExchangeRate` rows, and workers may run in the web process or through
`npx tsx scripts/ads-worker.ts`.

Detection reads the merchant's own naming (`WIDGET-BLU-3PK` beside `WIDGET-BLU`,
or "3-Pack" beside "Single" within one product) and writes **proposals**.
`confirmedAt` is null until a merchant agrees, and the rollup ignores unconfirmed
edges: inferring from a SKU suffix that a product's COGS should triple, and then
silently doing it, is exactly the unasked-for accounting that makes a profit
number untrustworthy.

### The recalculation queue

Restatements and bundle rollups are `RecalcJob` rows, not awaits in a form
action. Restating a quarter rewrites line items across months and then recomputes
the shop — minutes on a large store, and an in-process promise would leave half a
quarter rewritten if a deploy landed mid-run.

Historical backfills, full-store recomputes, restatements and bundle rollups all
use this queue. The claim/lease/backoff shape is lifted from the webhook outbox rather than
invented again: same fencing token, same compare-and-set on the lease, same
exponential retry, so there is one durable-work pattern in this codebase to
reason about instead of two that drift apart. Finished rows are pruned after 30
days by the existing retention sweep; `PeriodRestatement.jobId` is `SetNull`
precisely so pruning a spent receipt cannot take the accounting trail with it.

## Shopify integration

- **Read-only scopes.** An analytics app should not be able to change a price, an
  order, or a customer. Accepted pricing recommendations are recorded, not
  written back to Shopify.
- **Durable webhook recovery.** An authenticated payload is minimized and
  durably claimed before HTTP 200. A leased worker retries failures with
  backoff; successful payloads are erased. Failed ordinary recovery payloads
  expire after seven days, while mandatory compliance work never ages out
  before it succeeds.
- **All three mandatory GDPR topics** are implemented. `customers/redact`
  anonymises orders in place rather than deleting them — erasing the personal
  data without silently rewriting the merchant's financial history.
- **Third-party OAuth tokens are AES-256-GCM encrypted at rest** with a key held
  outside the database (`app/lib/crypto.server.ts`).

---

## Design system

Dark-first and built for density. Series colours are the validated categorical
palette, re-validated against MyMeridian's own surfaces (`#12151C` / `#FFFFFF`) —
slot **order** is the colourblind-safety mechanism, so do not hand-edit a series
hex without re-running the validator.

Colour never carries meaning alone: every delta pill has an arrow glyph, every
status badge has a label, and light mode ships the table view that its three
sub-3:1 slots oblige.

Charts are hand-built SVG. A library would have to be re-themed to match anyway
and fought with over mark geometry.

---

## Known gaps

- Provider credentials, reviewed OAuth apps and a durable Redis worker are
  deployment configuration, so ad spend remains unavailable in an environment
  where those external dependencies have not been activated.
- Historical COGS is not retrievable from Shopify. The import snapshots each
  variant's _current_ landed cost onto its line items, which is the best
  available basis; from then on webhooks snapshot the cost in force at the time.
- Accepted price changes are recorded, not pushed to Shopify (requires
  `write_products`, deliberately not requested).
- Billing is implemented and enforced with the Billing API. Its Shopify test
  approval screen, return redirect and active subscription lookup have been
  exercised on the development store without moving money. Production charging
  and webhook delivery remain deployment acceptance tests.
- Backfill and recompute execution still needs a running worker, but requests no
  longer own the work: both are durable, deduplicated Postgres jobs with leased
  claims, retries and restart recovery. A production host must keep at least one
  worker available or run the same worker as a separate process.
