import { beforeEach, describe, expect, it, vi } from "vitest";

const variantFindMany = vi.fn();
const orderGroupBy = vi.fn();
const lineItemFindMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    variant: { findMany: (...args: unknown[]) => variantFindMany(...args) },
    order: { groupBy: (...args: unknown[]) => orderGroupBy(...args) },
    orderLineItem: {
      findMany: (...args: unknown[]) => lineItemFindMany(...args),
    },
  },
}));

const { loadPricingInputs } = await import("./queries.server");

const RANGE = {
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-08T00:00:00.000Z"),
};

function variant(priceHistory: Array<{ price: string; effectiveAt: Date }>) {
  return {
    id: "variant_1",
    title: "Default",
    price: "140.00",
    unitCost: "50.0000",
    product: { id: "product_1", title: "Observed jacket" },
    priceHistory,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  orderGroupBy.mockResolvedValue([]);
  lineItemFindMany.mockResolvedValue([]);
});

describe("loadPricingInputs observed price chronology", () => {
  it("omits pre-baseline days and never leaks a later price backward", async () => {
    variantFindMany.mockResolvedValue([
      variant([
        {
          price: "100.00",
          effectiveAt: new Date("2026-07-03T00:00:00.000Z"),
        },
        {
          price: "140.00",
          effectiveAt: new Date("2026-07-06T00:00:00.000Z"),
        },
      ]),
    ]);

    const [input] = await loadPricingInputs("shop_1", RANGE);
    if (!input) throw new Error("expected one pricing input");

    expect(
      input.observations.map((observation) => ({
        day: observation.date.toISOString().slice(0, 10),
        priceCents: observation.priceCents,
        units: observation.units,
      })),
    ).toEqual([
      { day: "2026-07-03", priceCents: 10_000, units: 0 },
      { day: "2026-07-04", priceCents: 10_000, units: 0 },
      { day: "2026-07-05", priceCents: 10_000, units: 0 },
      { day: "2026-07-06", priceCents: 14_000, units: 0 },
      { day: "2026-07-07", priceCents: 14_000, units: 0 },
    ]);
  });

  it("returns no observations when a legacy variant has no measured baseline", async () => {
    variantFindMany.mockResolvedValue([variant([])]);

    const [input] = await loadPricingInputs("shop_1", RANGE);
    if (!input) throw new Error("expected one pricing input");

    expect(input.currentPriceCents).toBe(14_000);
    expect(input.observations).toEqual([]);
  });
});
