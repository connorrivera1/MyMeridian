import { ShippingCostSource, ShippingObservationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orderFindMany: vi.fn(),
  observationUpsert: vi.fn(),
  observationFindMany: vi.fn(),
  observationUpdateMany: vi.fn(),
  fulfillmentFindMany: vi.fn(),
  fulfillmentUpdate: vi.fn(),
  recompute: vi.fn(),
}));

vi.mock("~/db.server", () => {
  const client = {
    order: { findMany: (...args: unknown[]) => mocks.orderFindMany(...args) },
    shippingCostObservation: {
      upsert: (...args: unknown[]) => mocks.observationUpsert(...args),
      findMany: (...args: unknown[]) => mocks.observationFindMany(...args),
      updateMany: (...args: unknown[]) => mocks.observationUpdateMany(...args),
    },
    fulfillment: {
      findMany: (...args: unknown[]) => mocks.fulfillmentFindMany(...args),
      update: (...args: unknown[]) => mocks.fulfillmentUpdate(...args),
    },
    $transaction: (promises: Promise<unknown>[]) => Promise.all(promises),
  };
  return { default: client };
});
vi.mock("~/lib/recompute.server", () => ({
  recomputeShopProfitability: (...args: unknown[]) => mocks.recompute(...args),
}));

const { reconcileShippingObservations } = await import("./shipping.server");

const observation = {
  source: ShippingCostSource.SHIPSTATION,
  externalId: "label-1",
  externalOrderRef: "#1001",
  carrier: "UPS",
  serviceLevel: "Ground",
  currency: "USD",
  amount: "10.01",
  labelCount: 1,
  observedAt: new Date("2026-08-11T10:00:00Z"),
  sourceUpdatedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orderFindMany.mockResolvedValue([
    { id: "order_1", shopifyId: "gid://shopify/Order/123", orderNumber: 1001, currency: "USD" },
  ]);
  mocks.observationUpsert.mockResolvedValue({});
  mocks.observationFindMany.mockResolvedValue([
    { id: "obs_1", source: ShippingCostSource.SHIPSTATION, amount: "10.01", labelCount: 1, observedAt: observation.observedAt },
  ]);
  mocks.observationUpdateMany.mockResolvedValue({ count: 0 });
  mocks.fulfillmentFindMany.mockResolvedValue([
    { id: "ful_1", itemCount: 2 },
    { id: "ful_2", itemCount: 1 },
  ]);
  mocks.fulfillmentUpdate.mockResolvedValue({});
  mocks.recompute.mockResolvedValue({ ordersUpdated: 1 });
});

describe("shipping observation persistence", () => {
  it("matches a provider order, allocates exact cost, and recomputes profit", async () => {
    await expect(reconcileShippingObservations("shop_1", [observation])).resolves.toEqual({
      observations: 1,
      matched: 1,
      conflicts: 0,
      ordersUpdated: 1,
    });
    expect(mocks.observationUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ orderId: "order_1", status: ShippingObservationStatus.MATCHED }),
    }));
    expect(mocks.fulfillmentUpdate.mock.calls.map((call) => call[0].data.shippingCost)).toEqual([
      "6.67",
      "3.34",
    ]);
    expect(mocks.recompute).toHaveBeenCalledWith("shop_1");
  });

  it("removes stale measured cost when the replacement observation has a currency mismatch", async () => {
    mocks.observationFindMany.mockResolvedValue([]);
    await reconcileShippingObservations("shop_1", [{ ...observation, currency: "EUR" }]);
    expect(mocks.observationUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        status: ShippingObservationStatus.CURRENCY_MISMATCH,
        discrepancyReason: expect.stringContaining("does not match"),
      }),
    }));
    expect(mocks.fulfillmentUpdate.mock.calls.map((call) => call[0].data.shippingCost)).toEqual([
      "0.00",
      "0.00",
    ]);
    expect(mocks.recompute).toHaveBeenCalledWith("shop_1");
  });
});
