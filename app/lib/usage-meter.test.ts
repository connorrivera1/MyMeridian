import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  shopFindUnique: vi.fn(),
  meterUpsert: vi.fn(),
  eventCreate: vi.fn(),
  meterUpdate: vi.fn(),
  meterUpdateMany: vi.fn(),
  meterFindUnique: vi.fn(),
  adminClientForShop: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    $transaction: mocks.transaction,
    usageMeter: {
      findUnique: mocks.meterFindUnique,
      update: mocks.meterUpdate,
      updateMany: mocks.meterUpdateMany,
    },
  },
}));

vi.mock("~/lib/shopify-catalog.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));

const {
  billSoftOrderOverage,
  meterPolicyForPlan,
  recordOrderUsage,
  usageMeterStatus,
} = await import("./usage-meter.server");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usage meter", () => {
  it("uses plan-specific soft thresholds and never hard-blocks overage", () => {
    expect(meterPolicyForPlan("starter")).toEqual({ softLimit: 1000, hardLimit: 1200 });
    expect(meterPolicyForPlan(null)).toEqual({ softLimit: 1000, hardLimit: 1200 });
    expect(meterPolicyForPlan("retired-plan")).toEqual({ softLimit: 1000, hardLimit: 1200 });
    expect(usageMeterStatus(1000, 1000, 1200)).toBe("under_limit");
    expect(usageMeterStatus(1001, 1000, 1200)).toBe("soft_overage");
    expect(usageMeterStatus(1200, 1000, 1200)).toBe("cap_reached");
  });

  it("rejects a usage event for an unknown shop before creating a meter", async () => {
    const tx = {
      shop: { findUnique: mocks.shopFindUnique },
      usageMeter: {
        upsert: mocks.meterUpsert,
        update: mocks.meterUpdate,
        updateMany: mocks.meterUpdateMany,
      },
      usageMeterEvent: { create: mocks.eventCreate },
    };
    mocks.transaction.mockImplementation((callback: (value: typeof tx) => unknown) => callback(tx));
    mocks.shopFindUnique.mockResolvedValue(null);

    await expect(recordOrderUsage("missing", "order:123")).rejects.toThrow(
      "Cannot meter usage for unknown shop missing",
    );
    expect(mocks.meterUpsert).not.toHaveBeenCalled();
  });

  it("counts an order once and marks the soft threshold crossing", async () => {
    const tx = {
      shop: { findUnique: mocks.shopFindUnique },
      usageMeter: {
        upsert: mocks.meterUpsert,
        update: mocks.meterUpdate,
        updateMany: mocks.meterUpdateMany,
      },
      usageMeterEvent: { create: mocks.eventCreate },
    };
    mocks.transaction.mockImplementation((callback: (value: typeof tx) => unknown) => callback(tx));
    mocks.shopFindUnique.mockResolvedValue({ planName: "starter", uninstalledAt: null });
    mocks.meterUpsert.mockResolvedValue({
      id: "meter_1",
      used: 1000,
      softLimit: 1000,
      hardLimit: 1200,
      status: "under_limit",
      overageNotifiedAt: null,
      capWarningNotifiedAt: null,
    });
    mocks.eventCreate.mockResolvedValue({ id: "event_1" });
    mocks.meterUpdate.mockResolvedValue({
      id: "meter_1",
      used: 1001,
      status: "soft_overage",
    });

    await expect(recordOrderUsage("shop_1", "order:123")).resolves.toEqual({
      counted: true,
      meterId: "meter_1",
      used: 1001,
      status: "soft_overage",
      crossedSoftLimit: true,
    });
    expect(mocks.eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ source: "order", sourceId: "order:123" }),
    });
    expect(mocks.meterUpdate).toHaveBeenCalledWith({
      where: { id: "meter_1" },
      data: { used: { increment: 1 } },
    });
    expect(mocks.meterUpdateMany).toHaveBeenCalledWith({
      where: { id: "meter_1", used: { gt: 1000, lt: 1200 } },
      data: expect.objectContaining({ status: "soft_overage" }),
    });
  });

  it("does not fail order processing when a legacy subscription has no usage line item", async () => {
    mocks.meterFindUnique.mockResolvedValue({
      id: "meter_1",
      used: 1101,
      softLimit: 1000,
      hardLimit: 1200,
      billedUnits: 0,
      status: "soft_overage",
      capWarningNotifiedAt: null,
    });
    const admin = {
      graphql: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { currentAppInstallation: { activeSubscriptions: [] } } })),
      ),
    };
    mocks.adminClientForShop.mockResolvedValue(admin);
    mocks.meterUpdateMany.mockResolvedValue({ count: 1 });

    await expect(billSoftOrderOverage("shop.myshopify.com", "meter_1")).resolves.toEqual({
      billedUnits: 0,
      skipped: true,
    });
    expect(mocks.meterUpdate).toHaveBeenCalledWith({
      where: { id: "meter_1" },
      data: expect.objectContaining({ billingAttempts: { increment: 1 } }),
    });
  });

  it("never attempts a Shopify usage charge for absent, suspended, or included usage", async () => {
    mocks.meterFindUnique.mockResolvedValueOnce(null);
    await expect(billSoftOrderOverage("shop.myshopify.com", "missing")).resolves.toEqual({
      billedUnits: 0,
      skipped: true,
    });

    mocks.meterFindUnique.mockResolvedValueOnce({
      id: "meter_suspended",
      status: "suspended",
      used: 9_999,
      softLimit: 1_000,
    });
    await expect(billSoftOrderOverage("shop.myshopify.com", "suspended")).resolves.toEqual({
      billedUnits: 0,
      skipped: true,
    });

    mocks.meterFindUnique.mockResolvedValueOnce({
      id: "meter_included",
      status: "under_limit",
      used: 1_000,
      softLimit: 1_000,
    });
    await expect(billSoftOrderOverage("shop.myshopify.com", "included")).resolves.toEqual({
      billedUnits: 0,
      skipped: true,
    });
    expect(mocks.adminClientForShop).not.toHaveBeenCalled();
  });

  it("treats a replayed source id as already counted", async () => {
    const tx = {
      shop: { findUnique: mocks.shopFindUnique },
      usageMeter: {
        upsert: mocks.meterUpsert,
        update: mocks.meterUpdate,
        updateMany: mocks.meterUpdateMany,
      },
      usageMeterEvent: { create: mocks.eventCreate },
    };
    mocks.transaction.mockImplementation((callback: (value: typeof tx) => unknown) => callback(tx));
    mocks.shopFindUnique.mockResolvedValue({ planName: "growth", uninstalledAt: null });
    mocks.meterUpsert.mockResolvedValue({
      id: "meter_1",
      used: 51,
      softLimit: 5_000,
      hardLimit: 6_000,
      status: "under_limit",
    });
    mocks.eventCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(recordOrderUsage("shop_1", "order:replayed")).resolves.toEqual({
      counted: false,
      meterId: "meter_1",
      used: 51,
      status: "under_limit",
      crossedSoftLimit: false,
    });
    expect(mocks.meterUpdate).not.toHaveBeenCalled();
  });

  it("sends a batched, idempotent Shopify usage record for soft overage", async () => {
    mocks.meterFindUnique.mockResolvedValue({
      id: "meter_1",
      used: 1101,
      softLimit: 1000,
      hardLimit: 1200,
      billedUnits: 0,
      status: "soft_overage",
      capWarningNotifiedAt: null,
    });
    const admin = {
      graphql: vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: {
                currentAppInstallation: {
                  activeSubscriptions: [
                    {
                      status: "ACTIVE",
                      lineItems: [
                        {
                          id: "gid://shopify/AppSubscriptionLineItem/1",
                          plan: {
                            pricingDetails: {
                              cappedAmount: { amount: "50.00", currencyCode: "USD" },
                              balanceUsed: { amount: "0.00", currencyCode: "USD" },
                            },
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: {
                appUsageRecordCreate: {
                  appUsageRecord: { id: "gid://shopify/AppUsageRecord/1" },
                  userErrors: [],
                },
              },
            }),
          ),
        ),
    };
    mocks.adminClientForShop.mockResolvedValue(admin);
    mocks.meterUpdateMany.mockResolvedValue({ count: 1 });
    mocks.meterUpdate.mockResolvedValue(undefined);

    await expect(billSoftOrderOverage("shop.myshopify.com", "meter_1")).resolves.toEqual({
      billedUnits: 100,
      skipped: false,
    });
    expect(admin.graphql).toHaveBeenCalledTimes(2);
    expect(admin.graphql.mock.calls[1]?.[1]).toEqual({
      variables: expect.objectContaining({
        price: { amount: 5, currencyCode: "USD" },
        subscriptionLineItemId: "gid://shopify/AppSubscriptionLineItem/1",
        idempotencyKey: "meridian:meter_1:100",
      }),
    });
    expect(mocks.meterUpdateMany).toHaveBeenCalledWith({
      where: { id: "meter_1", billedUnits: 0 },
      data: expect.objectContaining({
        billedUnits: { increment: 100 },
        lastUsageRecordId: "gid://shopify/AppUsageRecord/1",
      }),
    });
  });
});
