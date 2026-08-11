import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WebhookContext } from "~/lib/webhooks.server";

const processors = vi.hoisted(() => ({
  orders: vi.fn(),
  products: vi.fn(),
  fulfillments: vi.fn(),
  inventoryItems: vi.fn(),
  uninstalled: vi.fn(),
  subscriptions: vi.fn(),
  scopes: vi.fn(),
  dataRequest: vi.fn(),
  customersRedact: vi.fn(),
  shopRedact: vi.fn(),
  shopUpdate: vi.fn(),
  checkouts: vi.fn(),
}));

vi.mock("~/lib/webhook-processors.server", () => ({
  processOrdersWebhook: processors.orders,
  processProductsWebhook: processors.products,
  processFulfillmentsWebhook: processors.fulfillments,
  processInventoryItemsWebhook: processors.inventoryItems,
  processAppUninstalledWebhook: processors.uninstalled,
  processAppSubscriptionsWebhook: processors.subscriptions,
  processAppScopesUpdateWebhook: processors.scopes,
  processCustomerDataRequestWebhook: processors.dataRequest,
  processCustomersRedactWebhook: processors.customersRedact,
  processShopRedactWebhook: processors.shopRedact,
  processShopUpdateWebhook: processors.shopUpdate,
  processCheckoutsWebhook: processors.checkouts,
}));

const { dispatchPersistedWebhook } = await import("./webhook-dispatch.server");

function context(topic: string): WebhookContext {
  return {
    shopDomain: "queue-test.myshopify.com",
    topic,
    webhookId: `delivery-${topic}`,
    payload: { topic },
    isReplay: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const processor of Object.values(processors)) {
    processor.mockResolvedValue(undefined);
  }
});

describe("persisted webhook dispatch", () => {
  it.each([
    ["orders/create", processors.orders],
    ["ORDERS_UPDATED", processors.orders],
    ["checkouts/create", processors.checkouts],
    ["CHECKOUTS_UPDATE", processors.checkouts],
    ["refunds/create", processors.orders],
    ["products/create", processors.products],
    ["PRODUCTS_UPDATE", processors.products],
    ["fulfillments/create", processors.fulfillments],
    ["FULFILLMENTS_UPDATE", processors.fulfillments],
    ["inventory_items/update", processors.inventoryItems],
    ["app/uninstalled", processors.uninstalled],
    ["app_subscriptions/update", processors.subscriptions],
    ["app/scopes_update", processors.scopes],
    ["customers/data_request", processors.dataRequest],
    ["customers/redact", processors.customersRedact],
    ["shop/redact", processors.shopRedact],
    ["shop/update", processors.shopUpdate],
    ["app_subscriptions/approaching_capped_amount", processors.subscriptions],
  ])(
    "routes %s through its exported HTTP-route processor",
    async (topic, processor) => {
      const delivery = context(topic);
      await dispatchPersistedWebhook(delivery);
      expect(processor).toHaveBeenCalledOnce();
      expect(processor).toHaveBeenCalledWith({
        ...delivery,
        topic: topic.toUpperCase().replaceAll("/", "_").replaceAll("-", "_"),
      });
    },
  );

  it("refuses to silently consume a topic with no processor", async () => {
    await expect(
      dispatchPersistedWebhook(context("inventory_levels/update")),
    ).rejects.toThrow(/no durable webhook processor/i);
  });

  it("propagates a product processor failure so the durable delivery retries", async () => {
    const failure = new Error("price history insert failed");
    processors.products.mockRejectedValueOnce(failure);

    await expect(
      dispatchPersistedWebhook(context("products/update")),
    ).rejects.toBe(failure);
  });
});
