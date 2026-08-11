/**
 * Deliberately small webhook payloads for durable recovery.
 *
 * Shopify's order payload contains names, addresses, phone numbers, IP
 * addresses, browser details and payment metadata. Meridian's processors use
 * none of those fields. Persisting the authenticated wire payload merely
 * because the queue can replay it would turn bounded recovery state into an
 * unnecessary second protected-customer-data store.
 *
 * Every topic is projected explicitly. Adding a processor dependency therefore
 * requires adding that field here and a test that explains why it is retained.
 */

type Payload = Record<string, unknown>;

function record(value: unknown): Payload | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : null;
}

function copy(source: Payload, keys: readonly string[]): Payload {
  const result: Payload = {};
  for (const key of keys) {
    const value = source[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  return result;
}

function nestedMoney(value: unknown): Payload | undefined {
  const outer = record(value);
  const shopMoney = record(outer?.shop_money);
  if (!shopMoney) return undefined;
  const minimized = copy(shopMoney, ["amount"]);
  return Object.keys(minimized).length > 0
    ? { shop_money: minimized }
    : undefined;
}

function arrayOfRecords(value: unknown): Payload[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Payload => item !== null)
    : [];
}

function minimizeOrder(payload: Payload): Payload {
  const result = copy(payload, [
    "id",
    "order_number",
    "number",
    "processed_at",
    "created_at",
    "updated_at",
    "currency",
    "subtotal_price",
    "total_discounts",
    "total_tax",
    "total_price",
    "financial_status",
    "fulfillment_status",
    "landing_site",
    "referring_site",
  ]);

  const customer = record(payload.customer);
  if (customer) {
    const minimized = copy(customer, ["id", "email"]);
    if (Object.keys(minimized).length > 0) result.customer = minimized;
  }

  const shippingSet = nestedMoney(payload.total_shipping_price_set);
  if (shippingSet) result.total_shipping_price_set = shippingSet;

  const shippingLines = arrayOfRecords(payload.shipping_lines).map((line) =>
    copy(line, ["price"]),
  );
  if (shippingLines.length > 0) result.shipping_lines = shippingLines;

  const lineItems = arrayOfRecords(payload.line_items).map((item) => {
    const minimized = copy(item, [
      "id",
      "variant_id",
      "product_id",
      "title",
      "name",
      "sku",
      "quantity",
      "price",
    ]);
    const allocations = arrayOfRecords(item.discount_allocations).map(
      (allocation) => copy(allocation, ["amount"]),
    );
    if (allocations.length > 0) minimized.discount_allocations = allocations;
    return minimized;
  });
  if (lineItems.length > 0) result.line_items = lineItems;

  const refunds = arrayOfRecords(payload.refunds).map((refund) => {
    const minimized: Payload = {};
    const transactions = arrayOfRecords(refund.transactions).map((tx) =>
      copy(tx, ["status", "kind", "amount"]),
    );
    if (transactions.length > 0) minimized.transactions = transactions;

    const refundLineItems = arrayOfRecords(refund.refund_line_items).map(
      (item) => copy(item, ["line_item_id", "quantity"]),
    );
    if (refundLineItems.length > 0) {
      minimized.refund_line_items = refundLineItems;
    }
    return minimized;
  });
  if (refunds.length > 0) result.refunds = refunds;

  return result;
}

function minimizeProduct(payload: Payload): Payload {
  const result = copy(payload, [
    "id",
    "title",
    "handle",
    "product_type",
    "vendor",
    "status",
    "updated_at",
  ]);
  const image = record(payload.image);
  if (image) {
    const minimized = copy(image, ["src"]);
    if (Object.keys(minimized).length > 0) result.image = minimized;
  }
  const variants = arrayOfRecords(payload.variants).map((variant) =>
    copy(variant, [
      "id",
      "sku",
      "title",
      "price",
      "compare_at_price",
      "inventory_quantity",
      "grams",
      "updated_at",
    ]),
  );
  if (variants.length > 0) result.variants = variants;
  const variantGids = arrayOfRecords(payload.variant_gids).map((variant) =>
    copy(variant, ["admin_graphql_api_id"]),
  );
  if (variantGids.length > 0) result.variant_gids = variantGids;
  return result;
}

function minimizeFulfillment(payload: Payload): Payload {
  const result = copy(payload, [
    "id",
    "order_id",
    "created_at",
    "updated_at",
    "status",
    "tracking_company",
    "service",
    "location_id",
  ]);
  const lineItems = arrayOfRecords(payload.line_items).map((item) =>
    copy(item, ["quantity"]),
  );
  if (lineItems.length > 0) result.line_items = lineItems;
  return result;
}

function minimizeInventoryItem(payload: Payload): Payload {
  return copy(payload, ["id", "cost", "updated_at"]);
}

function minimizeSubscription(payload: Payload): Payload {
  const subscription = record(payload.app_subscription);
  if (!subscription) return {};
  return {
    app_subscription: copy(subscription, [
      "admin_graphql_api_id",
      "name",
      "status",
      "trial_ends_on",
      "billing_on",
    ]),
  };
}

function minimizeCheckout(payload: Payload): Payload {
  const result = copy(payload, [
    "token",
    "cart_token",
    "currency",
    "total_price",
    "created_at",
    "updated_at",
    "completed_at",
  ]);
  const lineItems = arrayOfRecords(payload.line_items).map((item) =>
    copy(item, ["id", "variant_id", "product_id", "quantity", "price"]),
  );
  if (lineItems.length > 0) result.line_items = lineItems;
  return result;
}

function minimizeScopes(payload: Payload): Payload {
  const current = payload.current;
  if (typeof current === "string") return { current };
  if (Array.isArray(current)) {
    return {
      current: current.filter(
        (scope): scope is string => typeof scope === "string",
      ),
    };
  }
  return {};
}

function minimizeCustomerReference(payload: Payload): Payload {
  const customer = record(payload.customer);
  if (!customer) return {};
  const minimized = copy(customer, ["id", "email"]);
  return Object.keys(minimized).length > 0 ? { customer: minimized } : {};
}

/** Accept both SDK SCREAMING_SNAKE_CASE and Shopify wire-format slashes. */
export function normaliseWebhookTopic(topic: string): string {
  return topic.trim().toUpperCase().replaceAll("/", "_").replaceAll("-", "_");
}

/**
 * Project an authenticated wire payload onto the exact fields its processor
 * consumes. Unknown topics fail closed instead of persisting an unreviewed
 * payload shape.
 */
export function minimizeWebhookPayload(
  topic: string,
  payload: Payload,
): Payload {
  switch (normaliseWebhookTopic(topic)) {
    case "ORDERS_CREATE":
    case "ORDERS_UPDATED":
      return minimizeOrder(payload);
    case "REFUNDS_CREATE":
      // The refund processor deliberately waits for orders/updated, which is
      // the authoritative order state. It consumes no refund fields.
      return {};
    case "PRODUCTS_CREATE":
    case "PRODUCTS_UPDATE":
      return minimizeProduct(payload);
    case "FULFILLMENTS_CREATE":
    case "FULFILLMENTS_UPDATE":
      return minimizeFulfillment(payload);
    case "INVENTORY_ITEMS_UPDATE":
      return minimizeInventoryItem(payload);
    case "APP_UNINSTALLED":
    case "SHOP_UPDATE":
    case "SHOP_REDACT":
      return {};
    case "APP_SUBSCRIPTIONS_UPDATE":
      return minimizeSubscription(payload);
    case "CHECKOUTS_CREATE":
    case "CHECKOUTS_UPDATE":
      return minimizeCheckout(payload);
    case "APP_SCOPES_UPDATE":
      return minimizeScopes(payload);
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      return minimizeCustomerReference(payload);
    default:
      throw new Error(
        `No minimized webhook payload contract for topic ${topic}`,
      );
  }
}

export interface CustomerReference {
  id?: string | number;
  email?: string;
}

function sameId(left: unknown, right: unknown): boolean {
  if (
    left === undefined ||
    left === null ||
    right === undefined ||
    right === null
  ) {
    return false;
  }
  const normalize = (value: unknown) =>
    String(value)
      .trim()
      .replace(/^gid:\/\/shopify\/Customer\//i, "");
  return normalize(left) === normalize(right);
}

function sameEmail(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Whether a minimized payload still names this shopper. */
export function payloadReferencesCustomer(
  payload: Payload,
  customer: CustomerReference,
): boolean {
  const referenced = record(payload.customer);
  if (!referenced) return false;
  // A supplied Shopify customer id is authoritative. Two different customer
  // records can legitimately share an email address, and an id-less queued
  // order cannot safely be assigned to the named stable id from email alone.
  // Email matching is reserved for a genuinely id-less request.
  if (customer.id !== undefined && customer.id !== null) {
    return (
      referenced.id !== undefined &&
      referenced.id !== null &&
      sameId(referenced.id, customer.id)
    );
  }
  return sameEmail(referenced.email, customer.email);
}

/**
 * Remove identity from a pending order while preserving the economic payload
 * required to finish importing it anonymously after customers/redact.
 */
export function scrubCustomerFromWebhookPayload(
  topic: string,
  payload: Payload,
  customer: CustomerReference,
): Payload {
  if (!payloadReferencesCustomer(payload, customer)) return payload;
  const normalized = normaliseWebhookTopic(topic);
  if (normalized !== "ORDERS_CREATE" && normalized !== "ORDERS_UPDATED") {
    return {};
  }
  // Landing/referring URLs can carry email addresses, customer ids, campaign
  // tokens, or other personalized query parameters. They are not required to
  // finish importing the order economically after redaction.
  const {
    customer: _customer,
    landing_site: _landingSite,
    referring_site: _referringSite,
    ...anonymous
  } = payload;
  return anonymous;
}
