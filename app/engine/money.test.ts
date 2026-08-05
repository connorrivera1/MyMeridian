import { describe, expect, it } from "vitest";

import {
  allocate,
  applyRate,
  costOfUnits,
  formatMoney,
  ratio,
  sumCents,
  toCents,
  toMicros,
} from "./money";

describe("toCents", () => {
  it("parses decimal strings without touching floating point", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(toCents("0.01")).toBe(1);
    expect(toCents("1000")).toBe(100_000);
    expect(toCents("-12.34")).toBe(-1234);
  });

  it("rounds half up at the third decimal", () => {
    expect(toCents("12.345")).toBe(1235);
    expect(toCents("12.344")).toBe(1234);
    expect(toCents("0.005")).toBe(1);
  });

  it("survives the classic float traps", () => {
    // 0.1 + 0.2 in cents must be exactly 30, not 30.000000000000004.
    expect(toCents("0.1") + toCents("0.2")).toBe(30);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents("1.005")).toBe(101);
  });

  it("treats missing values as zero rather than NaN", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
  });

  it("accepts Prisma Decimal-like objects", () => {
    expect(toCents({ toString: () => "45.67" })).toBe(4567);
  });
});

describe("toMicros", () => {
  it("keeps four decimal places of unit cost", () => {
    expect(toMicros("1.2345")).toBe(12_345);
    expect(toMicros("8.00")).toBe(80_000);
    expect(toMicros("0.0001")).toBe(1);
  });
});

describe("costOfUnits", () => {
  it("rounds once, after multiplying", () => {
    // $1.2345 x 10 = $12.345 -> $12.35, not 10 x $1.23 = $12.30.
    expect(costOfUnits(12_345, 10)).toBe(1235);
    expect(costOfUnits(80_000, 2)).toBe(1600);
    expect(costOfUnits(0, 5)).toBe(0);
  });
});

describe("applyRate", () => {
  it("applies a percentage and rounds to the cent", () => {
    expect(applyRate(9700, 0.029)).toBe(281);
    expect(applyRate(10_000, 0.029)).toBe(290);
    expect(applyRate(1234, 0)).toBe(0);
  });
});

describe("allocate", () => {
  it("always sums to exactly the input total", () => {
    const cases: Array<[number, number[]]> = [
      [1000, [1, 1, 1]],
      [100, [1, 1, 1, 1, 1, 1, 1]],
      [999, [5, 3, 1]],
      [1, [1, 1, 1, 1]],
      [123_456, [7, 11, 13, 17, 19]],
    ];

    for (const [total, weights] of cases) {
      const parts = allocate(total, weights);
      expect(sumCents(parts)).toBe(total);
      expect(parts).toHaveLength(weights.length);
    }
  });

  it("splits evenly when weights are equal", () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(900, [1, 1, 1])).toEqual([300, 300, 300]);
  });

  it("splits proportionally when weights differ", () => {
    expect(allocate(1000, [3, 1])).toEqual([750, 250]);
  });

  it("handles zero and negative totals without losing pennies", () => {
    expect(allocate(0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(sumCents(allocate(-1000, [1, 1, 1]))).toBe(-1000);
  });

  it("falls back to an even split when all weights are zero", () => {
    const parts = allocate(100, [0, 0, 0]);
    expect(sumCents(parts)).toBe(100);
  });

  it("returns an empty array for no recipients", () => {
    expect(allocate(500, [])).toEqual([]);
  });
});

describe("ratio", () => {
  it("returns null instead of Infinity or NaN", () => {
    expect(ratio(10, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(50, 200)).toBe(0.25);
  });
});

describe("formatMoney", () => {
  it("formats cents as currency", () => {
    expect(formatMoney(123_456)).toBe("$1,234.56");
    expect(formatMoney(-500)).toBe("-$5.00");
  });

  it("compacts large figures when asked", () => {
    expect(formatMoney(1_234_567, "USD", { compact: true })).toBe("$12.3K");
  });
});
