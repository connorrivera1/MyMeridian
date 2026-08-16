# Pre-launch waitlist and Founding Merchant benefit

This is the public pre-launch path for `https://mymeridian.io`. It deliberately
does not remove `/login`, `/signup`, Shopify authentication, operator routes or
review/test routes. Those remain private/internal until the product launch
gate is approved.

## Visitor flow

1. The landing page directs visitors to **Join the waitlist** / **Get early
   access**, not to account creation.
2. `POST /waitlist` accepts a required normalized email address, optional
   HTTPS store origin, optional marketing consent and bounded first-party UTM
   fields. A same-origin check, honeypot and database-backed IP/email rate
   limits precede persistence.
3. The public response is identical for new and duplicate emails and redirects
   to `/waitlist/confirmed`; it never reveals whether an address already exists.
4. A transaction creates one publisher-level `WaitlistSignup`, one linked
   `FoundingMerchantEntitlement`, and one idempotent welcome-email delivery
   receipt. These are protected by RLS and are not merchant tenant data.
5. The delivery worker sends the branded transactional confirmation only when
   both `RESEND_API_KEY` and `MERIDIAN_EMAIL_FROM` are configured. Otherwise
   the receipt remains pending without claiming delivery. Provider failures are
   retried with a lease, idempotency key and exponential backoff; terminal
   receipts are retained for 90 days.

## Founding Merchant enforcement

The benefit is **15% off the first 12 monthly billing intervals**. It is not a
lifetime discount and does not combine with annual pricing. There is no public
coupon string and no synthetic Shopify discount code.

At launch, a verified OWNER web-account email is matched to a waitlist signup.
Before a merchant sees Shopify's billing approval page, the app atomically
reserves that entitlement for the shop for 24 hours. Only then can the server
select a monthly `*-founding` Shopify Billing API configuration, whose recurring
line item uses the documented `15%` percentage discount with a `12`-interval
duration. The subscription webhook marks the reserved entitlement redeemed only
after Shopify confirms the matching subscription. The normal plan route rejects
any crafted founding key without this server-side reservation.

The benefit is intentionally absent from annual and plan-change billing keys.
The operator overview reports only aggregate eligibility counts, never a list
of waitlist emails or store URLs. Treat a published text code such as `EARLY15`
as a marketing label only if the owner later approves it; it must not become the
actual authorization mechanism.

## Newsletter consent

The waitlist welcome is transactional. The optional checkbox controls future
marketing/newsletter eligibility only. `waitlistUnsubscribeToken()` creates a
recipient-specific HMAC link for the consent-aware `/waitlist/unsubscribe`
confirmation/POST flow; a mail scanner's GET cannot change consent. Future
product-update templates require that URL and must not be sent until a
consent-aware marketing sender is enabled. Do not use the waitlist as a
newsletter mailing list by default.

## Activation checklist

1. In Resend, verify `mymeridian.io`, create a restricted production API key,
   and set `MERIDIAN_EMAIL_FROM="MyMeridian <welcome@mymeridian.io>"` plus
   `MERIDIAN_PUBLIC_ORIGIN=https://mymeridian.io` in the production secret
   store.
2. Deploy only after the approved infrastructure gate and make a controlled
   signup to prove provider acceptance and inbox delivery. A configured key or
   a queued receipt alone is not delivery proof.
3. Before launch, test a verified owner whose email is eligible through the
   Shopify approval and subscription-webhook path in a controlled store.
4. Do not advertise scarcity unless the owner defines and enforces an actual
   qualifying limit. This implementation intentionally has no fake count,
   timer, or first-N claim.
