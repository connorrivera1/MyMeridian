import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cost-timeline writes, without a database.
 *
 * The one behaviour worth pinning here is which cost gets published to the
 * catalog. `Variant.unitCost` is what every other screen reads, and the rule is
 * not "the cost you just saved" — it is "the cost in effect now". Get that
 * wrong and a correction to March silently undoes a change made in June, or a
 * cost scheduled for next quarter takes effect today.
 */

interface CostRow {
  variantId: string;
  unitCost: string;
  effectiveAt: Date;
  source: string;
}

let rows: CostRow[];
const variantUpdate = vi.fn();

vi.mock("@prisma/client", () => ({
  CostSource: {
    SHOPIFY: "SHOPIFY",
    MANUAL: "MANUAL",
    ESTIMATED: "ESTIMATED",
    BUNDLE_ROLLUP: "BUNDLE_ROLLUP",
  },
  Prisma: {
    Decimal: class {
      constructor(readonly value: string) {}
      toString() {
        return this.value;
      }
    },
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...v: unknown[]) => ({ strings, v }),
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    variantCost: {
      findMany: vi.fn(async ({ where }: any) =>
        rows
          .filter((row) =>
            where.variantId?.in
              ? where.variantId.in.includes(row.variantId)
              : true,
          )
          .filter((row) =>
            where.source?.not ? row.source !== where.source.not : true,
          )
          .sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime())
          .map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        const found = rows
          .filter(
            (row) =>
              row.variantId === where.variantId &&
              (!where.effectiveAt?.lte ||
                row.effectiveAt <= where.effectiveAt.lte),
          )
          .sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime());
        return found[0] ? { ...found[0] } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.variantId_effectiveAt;
        const existing = rows.find(
          (row) =>
            row.variantId === key.variantId &&
            row.effectiveAt.getTime() === key.effectiveAt.getTime(),
        );
        if (existing) {
          existing.unitCost = String(update.unitCost);
          existing.source = update.source ?? existing.source;
          return { ...existing };
        }
        rows.push({ ...create, unitCost: String(create.unitCost) });
        return create;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = rows.length;
        rows = rows.filter(
          (row) =>
            !(row.variantId === where.variantId && row.source === where.source),
        );
        return { count: before - rows.length };
      }),
      createMany: vi.fn(async ({ data }: any) => {
        for (const row of data) {
          const clash = rows.some(
            (existing) =>
              existing.variantId === row.variantId &&
              existing.effectiveAt.getTime() === row.effectiveAt.getTime(),
          );
          if (!clash) rows.push({ ...row, unitCost: String(row.unitCost) });
        }
        return { count: data.length };
      }),
    },
    variant: { update: (...a: unknown[]) => variantUpdate(...a) },
  },
}));

const {
  microsToDecimal,
  observeVariantCost,
  recordVariantCost,
  replaceDerivedCostTimeline,
} = await import("./cost-history.server");

const past = (iso: string) => new Date(iso);
const seed = (unitCost: string, iso: string, source = "SHOPIFY") =>
  rows.push({ variantId: "v1", unitCost, effectiveAt: past(iso), source });

beforeEach(() => {
  rows = [];
  variantUpdate.mockClear();
});

describe("microsToDecimal", () => {
  it("round-trips a four-decimal cost exactly", () => {
    expect(microsToDecimal(52_500)).toBe("5.2500");
    expect(microsToDecimal(1)).toBe("0.0001");
    expect(microsToDecimal(0)).toBe("0.0000");
    expect(microsToDecimal(123_456)).toBe("12.3456");
  });

  it("keeps a negative cost negative rather than losing the sign", () => {
    expect(microsToDecimal(-52_500)).toBe("-5.2500");
  });
});

