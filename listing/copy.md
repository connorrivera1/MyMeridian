# MyMeridian Shopify App Store listing

**Submission state:** prepared locally; not submitted or published. This is the
source of truth for the Partner Dashboard fields and reviewer handoff.

## App name — 30-character limit

```
MyMeridian
```

## Introduction — 100-character limit

```
See order and product profit after COGS, shipping, fees and overhead; missing ad spend is disclosed.
```

## App details — 500-character limit

```
Shopify shows sales. MyMeridian shows profit from the inputs it can verify.

It imports orders, products, item costs and fulfilments, then applies payment, shipping, pick-and-pack and overhead models. Missing COGS and unsynced ad spend stay visible instead of becoming zero.

When their providers authorize access, merchants can connect Meta, Google Ads, TikTok Ads and ShipStation. MyMeridian also provides profit alerts, exports and weekly summaries.

MyMeridian requests read-only Shopify access.
```

## Feature bullets — 80 characters each

```
Profit per order after COGS, shipping, payment fees and configured overhead
```

```
Keep missing COGS, ad spend and unavailable data explicit
```

```
Find margin drops, refund spikes, carrier drift and missing product costs
```

```
Export private order-level profit CSVs
```

```
Read-only Shopify access. MyMeridian never changes your store
```

## Reviewer instructions

Paste the following only after replacing every bracketed value with the
controlled review-store information. Do not put provider or production secrets
in this field.

```
MyMeridian requires no separate signup on the Shopify installation path.

Demo store: [REVIEW STORE URL]
Storefront password: [PASSWORD OR DELETE THIS LINE]
Support: [MONITORED SUPPORT EMAIL]

1. Install MyMeridian from the listing and open it inside Shopify Admin. It
   requests read-only access to orders, products, fulfilments, inventory and
   reports; it requests no write scope.

2. Choose Scale monthly ($299/month) to review the paid feature set,
   including Pricing, Fulfilment, weekly summaries, CSV export and multi-store
   portfolio access. The review store must be a Shopify development store so
   the charge is a Shopify test charge.

3. Let the initial import complete, then use Settings to review the payment,
   shipping, pick-and-pack and overhead assumptions.

4. Walk Overview, Profit per order, Products, Acquisition, Pricing,
   Fulfilment, Reports & Exports, and Privacy requests. Missing inputs stay
   labelled rather than becoming $0. A new store has insufficient observed
   history for a pricing recommendation; this is expected.

5. Test the Plan page to change between plans. Billing determines whether the
   review store receives Shopify test billing at request time through
   resolveBillingChargeMode and ShopPlan.partnerDevelopment.

6. Customer-lifecycle product classifications, customer counts, CAC, lifetime
   value and payback are not part of this review scope. MyMeridian does not request read_customers.
   If read_all_orders or Protected Customer Data access is still pending Shopify
   approval, review the available history and the in-app explanation instead of
   treating the unavailable data as complete.
```

## Submitted media

Use these checked-in assets without altering the supplied aspect ratios:

| Submission field | Asset |
| --- | --- |
| App icon (1200 × 1200) | `listing/app-icon-1200.png` |
| Feature media (1600 × 900) | `listing/feature-media-1600x900.png` |
| Desktop screenshots (3200 × 1800) | `listing/screenshots/overview.png`, `orders.png`, `products.png`, `acquisition.png`, `pricing.png`, `fulfilment.png` |

The feature media and all six screenshots are local submission assets. They
are not evidence of a production deployment or provider authorization.

## Claims and availability boundary

- Order, product and configured-cost profitability are available from Shopify
  data and merchant-entered assumptions.
- Meta, Google Ads, TikTok Ads and ShipStation require the relevant provider
  authorization before a merchant can connect or import data.
- Missing COGS, unavailable history and unsynced ad spend are shown as
  incomplete or unavailable, never assumed to be zero.
- MyMeridian asks Shopify for read-only scopes and does not write to a store.

## Still required from the owner

1. A deployed production origin serving MyMeridian, with the final legal and
   support pages reachable there.
2. Shopify approval for the required public-distribution scopes, including
   `read_all_orders` and Protected Customer Data where the submitted feature
   set needs them.
3. A controlled development review store, its access instructions, a monitored
   support email, an emergency developer contact, and a current app screencast.
4. The final legal business identity and attestations in Shopify's Partner
   Dashboard.
5. Production/provider credentials and acceptance evidence for every connector
   represented in the listing.

Nothing in this file records a Partner Dashboard submission, a public listing,
or a production release.
