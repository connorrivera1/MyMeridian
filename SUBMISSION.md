# Shopify App Store submission checklist

Status of every requirement Shopify checks, as verified against the code and a
running instance on 2026-08-05. Each verdict cites what was actually run or
read, not what the code comments claim.

Branch: `eevee/meridian-triage`. Nothing has been deployed, pushed or submitted.

---

## Blockers — the app cannot be submitted until these are done

### 1. `application_url` is still the CLI placeholder

`shopify.app.toml` points at `https://shopify.dev/apps/default-app-home`, and
`redirect_urls` at `.../api/auth`. Every webhook `uri` in the file is relative
and resolves against `application_url`, so **all three mandatory compliance
webhooks currently resolve to a host Shopify cannot deliver to.**

The redirect path is also wrong independently of the host: `authPathPrefix` is
`/auth` (`app/shopify.server.ts`), so the callback is `/auth/callback`, not
`/api/auth`.

Needs: a real public HTTPS host, then `application_url` and `redirect_urls`
updated and the config deployed. This is the one item everything else waits on.

### 2. Billing is declared two mutually exclusive ways and enforced in neither

- `app/shopify.server.ts` configures three **Billing API** plans (Starter $49,
  Growth $149, Scale $399) with a 14-day trial.
- `shopify.app.toml` and `app/routes/webhooks.app-subscriptions.tsx` describe
  **managed pricing**, where the merchant picks a plan on Shopify's screen.

Only one can be live. Worse, nothing consumes either: there is no
`billing.require`, `billing.check` or `billing.request` anywhere in `app/`, and
no loader or action branches on `Subscription.plan` — it is read only to render
a badge in *Costs & connections*. Every feature advertised as Growth- or
Scale-only is served unconditionally on the default `trial`.

So a merchant can be charged and have nothing gated, or pay nothing and get
everything. There is also no in-app upgrade path — Settings is a bare sentence
telling them to go to the Shopify admin, with no link.

Needs: pick one model; add a real plan check; add an upgrade CTA
(`billing.request`, or an App Bridge redirect to
`admin.shopify.com/store/<shop>/charges/meridian-profit/pricing_plans`); delete
the losing config. If managed pricing wins, the Partner Dashboard plan names
must be exactly `Starter` / `Growth` / `Scale` — that string match is the only
join between what a merchant pays and what the app gates on, and a mismatch is
silent because the webhook still returns 200. `app/lib/billing.test.ts` pins the
matching rules.

### 3. Privacy policy, support contact and listing assets do not exist

No privacy-policy route, no support email or URL anywhere in the repo, no app
icon (`public/` holds only `favicon.svg`), no listing screenshots, no listing
copy, `extensions/` is empty. All are hard requirements. A hosted privacy policy
URL is required; adding a `/privacy` route here would satisfy it cheaply.

### 4. App Bridge is not in the document head

The CDN script is loaded — `AppProvider` renders
`https://cdn.shopify.com/shopifycloud/app-bridge.js`, confirmed present in the
built client bundle — but from inside `<body>`, not `<head>`. `app/root.tsx`'s
head has only a `preconnect`. Shopify's embedded requirement is that App Bridge
be the first script in the head.

---

## Verified working

| Requirement | Verdict | Evidence |
|---|---|---|
| OAuth via token exchange + managed install | Done | `AppDistribution.AppStore` selects `createTokenExchangeStrategy`; no legacy install flag in the toml |
| Embedded app, session-token auth | Done | `isEmbeddedApp: true`, bearer-token detection in `app/lib/auth.server.ts` |
| Auth callback route | Done | `authPathPrefix: "/auth"` + splat route |
| Embedded launch opens the app | **Fixed** | Was redirecting into `admin.shopify.com/oauth/install` inside the admin iframe (frame-blocked). Now `/?shop=…&host=…&embedded=1` → `/app?…`, verified against a running server and in the production build |
| `customers/data_request` | Done | HMAC-verified; 200 signed, 401 unsigned, 401 tampered, 405 on GET — run over HTTP |
| `customers/redact` | Done | Same; anonymises orders in place rather than deleting them |
| `shop/redact` | Done | Same; purges sessions and cascades the shop delete |
| Unverified webhook returns 401 | **Fixed** | An unsigned probe returned 400. Now 401 on every endpoint |
| Webhook idempotency | Done | `X-Shopify-Webhook-Id` claimed before handling; a replayed delivery returns 200 and writes nothing — verified live |
| `app/uninstalled` cleanup | Done | Deletes sessions, stamps `uninstalledAt` |
| Reinstall re-imports | **Fixed** | Reinstall left `syncStatus = COMPLETE`, so the backfill was skipped and every order from the uninstalled window was silently missing |
| Persistent session storage | Done | `PrismaSessionStorage`, offline tokens |
| Read-only scopes | Done | `read_orders read_products read_fulfillments read_inventory`; no write scope requested; accepted price changes are recorded, never pushed |
| Scope list consistency | **Fixed** | `read_refunds` (not a Shopify scope, never checked) removed; `.env.example` advertised `read_customers`/`read_reports`/`read_analytics`, which the capability fallback would have used to claim data access the app does not have |
| Production build | **Fixed** | `npm run build` failed outright — a non-route export dragged `~/shopify.server` into the client bundle. Now builds, and `npm start` boots and serves |
| Test suite | Done | 139 tests, 13 files, all passing |
| Typecheck | Done | Clean |
| Config validity | Done | `shopify app config validate` passes |

