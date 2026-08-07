# Live Shopify requirements audit — 2026-08-06

Every requirement below was checked against **documentation fetched live from
shopify.dev today**, not from memory, and then cross-checked against this repo's
code on branch `eevee/meridian-triage`. `SUBMISSION.md` and `DEPLOY_PLAN.md` were
read first as the baseline; this file reports **only** what is new, what changed
since 2026-08-05, and confirmation/refutation of the baseline's claims against
docs that were actually opened.

**Audit only. No code was modified.**

---

## The four things the baseline does not account for

### N1. `read_orders` is protected customer data — no PCD request has been made — **FAIL, and it is a hard blocker**

`https://shopify.dev/docs/apps/launch/protected-customer-data` lists the
protected categories verbatim, and *Orders* is one of them:

> "Orders … Orders, draft orders, abandoned checkouts, refunds, transactions, and
> other data that relate to a single customer."

The app's entire product is built on `read_orders` (`shopify.app.toml:59`).
Without an approved Protected Customer Data request, the docs say:

> "Responses will include only approved fields, and unapproved fields will be
> redacted." … "GraphQL requests to unapproved types will return an HTTP 200 Ok
> response with an error message in the errors hash."

It is worse than Level 1. `app/lib/backfill.server.ts:387` queries
`customer { id email }` on every order, and the email is persisted —
`prisma/schema.prisma` `model Customer { … email String? }`,
written at `backfill.server.ts:1162,1167` and `app/lib/sync.server.ts:154,159`.
Email is one of the four fields that define **Level 2**:

> "Level 2: Customer data **including** name, address, phone, or email fields."

So Meridian needs Protected Customer Data access at **Level 2**, requested and
approved, before it can be published — and the Level 2 attestations include
"Encrypt your data backups", "Keep test and production data separate", "Have a
data loss prevention strategy", "Limit staff access to protected customer data",
"Require strong passwords for staff accounts", "Keep an access log to protected
customer data", "Implement a security incident response policy".

**What the baseline says instead:** `DEPLOY_PLAN.md:291-300` §6b treats the PCD
request as being *only* about `read_customers`, calls it "not a hard gate on
first submission", and says the app "degrades honestly without it".
`SUBMISSION.md:62` says the same. That is wrong on the live docs: without PCD
approval the order query itself returns redacted fields, so the app computes
nothing at all. This moves from "start it early, it runs on Shopify's clock" to
**blocking, and on Shopify's clock** — which makes it the longest-lead item in
the whole submission and arguably ahead of Blocker #1.

Doc: https://shopify.dev/docs/apps/launch/protected-customer-data

---

### N2. The privacy policy contradicts the code about shopper email — **FAIL (requirement 1.1.4)**

`app/routes/legal.privacy.tsx:90-96`:

> "Meridian does not read, request or store payment card details, passwords, or
> **shopper contact details**. Where `read_customers` is granted, the customer
> records held are limited to a Shopify customer id, the date of their first
> order, and the channel that acquired them."

Both sentences are false. Shopper email is read under `read_orders`, not
`read_customers` (`backfill.server.ts:387`, `sync.server.ts:154`), stored on
`Customer.email`, and handed back out in the GDPR export
(`app/lib/data-request.server.ts:77`).

Requirement **1.1.4**: "Your app and app listing should only include factual
information." This is also the exact disclosure the Level 2 PCD questionnaire in
N1 asks about, so the two land together.

Doc: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements

---

### N3. New requirement 4.1.2 "Use a unique name for your app" — effective 2026-07-15 — **FAIL / high rejection risk**

Announced **after** the baseline audit was written:

> Date: July 15, 2026. Violations occur when an app name "does not start with
> your distinctive brand identifier" or "mislead[s] merchants in confusing it
> with another app, developer, brand, or Shopify product." Enforcement "will
> roll out gradually" through audit waves; non-compliant apps are given "a
> defined timeframe to update their names where failure to comply may result in
> being delisted from the App Store."

**There is already a live, published Shopify App Store app called exactly
"Meridian"**, by a developer trading as *Meridian*, listed at
https://apps.shopify.com/meridian — an AI-search visibility (GEO) app, published
2025-11-11, carrying Built for Shopify status.

This repo's app name is `Meridian` (`shopify.app.toml:3`) and the drafted listing
name is `Meridian Profit Analytics` (`listing/copy.md:21`), whose "distinctive
brand identifier" is another developer's brand and app name. Neither
`SUBMISSION.md`, `DEPLOY_PLAN.md` nor `listing/copy.md` mentions this
requirement or the name collision — `listing/copy.md:24-35` reasons only about
the 30-character limit and keyword stuffing.

