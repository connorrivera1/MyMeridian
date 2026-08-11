import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bundle persistence guards, without a database.
 *
 * These are the checks standing between a merchant's typo and a catalog whose
 * COGS derives from a mapping that cannot mean anything — a pack containing
 * itself, a component from another tenant, half a unit. The integration suite
 * proves the rollup arithmetic; this proves the refusals, which is the half
 * that never runs in CI otherwise.
 */

const variantFindMany = vi.fn();
const bundleCreateMany = vi.fn();
const bundleUpsert = vi.fn();
const bundleUpdateMany = vi.fn();
const bundleDeleteMany = vi.fn();
const enqueueRecalcJob = vi.fn();

vi.mock("~/lib/recalc-queue.server", () => ({
  enqueueRecalcJob: (...args: unknown[]) => enqueueRecalcJob(...args),
}));
vi.mock("~/lib/restatement.server", () => ({
  enqueueRestatement: vi.fn(),
}));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
}));
vi.mock("~/lib/cost-history.server", () => ({
  loadCostTimelines: vi.fn(),
  replaceDerivedCostTimeline: vi.fn(),
}));
vi.mock("~/db.server", () => ({
  default: {
    variant: { findMany: (...a: unknown[]) => variantFindMany(...a) },
    variantCost: { findMany: async () => [] },
    bundleComponent: {
      findMany: async () => [],
      createMany: (...a: unknown[]) => bundleCreateMany(...a),
      upsert: (...a: unknown[]) => bundleUpsert(...a),
      updateMany: (...a: unknown[]) => bundleUpdateMany(...a),
      deleteMany: (...a: unknown[]) => bundleDeleteMany(...a),
    },
  },
}));

const {
  confirmBundleComponent,
  detectBundlesForShop,
  removeBundleComponent,
  rollUpBundleCosts,
  upsertBundleComponent,
} = await import("./bundles.server");

beforeEach(() => {
  vi.clearAllMocks();
  variantFindMany.mockResolvedValue([]);
  bundleCreateMany.mockResolvedValue({ count: 0 });
  bundleUpdateMany.mockResolvedValue({ count: 1 });
  bundleDeleteMany.mockResolvedValue({ count: 1 });
});

describe("detectBundlesForShop", () => {
  it("writes proposals unconfirmed, tagged with the signal that found them", async () => {
    variantFindMany.mockResolvedValue([
      { id: "v1", productId: "p1", sku: "WIDGET", title: "Single" },
      { id: "v2", productId: "p1", sku: "WIDGET-3PK", title: "3-Pack" },
    ]);
    bundleCreateMany.mockResolvedValue({ count: 1 });

    const result = await detectBundlesForShop("shop_1");

    expect(result).toEqual({ scanned: 2, proposed: 1 });
    const written = bundleCreateMany.mock.calls[0]![0].data[0];
    expect(written).toMatchObject({
      shopId: "shop_1",
      bundleVariantId: "v2",
      componentVariantId: "v1",
      quantity: 3,
      source: "SKU_PATTERN",
    });
    // Absent `confirmedAt` — a proposal, not a fact.
    expect(written.confirmedAt).toBeUndefined();
  });

  it("leaves an already-reviewed mapping exactly as the merchant left it", async () => {
    variantFindMany.mockResolvedValue([
      { id: "v1", productId: "p1", sku: "WIDGET", title: "Single" },
      { id: "v2", productId: "p1", sku: "WIDGET-3PK", title: "3-Pack" },
    ]);
    bundleCreateMany.mockResolvedValue({ count: 0 });

    await detectBundlesForShop("shop_1");

    expect(bundleCreateMany.mock.calls[0]![0].skipDuplicates).toBe(true);
  });

  it("writes nothing when the catalog has no pack naming", async () => {
    variantFindMany.mockResolvedValue([
      { id: "v1", productId: "p1", sku: "A", title: "Small" },
    ]);

    const result = await detectBundlesForShop("shop_1");

    expect(result).toEqual({ scanned: 1, proposed: 0 });
    expect(bundleCreateMany).not.toHaveBeenCalled();
  });
});

describe("upsertBundleComponent", () => {
  const input = {
    shopId: "shop_1",
    bundleVariantId: "v2",
    componentVariantId: "v1",
    quantity: 3,
  };

  it("saves a merchant-drawn mapping already confirmed", async () => {
    variantFindMany.mockResolvedValue([{ id: "v1" }, { id: "v2" }]);

    await upsertBundleComponent(input);

    const call = bundleUpsert.mock.calls[0]![0];
    expect(call.create.source).toBe("MANUAL");
    // Drawing the mapping *is* the confirmation; asking someone to agree with
    // what they just typed is theatre.
    expect(call.create.confirmedAt).toBeInstanceOf(Date);
    expect(enqueueRecalcJob).toHaveBeenCalledOnce();
  });

  it("refuses a bundle that contains itself", async () => {
    await expect(
      upsertBundleComponent({ ...input, componentVariantId: "v2" }),
    ).rejects.toThrow("cannot contain itself");
    expect(bundleUpsert).not.toHaveBeenCalled();
  });

  it("refuses a fractional or absent quantity", async () => {
    await expect(
      upsertBundleComponent({ ...input, quantity: 2.5 }),
    ).rejects.toThrow("whole number");
    await expect(
      upsertBundleComponent({ ...input, quantity: 0 }),
    ).rejects.toThrow("whole number");
  });

  it("refuses a variant that is not this shop's", async () => {
    variantFindMany.mockResolvedValue([{ id: "v1" }]);

    await expect(upsertBundleComponent(input)).rejects.toThrow(
      "must belong to this shop",
    );
    expect(bundleUpsert).not.toHaveBeenCalled();
  });
});

describe("confirmBundleComponent", () => {
  it("confirms and re-derives", async () => {
    await confirmBundleComponent("shop_1", "edge_1");

    expect(bundleUpdateMany.mock.calls[0]![0].where).toEqual({
      id: "edge_1",
      shopId: "shop_1",
    });
    expect(enqueueRecalcJob).toHaveBeenCalledOnce();
  });

  it("refuses an id that is not this shop's", async () => {
    bundleUpdateMany.mockResolvedValue({ count: 0 });

    await expect(confirmBundleComponent("shop_1", "elsewhere")).rejects.toThrow(
      "no longer exists",
    );
    expect(enqueueRecalcJob).not.toHaveBeenCalled();
  });
});

describe("removeBundleComponent", () => {
  it("re-derives afterwards, so the withdrawn cost does not linger", async () => {
    await removeBundleComponent("shop_1", "edge_1");
    expect(enqueueRecalcJob).toHaveBeenCalledOnce();
  });

  it("queues nothing when there was no such mapping", async () => {
    bundleDeleteMany.mockResolvedValue({ count: 0 });

    await removeBundleComponent("shop_1", "gone");
    expect(enqueueRecalcJob).not.toHaveBeenCalled();
  });
});

describe("rollUpBundleCosts", () => {
  it("does no work for a shop with no mappings and no derived costs", async () => {
    const result = await rollUpBundleCosts("shop_1");

    expect(result).toEqual({
      bundles: 0,
      resolved: 0,
      problems: [],
      divergedFrom: null,
    });
  });
});
