import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shopFindUnique: vi.fn(),
  checkoutFindUnique: vi.fn(),
  checkoutUpsert: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    checkout: {
      findUnique: mocks.checkoutFindUnique,
      upsert: mocks.checkoutUpsert,
    },
  },
}));

vi.mock("~/lib/usage-meter.server", () => ({
  recordOrderUsage: vi.fn(),
  billSoftOrderOverage: vi.fn(),
}));

const { processCheckoutsWebhook } = await import("./webhook-processors.server");

const context = (payload: Record<string, unknown>) => ({
  shopDomain: "checkout-test.myshopify.com",
  topic: "CHECKOUTS_UPDATE",
  webhookId: "checkout-delivery-1",
  payload,
  isReplay: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    currency: "USD",
  });
  mocks.checkoutFindUnique.mockResolvedValue(null);
  mocks.checkoutUpsert.mockResolvedValue(undefined);
});

describe("checkout webhook processor", () => {
  it("projects a checkout without calling Shopify or retaining customer fields", async () => {
    await processCheckoutsWebhook(
      context({
        token: "checkout-token",
        cart_token: "cart-token",
        email: "buyer@example.com",
        currency: "USD",
        total_price: "42.00",
        created_at: "2026-08-11T10:00:00Z",
        updated_at: "2026-08-11T10:01:00Z",
        line_items: [
          { variant_id: 7, quantity: 2, price: "21.00", properties: [{ value: "secret" }] },
        ],
      }),
    );

    expect(mocks.checkoutUpsert).toHaveBeenCalledWith({
      where: { shopId_token: { shopId: "shop_1", token: "checkout-token" } },
      create: expect.objectContaining({
        shopId: "shop_1",
        token: "checkout-token",
        total: "42.00",
        lineCount: 1,
        totalQuantity: 2,
        shopifyUpdatedAt: new Date("2026-08-11T10:01:00Z"),
      }),
      update: expect.objectContaining({ totalQuantity: 2 }),
    });
  });

  it("does not let a delayed update roll back a newer checkout snapshot", async () => {
    mocks.checkoutFindUnique.mockResolvedValue({
      shopifyUpdatedAt: new Date("2026-08-11T10:02:00Z"),
    });

    await processCheckoutsWebhook(
      context({
        token: "checkout-token",
        updated_at: "2026-08-11T10:01:00Z",
        line_items: [],
      }),
    );

    expect(mocks.checkoutUpsert).not.toHaveBeenCalled();
  });

  it("fails visibly when Shopify omits the stable checkout token", async () => {
    await expect(processCheckoutsWebhook(context({}))).rejects.toThrow(
      /omitted its token/,
    );
  });
});
