# Meridian

A unified profitability dashboard for Shopify stores. Revenue, COGS, fulfilment,
ad spend and overhead resolved into one number a merchant can act on.

Built as a real embedded Shopify app: React Router 7, Prisma/PostgreSQL,
read-only Shopify scopes, mandatory GDPR webhooks, and the Billing API.

---

## Installing on a real store

Everything below is the whole list. There is no Shopify configuration to fill in
by hand — the CLI writes it.

**1. Prerequisites** — a free [Shopify Partner account](https://partners.shopify.com),
and local Postgres.

**2. Create a development store.** Partner Dashboard → *Stores* → *Add store* →
*Development store*. Any plan.

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

**5. Install it.** Press `p` to open the install link, pick your dev store,
approve the scopes. Meridian provisions the shop, registers webhooks, and starts
importing immediately — progress shows at the top of every page.

### Making the dashboard say something

A brand-new dev store has no data, so the import will finish with nothing to
analyse. Two things are worth doing in the store's admin first:

**Set "Cost per item" on your products.** Products → variant → *Cost per item*.
This is the single most important field in the whole setup — it is what the
import reads as COGS via `inventoryItem.unitCost`. Without it every margin in
the app is fiction, and variants missing it are recorded as `ESTIMATED` rather
than silently treated as free.

**Create some orders.** Admin → Orders → *Create order*, add products, then
*Mark as paid*. A dozen orders across a couple of weeks is enough for the profit,
product and fulfilment screens to be meaningful. Mark some as fulfilled so the
capacity model has throughput to learn from.

Then hit **Re-import** in *Costs & connections*, or just place an order — the
webhooks keep everything current from that point on.

### Compliance webhooks are disabled for development

The three mandatory privacy webhooks are commented out in `shopify.app.toml`.
Shopify rejects `https://localhost` for those endpoints — they must be publicly
reachable — which is the usual reason the block fails to deploy from a dev
machine.

The handlers themselves are untouched and still routed:

| Topic | Handler |
|---|---|
| `customers/data_request` | `app/routes/webhooks.gdpr.data-request.tsx` |
| `customers/redact` | `app/routes/webhooks.gdpr.customers-redact.tsx` |
| `shop/redact` | `app/routes/webhooks.gdpr.shop-redact.tsx` |

Nothing else depends on them: they exist to service erasure requests, and no
profit, product, pricing or fulfilment figure touches that path.

**Re-enabling before submission** — a public app cannot pass review without all
three:

1. Deploy the app somewhere with a public HTTPS URL.
2. Uncomment `[webhooks.privacy_compliance]` in `shopify.app.toml` and replace
   `YOUR-APP-DOMAIN` with that host.
3. `npm run shopify:dev` (or `shopify app deploy`) to push the config.
4. Confirm all three return 200 to a signed request — they verify HMAC and
   reject anything unsigned.

### Permissions decide what the app can honestly claim

Scopes are not all-or-nothing. Meridian records what the store actually granted
and gates its GraphQL fields on it, because requesting an unauthorised field
fails the *entire* query rather than returning null for that field.

| Scope | Without it |
|---|---|
| `read_orders` | Nothing works. Essential. |
| `read_products` | No catalogue or pricing analysis. Essential. |
| `read_inventory` | **No COGS.** Margins read as ~100% and every profit figure is overstated. Not protected data — add it freely. |
| `read_customers` | No CAC, LTV, payback or loss-leader detection. **Protected customer data** — needs an approved request in the Partner Dashboard, not just the scope. |
| `read_fulfillments` | No capacity forecasting. Meridian writes no capacity data at all rather than inferring a backlog that only ever grows. |

Missing permissions surface in *Costs & connections → Data access*, and the
affected screens explain what is unavailable instead of rendering a zero.

### Two things that will surprise you

- **Order history is capped at 60 days.** `read_orders` only returns the last 60
  days; anything older needs the `read_all_orders` scope, which Shopify grants on
  request (Partner Dashboard → your app → *API access* → *Access requests*). The
  app detects this and says so in a banner rather than implying the store had no
  earlier trading. Add the scope to `shopify.app.toml` only once it is approved —
  requesting an ungranted scope fails OAuth.
- **Ad spend has no live connector yet.** Facebook/Google/TikTok are modelled and
  encrypted end to end but not wired to their OAuth flows, so on a real store the
  acquisition screen will show organic and direct traffic with zero spend. The
  profit, product, pricing and fulfilment screens are fully live.

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

| Command | |
|---|---|
| `npm run shopify:dev` | Run against a real store via the Shopify CLI |
| `npm run dev` | Dev server (demo / no Shopify) |
| `npm run db:migrate` | Apply migrations |
| `npm test` | Engine test suite (85 tests) |
| `npm run typecheck` | Types |
| `npm run db:reset` | Drop, migrate, re-seed |
| `npm run db:seed` | Re-seed the demo store |
| `npx tsx scripts/verify-data.ts` | Print the full P&L, products, channels, capacity |
| `npx tsx scripts/elasticity-accuracy.ts --sweep` | Elasticity recovery vs the seed's known values |

---

## Architecture

```
app/
  engine/     Pure functions. No Prisma, no React. Where the maths lives.
  data/       Prisma -> engine input translation, and the assembled picture.
  lib/        Auth boundary, webhooks, sync, recompute, crypto.
  design/     Tokens, primitives, hand-built SVG charts.
  routes/     Seven screens and eight webhook endpoints.
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
  shipping, and are *not* returned on refunds — which is what Stripe and Shopify
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

Contribution profit per product, with order-level costs pushed down by revenue
share. The interesting part is classifying a loss:

A product losing money is **strategic** only if its buyers go on to be worth
meaningfully more than the store's average customer (1.25×, minimum cohort of 5).
Merely covering the loss is not enough — almost any product clears that bar,
because the customers who bought it go on to buy other things regardless.

### Acquisition

CAC is spend divided by the customers a channel actually acquired.

Two things this gets right that are easy to get wrong:

- **Payback is measured against contribution *before* marketing cost.** Comparing
  a figure that already has acquisition cost deducted back against CAC charges
  the merchant for the same ad twice, and makes healthy channels read "never".
- **Cohorts are only counted at checkpoints they have aged into.** A customer
  acquired last week cannot contribute to a 90-day figure; averaging them in as
  zero is the most common way LTV gets understated. Unmeasurable checkpoints
  render as "not yet", never as `0.00×`.

Value is measured across a 365-day cohort lookback regardless of the reporting
window, because "what is a customer worth" cannot be answered inside 30 days.
Platform-reported revenue is kept alongside measured revenue so the attribution
gap is visible — on the demo store the platforms collectively claim 82% more than
can be tied to orders.

### Pricing

A weighted log-log regression of demand share on price, per variant, from the
store's own price history.

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
- A working loss leader returns `STRATEGIC_HOLD`. Repricing the tripwire that
  feeds the funnel is the most expensive "optimisation" this tool could suggest.

Estimates on observational data are attenuated; that is a genuine property of the
data, not a bug, and is exactly why the caps and confidence gating exist. The
estimator is verified exact against clean synthetic demand in the test suite.

### Capacity

Built on *observed* throughput, not a number typed in at onboarding. Trailing
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

It starts in the background, because OAuth has to redirect the merchant into the
app immediately and reading a store's history takes far longer than a redirect
can wait. Progress is written to the `Shop` row and polled by the UI.

## Shopify integration

- **Read-only scopes.** An analytics app should not be able to change a price, an
  order, or a customer. Accepted pricing recommendations are recorded, not
  written back to Shopify.
- **Webhook idempotency.** Delivery is at-least-once; the `X-Shopify-Webhook-Id`
  is recorded so a retried `orders/create` cannot book revenue twice.
- **Verified webhooks return 200 even when the handler throws.** A 500 makes
  Shopify retry, and enough failures disable the subscription. Failures are
  recorded for deliberate replay instead.
- **All three mandatory GDPR topics** are implemented. `customers/redact`
  anonymises orders in place rather than deleting them — erasing the personal
  data without silently rewriting the merchant's financial history.
- **Third-party OAuth tokens are AES-256-GCM encrypted at rest** with a key held
  outside the database (`app/lib/crypto.server.ts`).

---

## Design system

Dark-first and built for density. Series colours are the validated categorical
palette, re-validated against Meridian's own surfaces (`#12151C` / `#FFFFFF`) —
slot **order** is the colourblind-safety mechanism, so do not hand-edit a series
hex without re-running the validator.

Colour never carries meaning alone: every delta pill has an arrow glyph, every
status badge has a label, and light mode ships the table view that its three
sub-3:1 slots oblige.

Charts are hand-built SVG. A library would have to be re-themed to match anyway
and fought with over mark geometry.

---

## Known gaps

- Ad platform connectors are modelled and encrypted end-to-end but not wired to
  live Facebook/Google/TikTok OAuth — that needs credentials. On a real store the
  acquisition screen therefore shows organic and direct traffic with no spend.
- Historical COGS is not retrievable from Shopify. The import snapshots each
  variant's *current* landed cost onto its line items, which is the best
  available basis; from then on webhooks snapshot the cost in force at the time.
- Accepted price changes are recorded, not pushed to Shopify (requires
  `write_products`, deliberately not requested).
- Billing plans are configured in the Billing API but the upgrade flow is not
  built; plan changes go through the Shopify admin.
- The backfill and recompute both run in-process. That is correct on a
  long-lived server and wrong on a serverless platform, where the process may
  not outlive the response — both belong in a job queue before deploying there.
