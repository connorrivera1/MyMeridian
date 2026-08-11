import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The correction-ledger door: order-reference resolution, idempotent replay,
 * and the refusal to guess when an invoice line matches nothing.
 */

const invalidateAnalyticsCache = vi.fn();
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: (...args: unknown[]) =>
    invalidateAnalyticsCache(...args),
}));

const fxRate = vi.fn(async (..._args: unknown[]) => 1);
vi.mock("~/lib/fx.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("./fx.server")>();
  return {
    ...original,
    fxRate: (...args: unknown[]) => fxRate(...args),
  };
});

const orderFindUnique = vi.fn();
const orderFindFirst = vi.fn();
const fulfillmentFindFirst = vi.fn();
const adjustmentCreate = vi.fn();

class FakeUniqueViolation extends Error {
  code = "P2002";
}

vi.mock("~/db.server", () => ({
  default: {
    order: {
      findUnique: (...args: unknown[]) => orderFindUnique(...args),
      findFirst: (...args: unknown[]) => orderFindFirst(...args),
    },
    fulfillment: {
      findFirst: (...args: unknown[]) => fulfillmentFindFirst(...args),
    },
    shippingLabelAdjustment: {
      create: (...args: unknown[]) => adjustmentCreate(...args),
    },
  },
}));

// The module checks `instanceof Prisma.PrismaClientKnownRequestError`; give
// the fake violation that identity.
const { Prisma } = await import("@prisma/client");
Object.setPrototypeOf(
  FakeUniqueViolation.prototype,
  Prisma.PrismaClientKnownRequestError.prototype,
);

const { recordShippingAdjustments } = await import(
  "./shipping-adjustments.server"
);

const SHOP = "shop_1";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    reference: "inv-77-line-3",
    kind: "CARRIER_ADJUSTMENT",
    source: "CARRIER_INVOICE",
    amount: "4.20",
    orderReference: "#1042",
    occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  fxRate.mockResolvedValue(1);
  orderFindUnique.mockResolvedValue(null);
  orderFindFirst.mockResolvedValue({ id: "order_1" });
  fulfillmentFindFirst.mockResolvedValue(null);
  adjustmentCreate.mockResolvedValue({});
});

describe("recordShippingAdjustments", () => {
  it("resolves an order-number reference and writes the line", async () => {
    const result = await recordShippingAdjustments(SHOP, "USD", [entry()]);

    expect(result).toEqual({ written: 1, duplicates: 0, unmatched: [] });
    const data = adjustmentCreate.mock.calls[0]![0].data;
    expect(data.orderId).toBe("order_1");
    expect(String(data.amount)).toBe("4.2");
    expect(data.sourceCurrency).toBeNull();
    expect(invalidateAnalyticsCache).toHaveBeenCalledTimes(1);
  });

  it("resolves a Shopify order GID directly", async () => {
    orderFindUnique.mockResolvedValue({ id: "order_9" });
    await recordShippingAdjustments(SHOP, "USD", [
      entry({ orderReference: "gid://shopify/Order/999" }),
    ]);
    expect(orderFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          shopId_shopifyId: {
            shopId: SHOP,
            shopifyId: "gid://shopify/Order/999",
          },
        },
      }),
    );
    expect(adjustmentCreate.mock.calls[0]![0].data.orderId).toBe("order_9");
  });

  it("reports an unmatched reference instead of guessing an order", async () => {
    orderFindUnique.mockResolvedValue(null);
    orderFindFirst.mockResolvedValue(null);

    const result = await recordShippingAdjustments(SHOP, "USD", [
      entry({ reference: "inv-lost" }),
    ]);

    expect(result).toEqual({
      written: 0,
      duplicates: 0,
      unmatched: ["inv-lost"],
    });
    expect(adjustmentCreate).not.toHaveBeenCalled();
    expect(invalidateAnalyticsCache).not.toHaveBeenCalled();
  });

  it("counts a replayed line as a duplicate, not a failure", async () => {
    adjustmentCreate.mockRejectedValueOnce(new FakeUniqueViolation("dup"));

    const result = await recordShippingAdjustments(SHOP, "USD", [
      entry(),
      entry({ reference: "inv-77-line-4" }),
    ]);

    expect(result).toEqual({ written: 1, duplicates: 1, unmatched: [] });
  });

  it("converts a foreign-currency invoice line at the occurrence-day rate", async () => {
    fxRate.mockResolvedValue(1.25);

    await recordShippingAdjustments(SHOP, "USD", [
      entry({ amount: "10.00", currency: "GBP" }),
    ]);

    const data = adjustmentCreate.mock.calls[0]![0].data;
    expect(String(data.amount)).toBe("12.5");
    expect(data.sourceCurrency).toBe("GBP");
    expect(String(data.sourceAmount)).toBe("10");
    expect(fxRate).toHaveBeenCalledWith(
      new Date("2026-08-01T00:00:00.000Z"),
      "GBP",
      "USD",
    );
  });

  it("keeps a signed carrier credit signed", async () => {
    await recordShippingAdjustments(SHOP, "USD", [entry({ amount: "-3.40" })]);
    expect(String(adjustmentCreate.mock.calls[0]![0].data.amount)).toBe("-3.4");
  });

  it("rejects an unparseable amount as unmatched rather than writing zero", async () => {
    const result = await recordShippingAdjustments(SHOP, "USD", [
      entry({ reference: "inv-bad", amount: "n/a" }),
    ]);
    expect(result.unmatched).toEqual(["inv-bad"]);
    expect(adjustmentCreate).not.toHaveBeenCalled();
  });

  it("one bad line does not block the ninety-nine good ones", async () => {
    orderFindFirst
      .mockResolvedValueOnce(null) // first entry unmatched
      .mockResolvedValue({ id: "order_1" });
    orderFindUnique.mockResolvedValue(null);

    const result = await recordShippingAdjustments(SHOP, "USD", [
      entry({ reference: "inv-unmatched" }),
      entry({ reference: "inv-good" }),
    ]);

    expect(result).toEqual({
      written: 1,
      duplicates: 0,
      unmatched: ["inv-unmatched"],
    });
  });
});
