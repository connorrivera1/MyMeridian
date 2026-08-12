# Shopify submission packet checklist

Preparation only. Do not attest, submit, publish, create charges or alter the
Partner Dashboard without Connor's explicit authorization. Status is governed by
[`LAUNCH_READINESS.md`](LAUNCH_READINESS.md).

## Required packet

- [ ] Partner organization and public app registration are owned by Connor.
- [ ] Stable production HTTPS application URL is live; all URLs in deployed
  Shopify configuration use it, not a tunnel, localhost, example or Shopify
  placeholder.
- [ ] Required scopes are minimal and match code, listing and data-protection
  request. Protected customer-data request is completed **before** submitting:
  Shopify does not allow a new request while the app is under review.
- [ ] Reviewer-accessible controlled store, install instructions, test steps,
  test credentials and any test billing instructions are supplied; no personal
  credentials are embedded in the submission.
- [ ] Short screencast demonstrates install, embedded core workflow,
  onboarding, historical import, pricing/billing, settings and privacy flow.
- [ ] Current screenshots/media reflect the shipped colorful UI, actual plan
  pricing and only currently working connector capability.
- [ ] 1200×1200 JPEG/PNG app icon, primary language, category, listing title,
  truthful description, pricing and support details are complete.
- [ ] Public privacy policy and terms use Connor's approved legal entity,
  support address and statements. The repository does not invent these answers.
- [ ] Monitored support contact and emergency technical contact (email + phone)
  are entered by Connor.
- [ ] Billing uses Shopify Billing API, with current Starter $49/$490, Growth
  $129/$1,290 and Scale $299/$2,990 details; production approval/decline and
  lifecycle tests are recorded.
- [ ] Shopify App Store automated checks are run and all failures resolved.
- [ ] Production verification evidence exists for install, auth, onboarding,
  import, webhooks, uninstall/reinstall, GDPR, backups, monitoring, connector
  availability and failure recovery.
- [ ] All App Store requirements have been self-reviewed against the actual
  deployed app and listing; no stale claim, unavailable connector or unapproved
  protected-data feature remains advertised.

## Not ready to submit until Connor supplies

1. Partner/app ownership and any required identity/payment/business answers.
2. Final domain, production origin, publisher legal entity, support and
   emergency contacts.
3. Protected customer-data request answers/evidence and Shopify approval.
4. Production deployment authorization and its recorded acceptance evidence.
5. Final reviewer account/store and current media/screencast.

Shopify references: [submission requirements](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review),
[review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process),
[App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements),
and [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).
