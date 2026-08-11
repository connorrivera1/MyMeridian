import { describe, expect, it } from "vitest";

import {
  costDivergenceFrom,
  costEffectiveAt,
  costSegments,
  normaliseCostTimeline,
  type CostVersion,
} from "./cost-history";

const at = (iso: string) => new Date(iso);

function version(
  iso: string,
  unitCostMicros: number,
  source = "MANUAL",
): CostVersion {
  return { effectiveAt: at(iso), unitCostMicros, source };
}

describe("normaliseCostTimeline", () => {
  it("sorts out-of-order versions ascending", () => {
    const timeline = normaliseCostTimeline([
      version("2026-03-01T00:00:00Z", 30_000),
      version("2026-01-01T00:00:00Z", 10_000),
      version("2026-02-01T00:00:00Z", 20_000),
    ]);

    expect(timeline.map((v) => v.unitCostMicros)).toEqual([
      10_000, 20_000, 30_000,
    ]);
  });

  it("collapses two versions at the same instant, last input winning", () => {
    const timeline = normaliseCostTimeline([
      version("2026-01-01T00:00:00Z", 10_000, "SHOPIFY"),
      version("2026-01-01T00:00:00Z", 12_500, "MANUAL"),
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.unitCostMicros).toBe(12_500);
    expect(timeline[0]!.source).toBe("MANUAL");
  });

  it("drops an unusable instant rather than treating it as the opening basis", () => {
    const timeline = normaliseCostTimeline([
      { effectiveAt: new Date("nonsense"), unitCostMicros: 999, source: "X" },
      version("2026-01-01T00:00:00Z", 10_000),
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.unitCostMicros).toBe(10_000);
  });
});

describe("costEffectiveAt", () => {
  const timeline = normaliseCostTimeline([
    version("2026-01-01T00:00:00Z", 10_000),
    version("2026-03-01T00:00:00Z", 12_000),
    version("2026-06-01T00:00:00Z", 9_500),
  ]);

  it("returns null before the timeline starts", () => {
    expect(costEffectiveAt(timeline, at("2025-12-31T23:59:59Z"))).toBeNull();
  });

  it("is inclusive of the effective instant itself", () => {
    expect(costEffectiveAt(timeline, at("2026-03-01T00:00:00Z"))?.unitCostMicros).toBe(
      12_000,
    );
  });

  it("holds a cost until the next version supersedes it", () => {
    expect(costEffectiveAt(timeline, at("2026-02-28T23:59:59Z"))?.unitCostMicros).toBe(
      10_000,
    );
    expect(costEffectiveAt(timeline, at("2026-05-31T23:59:59Z"))?.unitCostMicros).toBe(
      12_000,
    );
  });

  it("carries the last version forward indefinitely", () => {
    expect(costEffectiveAt(timeline, at("2030-01-01T00:00:00Z"))?.unitCostMicros).toBe(
      9_500,
    );
  });

  it("returns null for an empty timeline", () => {
    expect(costEffectiveAt([], at("2026-01-01T00:00:00Z"))).toBeNull();
  });

  it("agrees with a linear scan across a long timeline", () => {
    // Binary search is only worth having if it is right at every boundary, so
    // this checks it against the obvious implementation rather than spot values.
    const many = normaliseCostTimeline(
      Array.from({ length: 200 }, (_, i) =>
        version(
          new Date(Date.UTC(2020, 0, 1 + i * 3)).toISOString(),
          1_000 + i,
        ),
      ),
    );

    const linear = (target: Date) =>
      [...many]
        .reverse()
        .find((v) => v.effectiveAt.getTime() <= target.getTime()) ?? null;

    for (let day = 0; day < 620; day += 1) {
      const probe = new Date(Date.UTC(2019, 11, 25 + day));
      expect(costEffectiveAt(many, probe)?.unitCostMicros ?? null).toBe(
        linear(probe)?.unitCostMicros ?? null,
      );
    }
  });
});

describe("costDivergenceFrom", () => {
  it("returns null when nothing changed", () => {
    const timeline = [version("2026-01-01T00:00:00Z", 10_000)];
    expect(costDivergenceFrom(timeline, [...timeline])).toBeNull();
  });

  it("returns null when a re-observed version repeats the same cost", () => {
    const before = [version("2026-01-01T00:00:00Z", 10_000)];
    const after = [...before, version("2026-04-01T00:00:00Z", 10_000)];

    expect(costDivergenceFrom(before, after)).toBeNull();
  });

  it("finds the instant a forward-dated change begins", () => {
    const before = [version("2026-01-01T00:00:00Z", 10_000)];
    const after = [...before, version("2026-04-01T00:00:00Z", 11_000)];

    expect(costDivergenceFrom(before, after)).toEqual(at("2026-04-01T00:00:00Z"));
  });

  it("reaches back to the backdated instant, not to the edit", () => {
    // The merchant is correcting March from a supplier invoice they only
    // received in June. Restating from June would leave March wrong.
    const before = [version("2026-01-01T00:00:00Z", 10_000)];
    const after = [...before, version("2026-03-01T00:00:00Z", 13_000)];

    expect(costDivergenceFrom(before, after)).toEqual(at("2026-03-01T00:00:00Z"));
  });

  it("does not reach further back than the change itself", () => {
    const before = [
      version("2026-01-01T00:00:00Z", 10_000),
      version("2026-02-01T00:00:00Z", 10_500),
    ];
    const after = [
      version("2026-01-01T00:00:00Z", 10_000),
      version("2026-02-01T00:00:00Z", 10_500),
      version("2026-05-01T00:00:00Z", 14_000),
    ];

    expect(costDivergenceFrom(before, after)).toEqual(at("2026-05-01T00:00:00Z"));
  });

  it("treats a newly known cost as divergence from its first instant", () => {
    expect(
      costDivergenceFrom([], [version("2026-02-01T00:00:00Z", 8_000)]),
    ).toEqual(at("2026-02-01T00:00:00Z"));
  });

  it("treats a deleted version as divergence, even at an unchanged cost", () => {
    const before = [
      version("2026-01-01T00:00:00Z", 10_000),
      version("2026-03-01T00:00:00Z", 12_000),
    ];
    const after = [version("2026-01-01T00:00:00Z", 10_000)];

    expect(costDivergenceFrom(before, after)).toEqual(at("2026-03-01T00:00:00Z"));
  });

  it("finds the earliest divergence when several versions move at once", () => {
    const before = [
      version("2026-01-01T00:00:00Z", 10_000),
      version("2026-03-01T00:00:00Z", 12_000),
      version("2026-06-01T00:00:00Z", 9_500),
    ];
    const after = [
      version("2026-01-01T00:00:00Z", 10_000),
      version("2026-03-01T00:00:00Z", 12_400),
      version("2026-06-01T00:00:00Z", 9_900),
    ];

    expect(costDivergenceFrom(before, after)).toEqual(at("2026-03-01T00:00:00Z"));
  });
});

describe("costSegments", () => {
  it("closes each segment at the next change and leaves the last open", () => {
    const segments = costSegments([
      version("2026-01-01T00:00:00Z", 10_000, "SHOPIFY"),
      version("2026-03-01T00:00:00Z", 12_000, "MANUAL"),
    ]);

    expect(segments).toEqual([
      {
        unitCostMicros: 10_000,
        source: "SHOPIFY",
        from: at("2026-01-01T00:00:00Z"),
        toExclusive: at("2026-03-01T00:00:00Z"),
      },
      {
        unitCostMicros: 12_000,
        source: "MANUAL",
        from: at("2026-03-01T00:00:00Z"),
        toExclusive: null,
      },
    ]);
  });

  it("merges a re-observed identical cost instead of showing a phantom change", () => {
    const segments = costSegments([
      version("2026-01-01T00:00:00Z", 10_000),
      version("2026-02-01T00:00:00Z", 10_000),
      version("2026-03-01T00:00:00Z", 10_000),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]!.toExclusive).toBeNull();
  });

  it("returns nothing for an empty timeline", () => {
    expect(costSegments([])).toEqual([]);
  });
});