describe("recordVariantCost", () => {
  const record = (unitCostMicros: number, iso: string) =>
    recordVariantCost({
      shopId: "shop_1",
      variantId: "v1",
      unitCostMicros,
      effectiveAt: past(iso),
      source: "MANUAL" as never,
    });

  it("publishes a cost effective now to the catalog", async () => {
    const result = await record(65_000, "2020-01-01T00:00:00Z");

    expect(result.changedCurrentCost).toBe(true);
    expect(variantUpdate.mock.calls[0]![0].data.unitCost.toString()).toBe(
      "6.5000",
    );
  });

  it("reports the instant a backdated correction starts to differ", async () => {
    seed("5.0000", "1970-01-01T00:00:00Z");

    const result = await record(52_500, "2026-02-01T00:00:00Z");

    expect(result.divergedFrom).toEqual(past("2026-02-01T00:00:00Z"));
  });

  it("reports no divergence when the cost was already in effect", async () => {
    seed("5.0000", "1970-01-01T00:00:00Z");

    const result = await record(50_000, "2026-02-01T00:00:00Z");

    expect(result.divergedFrom).toBeNull();
  });

  it("does not let a backdated correction overwrite a newer current cost", async () => {
    seed("5.0000", "1970-01-01T00:00:00Z");
    seed("9.0000", "2020-06-01T00:00:00Z");

    const result = await record(52_500, "2000-01-01T00:00:00Z");

    expect(result.changedCurrentCost).toBe(false);
    expect(variantUpdate).not.toHaveBeenCalled();
  });

  it("does not publish a cost that has not taken effect yet", async () => {
    seed("5.0000", "1970-01-01T00:00:00Z");

    const result = await record(99_000, "2099-01-01T00:00:00Z");

    expect(result.changedCurrentCost).toBe(false);
    expect(variantUpdate).not.toHaveBeenCalled();
  });

  it("overwrites rather than stacking a second cost at the same instant", async () => {
    await record(50_000, "2026-02-01T00:00:00Z");
    await record(60_000, "2026-02-01T00:00:00Z");

    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitCost).toBe("6.0000");
  });
});

describe("observeVariantCost", () => {
  const observe = (unitCostMicros: number, iso: string) =>
    observeVariantCost({
      shopId: "shop_1",
      variantId: "v1",
      unitCostMicros,
      effectiveAt: past(iso),
      source: "SHOPIFY" as never,
    });

  it("records a genuine change", async () => {
    expect(await observe(50_000, "2026-01-01T00:00:00Z")).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("writes nothing when the cost in effect is already this", async () => {
    seed("5.0000", "2026-01-01T00:00:00Z");

    expect(await observe(50_000, "2026-03-01T00:00:00Z")).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("never restates on its own — an observation is about the present", async () => {
    seed("5.0000", "1970-01-01T00:00:00Z");
    await observe(70_000, "2026-01-01T00:00:00Z");

    // No catalog publish, no divergence signal, nothing queued: the caller
    // decides, and for a webhook the answer is always "leave history alone".
    expect(variantUpdate).not.toHaveBeenCalled();
  });
});

describe("replaceDerivedCostTimeline", () => {
  it("replaces only the rows the rollup owns", async () => {
    seed("5.0000", "2026-01-01T00:00:00Z", "SHOPIFY");
    seed("15.0000", "2026-01-01T00:00:00Z", "BUNDLE_ROLLUP");

    await replaceDerivedCostTimeline("shop_1", "v1", [
      {
        unitCostMicros: 180_000,
        effectiveAt: past("2026-02-01T00:00:00Z"),
        source: "BUNDLE_ROLLUP",
      },
    ]);

    expect(rows.filter((row) => row.source === "SHOPIFY")).toHaveLength(1);
    const derived = rows.filter((row) => row.source === "BUNDLE_ROLLUP");
    expect(derived).toHaveLength(1);
    expect(derived[0]!.unitCost).toBe("18.0000");
  });

  it("clears the catalog cost when a mapping is withdrawn entirely", async () => {
    seed("15.0000", "2020-01-01T00:00:00Z", "BUNDLE_ROLLUP");

    await replaceDerivedCostTimeline("shop_1", "v1", []);

    // Leaving the last derived number in the catalog would keep asserting a
    // cost that nothing supports any more.
    expect(rows).toHaveLength(0);
    expect(variantUpdate.mock.calls[0]![0].data).toEqual({
      unitCost: null,
      costSource: "ESTIMATED",
    });
  });

  it("lets a directly observed cost win an instant a derivation also claims", async () => {
    seed("5.0000", "2026-01-01T00:00:00Z", "MANUAL");

    await replaceDerivedCostTimeline("shop_1", "v1", [
      {
        unitCostMicros: 150_000,
        effectiveAt: past("2026-01-01T00:00:00Z"),
        source: "BUNDLE_ROLLUP",
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("MANUAL");
  });
});