This is a business decision for Connor, not a code fix, and it should be made
before anything is typed into the submission form.

Docs: https://shopify.dev/changelog/updated-app-store-requirements-4-1-2-use-a-unique-name-for-your-app ,
https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements#use-a-unique-name-for-your-app

---

### N4. The Billing API is now documented as legacy; App Pricing is the default for new apps — **WARN, and the repo's stated reasoning is out of date**

Changelog, **2026-05-12**:

> "Shopify App Pricing replaces Managed Pricing as Shopify's default billing
> solution that gets configured during app submission in the Partner Dashboard."
> … "**The Billing API continues to function but is now legacy. All apps should
> use Shopify App Pricing going forward.**"

And the doc page:

> "Shopify App Pricing is the default option when you submit a new public app for
> approval." — https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
>
> "For public apps, use Shopify App Pricing. The Billing API is still supported
> for existing apps and outlier pricing models Shopify App Pricing doesn't
> cover." — https://shopify.dev/docs/apps/launch/billing/manual-pricing

`app/lib/plan.server.ts:9-14` states the Billing API choice is "forced rather
than stylistic … the only way to read a plan under [App Pricing] is the Partner
API — a separate organisation-level credential the app does not hold and cannot
obtain at runtime." Half of that is confirmed and half is now wrong:

- **Confirmed:** "After April 28, 2026, Shopify App Pricing no longer sends
  webhooks for subscription changes." The `app_subscriptions/update` reasoning in
  `plan.server.ts`, `shopify.app.toml:118-125` and
  `app/routes/webhooks.app-subscriptions.tsx:8-20` is accurate.
- **Now wrong:** the Partner API is *not* the only way to read the plan. The same
  doc documents a `plan_handle` URL redirect parameter delivered to the app when
  a merchant selects a plan, plus the Partner API `activeSubscription` query as
  the canonical read. So the premise that App Pricing is unreadable from a
  merchant session no longer holds as stated.

**This is not an automatic rejection.** Requirement **1.2.1** still reads "Your
app must use Shopify App Pricing or the Shopify Billing API for any app
charges." Manual pricing remains selectable. But it is now the non-default path
for a brand-new public app, which means it has to be deliberately chosen at
submission and is more likely to draw a reviewer question. `DEPLOY_PLAN.md:281-289`
§6a should be read with that in mind rather than as a settled technical
necessity.

Related, and also new since the baseline:
- **2026-07-07 / effective 2026-07-15** — a first-party migration tool for moving
  existing merchant subscriptions to App Pricing.
  https://shopify.dev/changelog/prepare-your-app-for-migration-to-shopify-app-pricing
- **2026-07-09** — App Pricing public plan limit raised 4→8, and **reviewers can
  now select an existing plan and install free on dev stores during app review**,
  which is exactly the friction `billingIsTest` (`plan.server.ts:88`) exists to
  work around under the Billing API.
  https://shopify.dev/changelog/app-pricing-more-plans-no-charge-plan-testing-and-negative-and-fractional-app-events

---

## Two smaller new findings

### N5. `handleWebhook` responds only after the handler completes — 5-second timeout risk

https://shopify.dev/docs/apps/build/webhooks/subscribe/https :

> "Shopify has a one-second connection timeout and a five-second timeout for the
> entire request." … "If Shopify receives no response or an error, it retries 8
> times over the next 4 hours. **After 8 consecutive failures, the subscription is
> automatically deleted** if it was configured using the Admin API." … "Queuing is
> a useful pattern for … ensuring you respond within five seconds."

`app/lib/webhooks.server.ts:98-107` awaits the handler before returning 200.
`webhooks.gdpr.data-request.tsx:26-55` builds the full export inside that window
— the customer plus every order plus every line item, then a write. On a shopper
with a long order history on a large store that is a real risk of exceeding 5s.
The idempotency claim (`claimWebhook`) makes the retries harmless to data, but a
timed-out response is still counted as a failure.

Not flagged anywhere in the baseline. Low probability, high consequence
(auto-deleted subscription); the fix is to claim, respond 200, and do the work
after — the same shape as the existing fire-and-forget backfill.

### N6. App Bridge is absent on the root error document

`app/root.tsx:56-77` emits `app-bridge.js` only when the root loader returned an
api key. When the loader throws, `Layout` wraps the `ErrorBoundary` with
`data === undefined`, so the script is not emitted. Built for Shopify's wording
is "add the `app-bridge.js` script tag to the `<head>` of **every document**".
Cosmetic for review, but it is also the one page where a merchant most needs App
Bridge to be able to re-run auth.