---

## Known gaps that are not blockers, in rough priority order

1. **Dashboard loaders are unbounded.** `loadEngineOrders` hydrates every order
   *and every line item* in the window with no `take`, and `loadDashboard` does
   it twice (current and previous period) plus a 365-day cohort query, on every
   page load. The orders table's `PAGE_SIZE = 60` slices an already-materialised
   array, so the database work is identical on page 1 and page 40. This is fine
   on the demo store and will not be on a Scale-plan store sold as "unlimited
   orders" — and cold first load is exactly what Shopify's Web Vitals sampling
   measures. Aggregate in SQL before a large merchant installs.
2. **Child collections in the backfill are not paginated** — `variants(first:
   100)`, `lineItems(first: 50)`, `refundLineItems(first: 50)`,
   `fulfillments(first: 10)`, none checking `hasNextPage`. A product with more
   than 100 variants imports the first 100; the rest get no `Variant` row, so
   their line items snapshot zero cost and report 100% margin. An 80-line
   wholesale order loses ~40% of its COGS. Silent in both cases.
3. **Products created after install never get COGS.** The `products/create` and
   `products/update` handlers do not write `unitCost` — only the backfill reads
   `inventoryItem.unitCost`. A new SKU shows at 100% gross margin and tops the
   most-profitable list until someone runs a manual re-import. The webhook
   payload genuinely does not carry cost, so this needs a targeted follow-up
   fetch.
4. **Out-of-order webhook delivery mis-assigns `isFirstOrder`.** If a customer's
   second order is delivered before their first, both are flagged as first
   orders and nothing ever demotes the later one. New-customer counts inflate
   and CAC understates. Related: `acquisitionChannel` and `firstOrderAt` are
   pinned to whichever order was ingested first, which during the install
   backfill can be the wrong one.
5. **Line items are deleted and recreated outside a transaction**, and
   `OrderLineItem` has no unique constraint on `(orderId, shopifyId)`. Two
   concurrent deliveries of the same order could interleave into duplicated line
   items, doubling COGS and units. I could not reproduce this — 10 concurrent
   signed deliveries of one order still produced exactly one copy of each line
   item — so it is a structural hazard rather than a confirmed defect. Adding
   `@@unique([orderId, shopifyId])` would close it cheaply.
6. **`Shop.syncCursor` is documented and written but never read.** An
   interrupted import restarts from the beginning despite the resume point
   being stored.
7. **No `app/scopes_update` webhook.** `grantedScopes` is written only in
   `afterAuth`, so a merchant granting or revoking an optional scope later
   leaves the recorded set stale forever.
8. **Fulfilments dedupe on `(shopId, orderId, createdAt)`** because
   `Fulfillment` has no `shopifyId`. A `fulfillments/update` shares the
   original `created_at`, matches, and returns early — so cancellations and
   carrier corrections are never applied. Split shipments created in the same
   second collapse into one.
9. **An accepted price recommendation is unrecoverable.** The pricing loader
   queries `PENDING` only and regeneration permanently excludes actioned
   variants, so after Accept there is no screen showing what was accepted, and
   an accidental Dismiss cannot be undone. The schema has no applied-price
   field. A failed Accept is also a silent no-op — the action returns
   `{ok:false}` with 200 and the route never renders `useActionData`.
10. **Order-level stored profit is a write-only cache.** `recompute` writes
    `Order.netProfit`, but every dashboard figure is recomputed from the engine
    on the fly and nothing reads it back except `contributionProfit` for cohort
    LTV. The doc comment claiming the dashboard cannot re-derive order economics
    is not true of `netProfit`.
11. **Ad platform connectors are not wired to live OAuth.** Modelled and
    encrypted end to end, but Facebook/Google/TikTok have no OAuth flow, so on a
    real store the acquisition screen shows organic and direct traffic with zero
    spend.
12. **Backfill and recompute run in-process.** Correct on a long-lived server,
    wrong on serverless where the process may not outlive the response. Both
    belong in a job queue before deploying there.
13. **`read_all_orders` and `read_customers`** both need approved Partner
    Dashboard access requests, not just scopes. Without the first, order history
    is capped at 60 days; without the second there is no CAC, LTV or payback.
    The app degrades honestly in both cases rather than showing zeroes.
14. **The demo auth bypass ships in the production bundle.** Guarded by a
    boot-time throw when `NODE_ENV=production` and by Shopify-signal detection,
    which is solid, but the whole guard depends on `NODE_ENV` being set
    correctly at deploy. A reviewer reading the source will pause here.
