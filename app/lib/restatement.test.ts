import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Restatement decisions that do not need a database.
 *
 * The integration suite proves the SQL against real Postgres. What is left here
 * is the coalescing logic behind the queue, which is subtle in exactly the way
 * that loses a merchant's correction: a burst of edits has to become one
 * restatement whose window and scope cover *all* of them, and it is very easy
 * to write a narrowing that silently drops the first edit's reach.
 */

const enqueueRecalcJob = vi.fn();
const recomputeShopProfitability = vi.fn();
const invalidateAnalyticsCache = vi.fn();
const jobFindUnique = vi.fn();
const shopFindUniqueOrThrow = vi.fn();
const snapshotFindMany = vi.fn();
const queryRaw = vi.fn();

vi.mock("~/lib/recalc-queue.server", () => ({
  enqueueRecalcJob: (...args: unknown[]) => enqueueRecalcJob(...args),
}));
vi.mock("~/lib/recompute.server", () => ({
  recomputeShopProfitability: (...args: unknown[]) =>
    recomputeShopProfitability(...args),
}));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: () => invalidateAnalyticsCache(),
}));
vi.mock("~/db.server", () => ({
  default: {
    recalcJob: { findUnique: (...a: unknown[]) => jobFindUnique(...a) },
    shop: {
      findUniqueOrThrow: (...a: unknown[]) => shopFindUniqueOrThrow(...a),
    },
    periodSnapshot: {
      findMany: (...a: unknown[]) => snapshotFindMany(...a),
      createMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 1 }),
      create: async () => ({}),
    },
    periodRestatement: { create: async () => ({}) },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

const { ClosedPeriodError, closePeriod, enqueueRestatement, restateCosts } =
  await import("./restatement.server");

beforeEach(() => {
  vi.clearAllMocks();
  jobFindUnique.mockResolvedValue(null);
  shopFindUniqueOrThrow.mockResolvedValue({
    id: "shop_1",
    timezone: "America/New_York",
  });
  snapshotFindMany.mockResolvedValue([]);
  queryRaw.mockResolvedValue([]);
});

const payloadOf = () => enqueueRecalcJob.mock.calls[0]![0].payload;

describe("enqueueRestatement", () => {
  it("queues one job carrying the window and scope", async () => {
    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-03-01T00:00:00Z"),
      variantIds: ["v1"],
      reason: "Freight",
    });

    expect(enqueueRecalcJob).toHaveBeenCalledOnce();
    expect(enqueueRecalcJob.mock.calls[0]![0].dedupeKey).toBe("restate:shop_1");
    expect(payloadOf()).toMatchObject({
      from: "2026-03-01T00:00:00.000Z",
      variantIds: ["v1"],
      reason: "Freight",
      includeClosedPeriods: false,
    });
  });

  it("widens a queued job's window backwards, never forwards", async () => {
    jobFindUnique.mockResolvedValue({
      status: "QUEUED",
      payload: {
        from: "2026-05-01T00:00:00.000Z",
        variantIds: ["v1"],
        reason: "Freight",
      },
    });

    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-02-01T00:00:00Z"),
      variantIds: ["v2"],
      reason: "Freight",
    });

    expect(payloadOf().from).toBe("2026-02-01T00:00:00.000Z");
  });

  it("keeps the queued window when the new edit reaches back less far", async () => {
    jobFindUnique.mockResolvedValue({
      status: "QUEUED",
      payload: {
        from: "2026-01-01T00:00:00.000Z",
        variantIds: ["v1"],
        reason: "Freight",
      },
    });

    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-06-01T00:00:00Z"),
      variantIds: ["v1"],
      reason: "Freight",
    });

    expect(payloadOf().from).toBe("2026-01-01T00:00:00.000Z");
  });

  it("unions the variant scope so neither edit loses its reach", async () => {
    jobFindUnique.mockResolvedValue({
      status: "QUEUED",
      payload: { from: "2026-05-01T00:00:00.000Z", variantIds: ["v1"], reason: "A" },
    });

    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-05-01T00:00:00Z"),
      variantIds: ["v2"],
      reason: "A",
    });

    expect(payloadOf().variantIds.sort()).toEqual(["v1", "v2"]);
  });

  it("cannot be narrowed by a later scoped edit once a job covers every variant", async () => {
    jobFindUnique.mockResolvedValue({
      status: "QUEUED",
      payload: { from: "2026-05-01T00:00:00.000Z", variantIds: null, reason: "A" },
    });

    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-05-01T00:00:00Z"),
      variantIds: ["v2"],
      reason: "A",
    });

    expect(payloadOf().variantIds).toBeNull();
  });

  it("widens a scoped job to every variant when the new edit is unscoped", async () => {
    jobFindUnique.mockResolvedValue({
      status: "QUEUED",
      payload: { from: "2026-05-01T00:00:00.000Z", variantIds: ["v1"], reason: "A" },
    });

    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-05-01T00:00:00Z"),
      variantIds: null,
      reason: "A",
    });

    expect(payloadOf().variantIds).toBeNull();
  });

  it("stops claiming one specific reason once several edits have merged", async () => {
    jobFindUnique.mockResolvedValue({
      status: "QUEUED",
      payload: {
        from: "2026-05-01T00:00:00.000Z",
        variantIds: ["v1"],
        reason: "Freight correction",
      },
    });

    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-05-01T00:00:00Z"),
      variantIds: ["v2"],
      reason: "Packaging correction",
    });

    expect(payloadOf().reason).toBe("Several cost changes");
  });

  it("does not merge into a job that has already read its inputs", async () => {
    jobFindUnique.mockResolvedValue({
      status: "RUNNING",
      payload: { from: "2026-01-01T00:00:00.000Z", variantIds: ["v1"], reason: "A" },
    });

    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-06-01T00:00:00Z"),
      variantIds: ["v2"],
      reason: "B",
    });

    // The running job cannot see this edit, so the new job carries only it.
    expect(payloadOf()).toMatchObject({
      from: "2026-06-01T00:00:00.000Z",
      variantIds: ["v2"],
      reason: "B",
    });
  });

  it("ignores a queued payload written by an older, incompatible deploy", async () => {
    jobFindUnique.mockResolvedValue({
      status: "QUEUED",
      payload: { somethingElse: true },
    });

    await enqueueRestatement({
      shopId: "shop_1",
      from: new Date("2026-06-01T00:00:00Z"),
      variantIds: ["v2"],
      reason: "B",
    });

    expect(payloadOf().from).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("restateCosts", () => {
  it("does nothing for a window that ends before it starts", async () => {
    const summary = await restateCosts({
      shopId: "shop_1",
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-01-01T00:00:00Z"),
      reason: "Backwards",
    });

    expect(summary.skipped).toBe(true);
    expect(recomputeShopProfitability).not.toHaveBeenCalled();
  });

  it("does nothing when the window resolves to no periods", async () => {
    queryRaw.mockResolvedValue([]);

    const summary = await restateCosts({
      shopId: "shop_1",
      from: new Date("2026-06-01T00:00:00Z"),
      reason: "Empty",
    });

    expect(summary.skipped).toBe(true);
  });

  it("refuses a closed period before recomputing anything", async () => {
    queryRaw.mockResolvedValue([
      {
        periodKey: "2026-03",
        from: new Date("2026-03-01T05:00:00Z"),
        toExclusive: new Date("2026-04-01T04:00:00Z"),
      },
    ]);
    snapshotFindMany.mockResolvedValue([{ periodKey: "2026-03" }]);

    await expect(
      restateCosts({
        shopId: "shop_1",
        from: new Date("2026-03-01T00:00:00Z"),
        reason: "Refused",
      }),
    ).rejects.toThrow(ClosedPeriodError);

    // A refusal that has already burned a full recompute is not a refusal.
    expect(recomputeShopProfitability).not.toHaveBeenCalled();
  });

  it("names the closed periods in the refusal", () => {
    const error = new ClosedPeriodError(["2026-01", "2026-02"]);
    expect(error.message).toContain("2026-01, 2026-02");
    expect(error.message).toContain("2 closed period");
  });
});

describe("closePeriod", () => {
  it("refuses anything that is not a YYYY-MM key", async () => {
    await expect(closePeriod("shop_1", "March")).rejects.toThrow(
      "not a YYYY-MM period key",
    );
    await expect(closePeriod("shop_1", "2026-3")).rejects.toThrow(
      "not a YYYY-MM period key",
    );
  });
});