---

## Full requirement table

Verdicts: **PASS** verified in code + live doc · **FAIL** verified missing ·
**UNKNOWN** cannot be determined without a deploy or a Partner account.

### Mandatory compliance / GDPR webhooks
Doc: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | All three compliance topics subscribed before publication | PASS | `shopify.app.toml:82-92` — `customers/data_request`, `customers/redact`, `shop/redact` |
| 2 | Handlers exist for all three | PASS | `app/routes/webhooks.gdpr.data-request.tsx`, `.customers-redact.tsx`, `.shop-redact.tsx` |
| 3 | POST + JSON body handled | PASS | `action` exports only; `loader` returns 405 on each |
| 4 | Invalid HMAC → **401 Unauthorized** | PASS | `app/lib/webhooks.server.ts:59-63` (missing header → 401) and `authenticate.webhook` for a bad signature |
| 5 | Valid request → 200-series | PASS | `app/lib/webhooks.server.ts:107` |
| 6 | Complete the action within 30 days | PASS | export stored in `DataRequest`, surfaced in Settings, 31-day expiry (`app/lib/data-request.server.ts`) |
| 7 | Respond inside the 5s request timeout | **RISK** | see N5 — `webhooks.server.ts:98-107` |
| 8 | `app/uninstalled` (lifecycle, not a compliance topic) | PASS | `shopify.app.toml:94-96`; `webhooks.app-uninstalled.tsx:15-24` deletes sessions, stamps `uninstalledAt` |
| 9 | `app/scopes_update` under managed install | PASS | `shopify.app.toml:102-104` |
| 10 | Webhook API version pinned to a live stable version | PASS | `shopify.app.toml:73` = `2026-07`; verified released 2026-07-01, accessible until 2027-07-16 (https://shopify.dev/docs/api/usage/versioning) |

*No change to the compliance-webhook requirements was found in the changelog
between 2026-05-01 and today. The baseline's claims here are still accurate.*

### OAuth, session tokens, token exchange

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 11 | 2.3.2 "Your app must immediately authenticate using OAuth before any other steps occur" | PASS | `app/routes/home.tsx:18-23` redirects straight into `/app` (session-token auth) or `/auth/login` |
| 12 | 2.3.3 redirect to the UI after permissions accepted | PASS | `afterAuth` (`shopify.server.ts:127-166`) then library redirect |
| 13 | Token exchange / managed install (App Store distribution) | PASS | `app/shopify.server.ts:39` `AppDistribution.AppStore`; no legacy install flag in the toml |
| 14 | 1.1.1 must work without third-party cookies or local storage | PASS | bearer session token detection `app/lib/auth.server.ts:50-58`; `localStorage` is used only for the theme toggle (`root.tsx:51`, `design/charts.tsx:1163,1183`) inside a `try/catch`, non-essential |
| 15 | Expiring offline access tokens | PASS | `shopify.server.ts:54-56` `future.expiringOfflineAccessTokens: true`. Live changelog 2026-05-20 confirms both dates the repo cites: required for apps created on/after **April 1, 2026**, and "Starting January 1, 2027, all public apps must use expiring offline access tokens when calling the Admin API" — after which non-compliant apps "will receive authentication errors" |
| 16 | `Session` carries `refreshToken` / `refreshTokenExpires` | PASS | baseline fix; adapter `@shopify/shopify-app-session-storage-prisma` 9.0.1 |
| 17 | Auth callback path matches `authPathPrefix` | PASS (path) / **FAIL (host)** | `shopify.app.toml:67` `/auth/callback` matches `authPathPrefix: "/auth"` (`shopify.server.ts:37`), but the host is still `https://shopify.dev/apps/default-app-home` |

### Scope minimization (requirement 3.2)

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 18 | Request only necessary scopes | PASS | `shopify.app.toml:59` — four read-only scopes, no write scope |
| 19 | All four are valid current scope names | PASS | https://shopify.dev/docs/api/usage/access-scopes — `read_orders`, `read_products`, `read_fulfillments`, `read_inventory` all current |
| 20 | 3.2.1 `read_all_orders` justified if requested | PASS | not requested; 60-day cap disclosed in-app (`app/routes/app.layout.tsx:175-189`) |
| 21 | Protected customer data approved | **FAIL** | see **N1** — `read_orders` is protected, and `customer { id email }` puts it at Level 2 |
| 22 | Local `.env` scope drift | FAIL (local only) | `SUBMISSION.md:647-652` — `.env` still lists withdrawn scopes; gitignored, dev instance only. Still true, still not a submission item |

### Webhook verification and TLS

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 23 | HMAC verified on every webhook before any write | PASS | `app/lib/webhooks.server.ts:50-78`; every route goes through `handleWebhook` |
| 24 | 3.1.1 "All data exchanged between a client and your app server should be encrypted using Transport Layer Security" | **UNKNOWN** | nothing is deployed. `DEPLOY_PLAN.md:166` plans `force_https = true` in `fly.toml`; that file has never been built or run |
| 25 | At-least-once delivery handled idempotently | PASS (beyond requirement) | `claimWebhook` on `X-Shopify-Webhook-Id`, `webhooks.server.ts:11-25,94-96` |

### Billing

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 26 | 1.2.1 use App Pricing or the Billing API | PASS | Billing API configured `shopify.server.ts:58-89` |
| 27 | 1.2.2 correctly implemented | PASS | `billing.check` at `app/lib/plan.server.ts:131`, cached 10 min, falls back to the stored row on error |
| 28 | 1.2.3 "upgrade and downgrade their pricing plan without having to contact your support team or having to reinstall the app" | PASS | `app/routes/app.plan.tsx:55-59` `billing.request` for any of the three plans, in-app route `app.layout.tsx:246-249`, no pop-up |
| 29 | Charges are test charges on dev stores | PASS | `plan.server.ts:88` `billingIsTest` |
| 30 | Billing API is now legacy / App Pricing is the default for new apps | **WARN — new since baseline** | see **N4** |

### App Bridge / embedded experience

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 31 | 2.2.3 use the latest App Bridge | PASS | unversioned CDN `https://cdn.shopify.com/shopifycloud/app-bridge.js`, `app/root.tsx:73` |
| 32 | `app-bridge.js` in the `<head>` of every document | PASS, one gap | `root.tsx:69-77` — first script in `<head>`, preceded by `<meta name="shopify-api-key">` at `:71`. Gap: not emitted on the root error document (**N6**) |
| 33 | 2.2.2 consistent embedded experience | PASS | `isEmbeddedApp: true` (`shopify.server.ts:40`); `[pos] embedded = false` is correct for a non-POS app |
| 34 | `frame-ancestors` document headers | PASS | `app/entry.server.tsx:20` `addDocumentResponseHeaders`; `app.layout.tsx:97` `boundary.headers` |
| 35 | Admin-initiated navigation handled | PASS | `shopify:navigate` listener, `app.layout.tsx:329-343`; `AppProvider embedded={false}` at `:313` so the script is not registered twice |
| 36 | Auth failures surface through App Bridge, not an error page | PASS | `app.layout.tsx:104-106` `boundary.error` |
| 37 | 2.2.4 GraphQL Admin API only for new public apps (since 2025-04-01) | PASS | grep for `admin.rest` / `restResources` / `/admin/api/*.json` across `app/` returns nothing |

### Performance / Core Web Vitals

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 38 | LCP ≤ 2.5s, CLS ≤ 0.1, INP ≤ 200ms, at the 75th percentile, min 100 samples over 28 days | **Confirmed accurate, and confirmed NOT a submission gate** | https://shopify.dev/docs/apps/launch/built-for-shopify/requirements — these are **Built for Shopify status** requirements, not App Store submission requirements. `SUBMISSION.md:88-92` quotes the same numbers and correctly calls it "not a hard gate at submission". Verdict on the numbers: PASS. Verdict on actual performance: **UNKNOWN** — never measured, the app has never been installed |
| 39 | App Bridge present so Shopify can sample vitals at all | PASS | as #32; the doc says "your app needs to use the latest version of App Bridge" for metrics to be gathered |
| 40 | Storefront Lighthouse score not reduced by >10 points | N/A | `extensions/` is empty; Meridian ships no theme or storefront code |

### Listing

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 41 | Icon 1200×1200 JPEG/PNG | PASS | `listing/app-icon-1200.png`, measured 1200×1200 |
| 42 | 3–6 desktop screenshots at 1600×900 | PASS | five files in `listing/screenshots/`, every one measured 1600×900 |
| 43 | 4.4.4 images show the real UI, no browser chrome or desktop background (enforced since 2026-03-26) | PASS, one nit | inspected `listing/screenshots/overview.png` directly: real UI, no chrome, ad spend correctly `$0` with a dash. Nit — the sidebar footer reads "Demo data. A seeded store…", which is visible in the shipped listing image |
| 44 | 4.4.5 each image unique | PASS | five distinct screens |
| 45 | 4.1.2 unique app name | **FAIL / high risk** | see **N3** |
| 46 | Name ≤30 / intro ≤100 / details ≤500 / features ≤80 | PASS (drafted) | `listing/copy.md:18-113`, counts measured |
| 47 | 4.3.3 no statistics or data in listing content | PASS | `listing/copy.md` carries no stats |
| 48 | Feature media (1600×900 image or 2–3 min video) | **FAIL** | missing; unchanged from baseline |
| 49 | Demo store URL | **FAIL** | missing; needs Phase 2 |
| 50 | 4.5.3 screencast of onboarding, English or English-subtitled | **FAIL** | missing; automatic bounce; needs a real install |
| 51 | 4.5.4 / 4.5.5 account credentials in the testing instructions, valid and granting the full feature set | **UNKNOWN — not tracked anywhere in the baseline** | Meridian has no third-party login, so this reduces to the demo store plus written instructions, but nothing in `SUBMISSION.md`, `DEPLOY_PLAN.md` or `listing/copy.md` drafts those instructions. Worth writing before submission |
| 52 | 4.5.6 emergency developer contact in the Dashboard | **FAIL** | owner-only; `DEPLOY_PLAN.md:307-310` §6d |
| 53 | Public privacy policy URL | PASS (route) / FAIL (contents) | `app/routes.ts:9` public and unauthenticated — but see **N2** |
| 54 | Public support page + monitored support email | PASS (route) / **FAIL (unset)** | `app/routes.ts:10`; `MERIDIAN_SUPPORT_EMAIL` / `MERIDIAN_LEGAL_ENTITY` unset, pages render a "not configured" notice |
| 55 | 1.1.4 app and listing contain only factual information | **FAIL** | see **N2** |

### Still blocking, restated from the baseline and re-confirmed

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 56 | Real, stable, public HTTPS `application_url` | **FAIL** | `shopify.app.toml:37` is still `https://shopify.dev/apps/default-app-home`. Every webhook `uri` is relative and resolves against it, so all compliance webhooks resolve to a host Shopify cannot deliver to; the string also contains "shopify" |
| 57 | `automatically_update_urls_on_dev = false` before going live | **FAIL** | `shopify.app.toml:132` is still `true` |
| 58 | Nothing has ever run against real Shopify credentials | **UNKNOWN by construction** | `SUBMISSION.md:656-676` — no OAuth install, no real webhook delivery, no `billing.check` against a real charge, nothing inside the admin iframe |

---

## Process changes since 2026-08-05 worth knowing

| Date | Change | Why it matters here | URL |
|---|---|---|---|
| 2026-06-02 | App review and ongoing app audits are now managed in the Partner Dashboard (App → Distribution) with requirement-level tracking and direct messaging, replacing email-based review communication | `DEPLOY_PLAN.md` §5/§6 assume the older flow | https://shopify.dev/changelog/app-quality-checks-now-managed-in-partner-dashboard |
| 2026-07-06 | Requirement 1.3 tightened on incentivised/fake reviews; Shopify is unpublishing reviews that fail its authenticity bar | Post-launch, not submission | https://shopify.dev/changelog/updated-app-store-requirements-13-always-use-honest-and-transparent-review-practices |
| 2026-07-09 | Partner identity verification (Stripe, government ID + liveness) is optional now and "will become mandatory in the coming weeks before sending a new collaborator request" | Needed if anyone but Connor needs collaborator access to the demo/dev store | https://shopify.dev/changelog/identity-verification-for-partners |
| 2026-06-01 | App Home as a UI extension (API 2026-07) | Explicitly **not** for public App Store apps — "the iframe model remains recommended for most apps". No action; noted so nobody chases it | https://shopify.dev/changelog/build-app-home-as-a-ui-extension |

Checked and found **unchanged** in the 2026-05-01 → 2026-08-06 window: the
compliance webhook topics and their 401/200 contract, `app/uninstalled` and
`app/scopes_update`, session tokens and token exchange, the `app-bridge.js` script
tag and its meta tag, webhook HMAC/retry/TLS mechanics, and the protected customer
data framework itself.

---

## Suggested order of attack

1. **Protected Customer Data request, Level 2** (N1) — longest lead time, runs on
   Shopify's clock, and nothing works without it. Start today.
2. **Decide the app name** (N3) — everything in `listing/` and `shopify.app.toml`
   depends on the answer, and there is a live app with the exact name.
3. **Fix the privacy policy** (N2) — a small edit, but it is also the answer to a
   question the PCD questionnaire in step 1 asks.
4. `application_url` (#56/#57) and the Fly deploy — unchanged from `DEPLOY_PLAN.md`.
5. Decide Billing API vs App Pricing deliberately (N4) before configuring pricing
   at submission.
6. Move the data-request export off the webhook response path (N5).
