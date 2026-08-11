import {
  processAppScopesUpdateWebhook,
  processAppSubscriptionsWebhook,
  processAppUninstalledWebhook,
  processCheckoutsWebhook,
  processCustomerDataRequestWebhook,
  processCustomersRedactWebhook,
  processFulfillmentsWebhook,
  processInventoryItemsWebhook,
  processOrdersWebhook,
  processProductsWebhook,
  processShopRedactWebhook,
  processShopUpdateWebhook,
} from "~/lib/webhook-processors.server";
import type { WebhookContext } from "~/lib/webhooks.server";
import { normaliseWebhookTopic } from "~/lib/webhook-payload.server";

export { normaliseWebhookTopic } from "~/lib/webhook-payload.server";

/** Retry through the same server-only processor used by the HTTP action. */
export async function dispatchPersistedWebhook(
  context: WebhookContext,
): Promise<void> {
  const topic = normaliseWebhookTopic(context.topic);
  const routeContext =
    topic === context.topic ? context : { ...context, topic };

  switch (topic) {
    case "ORDERS_CREATE":
    case "ORDERS_UPDATED":
    case "REFUNDS_CREATE":
      return processOrdersWebhook(routeContext);
    case "CHECKOUTS_CREATE":
    case "CHECKOUTS_UPDATE":
      return processCheckoutsWebhook(routeContext);
    case "PRODUCTS_CREATE":
    case "PRODUCTS_UPDATE":
      return processProductsWebhook(routeContext);
    case "FULFILLMENTS_CREATE":
    case "FULFILLMENTS_UPDATE":
      return processFulfillmentsWebhook(routeContext);
    case "INVENTORY_ITEMS_UPDATE":
      return processInventoryItemsWebhook(routeContext);
    case "APP_UNINSTALLED":
      return processAppUninstalledWebhook(routeContext);
    case "SHOP_UPDATE":
      return processShopUpdateWebhook(routeContext);
    case "APP_SUBSCRIPTIONS_UPDATE":
    case "APP_SUBSCRIPTIONS_APPROACHING_CAPPED_AMOUNT":
      return processAppSubscriptionsWebhook(routeContext);
    case "APP_SCOPES_UPDATE":
      return processAppScopesUpdateWebhook(routeContext);
    case "CUSTOMERS_DATA_REQUEST":
      return processCustomerDataRequestWebhook(routeContext);
    case "CUSTOMERS_REDACT":
      return processCustomersRedactWebhook(routeContext);
    case "SHOP_REDACT":
      return processShopRedactWebhook(routeContext);
    default:
      throw new Error(
        `No durable webhook processor for topic ${context.topic}`,
      );
  }
}
