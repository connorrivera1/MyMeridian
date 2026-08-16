# Shopify protected customer data request packet

Prepared for the Partner Dashboard request. Do not submit until the production
origin, public privacy policy, and legal publisher contact are live. The
submission must request only the data required by the released feature set.

## Requested access

Request **Protected customer data** and the **Email** field.

`read_orders` supplies the customer identifier and customer email attached to
an order. MyMeridian stores those two values only to link repeat orders for the
merchant and to locate the correct records when Shopify sends a
`customers/data_request` or `customers/redact` compliance webhook. It does not
request `read_customers` and does not use customer records for advertising,
profiling, or marketing.

For the Shopify Shipping and Shop Campaigns ShopifyQL integration, request the
Level 2 field approvals ShopifyQL requires: **Name, Address, Email, and Phone**.
The integration queries aggregate shipment-label and campaign metrics; it does
not select, retain, export, or disclose shopper name, address, email, or phone
from those reports. The app keeps those integrations paused until Shopify
approves the required access and handles an approval denial as unavailable data
rather than substituting zero.

## Purpose and merchant value

MyMeridian gives a merchant qualified order and product profitability. It needs
order-linked identity only to honor the merchant's data-access and erasure
obligations without confusing one shopper's request with another's. The
ShopifyQL fields above are a platform access prerequisite for aggregate carrier
and Shop Campaign cost reports; MyMeridian does not use the direct identifiers
that ShopifyQL gates.

## Data minimization and handling

- Stored shopper fields: Shopify customer ID and email from order data.
- Not stored: shopper name, phone, billing/shipping address, IP address,
  payment-card data, tracking number, or Shopify customer object beyond those
  two fields.
- Store data is tenant-isolated in PostgreSQL; tenant application roles are
  restricted by row-level security.
- Shopify and provider tokens are server-side; third-party connector tokens use
  AES-256-GCM encryption at rest.
- Webhooks are HMAC-verified. Recovery payloads are minimized, cleared after
  successful processing, and failed order payloads are irreversibly cleared
  after seven days.
- The merchant is the controller. MyMeridian acts as processor and makes a
  data-request export available only to the authenticated merchant.

## Retention and deletion

- Store data is retained while the merchant has the app installed.
- `shop/redact` deletes the store's records, sessions, products, cost rules,
  connectors and related data.
- `customers/redact` removes the customer record and link to their orders,
  clears related attribution fields, and retains only keyed, one-way erasure
  guards until the store itself is removed.
- A customer data-request export expires after 31 days whether or not the
  merchant collects it.

## Evidence to attach or link

1. Production privacy policy: `https://mymeridian.io/privacy`.
2. Production support/legal contact: `https://mymeridian.io/support`.
3. Data flow and deletion behavior: `docs/DATA_PROTECTION.md` and
   `docs/BACKUP_RESTORE_RUNBOOK.md`.
4. Reviewer screencast showing the privacy-requests surface, the missing-data
   state, and merchant-controlled connector authorization.

Before submission, re-read this packet against the production deployment and
remove any request whose related feature is not in the submitted release.
