import { describe, expect, it } from "vitest";

import {
  bundlesAffectedBy,
  detectBundleCandidates,
  MAX_BUNDLE_DEPTH,
  resolveBundleCostTimelines,
  type BundleEdge,
} from "./bundles";
import { costEffectiveAt, type CostVersion } from "./cost-history";

const at = (iso: string) => new Date(iso);

function base(
  entries: Record<string, [iso: string, micros: number][]>,
): Map<string, CostVersion[]> {
  return new Map(
    Object.entries(entries).map(([variantId, versions]) => [
      variantId,
      versions.map(([iso, unitCostMicros]) => ({
        effectiveAt: at(iso),
        unitCostMicros,
        source: "SHOPIFY",
      })),
    ]),
  );
}

function edge(
  bundleVariantId: string,
  componentVariantId: string,
  quantity: number,
): BundleEdge {
  return { bundleVariantId, componentVariantId, quantity };
}

describe("resolveBundleCostTimelines", () => {
  it("costs a 3-pack as three singles", () => {
    const { timelines, problems } = resolveBundleCostTimelines(
      [edge("pack3", "single", 3)],
      base({ single: [["2026-01-01T00:00:00Z", 12_500]] }),
    );

    expect(problems).toEqual([]);
    expect(timelines.get("pack3")).toEqual([
      {
        unitCostMicros: 37_500,
        effectiveAt: at("2026-01-01T00:00:00Z"),
        source: "BUNDLE_ROLLUP",
      },
    ]);
  });

  it("sums several different components", () => {
    const { timelines } = resolveBundleCostTimelines(
      [edge("kit", "soap", 2), edge("kit", "cloth", 1)],
      base({
        soap: [["2026-01-01T00:00:00Z", 10_000]],
        cloth: [["2026-01-01T00:00:00Z", 3_250]],
      }),
    );

    expect(timelines.get("kit")![0]!.unitCostMicros).toBe(23_250);
  });

  it("moves the pack's cost on the day its component moved, not before", () => {
    const { timelines } = resolveBundleCostTimelines(
      [edge("pack3", "single", 3)],
      base({
        single: [
          ["2026-01-01T00:00:00Z", 10_000],
          ["2026-04-01T00:00:00Z", 11_000],
        ],
      }),
    );

    const derived = timelines.get("pack3")!;
    expect(derived).toHaveLength(2);
    expect(costEffectiveAt(derived, at("2026-03-31T23:59:59Z"))!.unitCostMicros).toBe(
      30_000,
    );
    expect(costEffectiveAt(derived, at("2026-04-01T00:00:00Z"))!.unitCostMicros).toBe(
      33_000,
    );
  });

  it("takes a breakpoint from each component independently", () => {
    const { timelines } = resolveBundleCostTimelines(
      [edge("kit", "soap", 1), edge("kit", "cloth", 1)],
      base({
        soap: [
          ["2026-01-01T00:00:00Z", 10_000],
          ["2026-03-01T00:00:00Z", 12_000],
        ],
        cloth: [
          ["2026-01-01T00:00:00Z", 5_000],
          ["2026-05-01T00:00:00Z", 6_000],
        ],
      }),
    );

    const derived = timelines.get("kit")!;
    expect(
      derived.map((v) => [v.effectiveAt.toISOString(), v.unitCostMicros]),
    ).toEqual([
      ["2026-01-01T00:00:00.000Z", 15_000],
      ["2026-03-01T00:00:00.000Z", 17_000],
      ["2026-05-01T00:00:00.000Z", 18_000],
    ]);
  });

  it("starts only where every component is priced", () => {
    // The kit existed in January but nobody costed the cloth until March.
    // Charging January for soap alone would understate the kit by the cloth.
    const { timelines } = resolveBundleCostTimelines(
      [edge("kit", "soap", 1), edge("kit", "cloth", 1)],
      base({
        soap: [["2026-01-01T00:00:00Z", 10_000]],
        cloth: [["2026-03-01T00:00:00Z", 5_000]],
      }),
    );

    const derived = timelines.get("kit")!;
    expect(derived[0]!.effectiveAt).toEqual(at("2026-03-01T00:00:00Z"));
    expect(costEffectiveAt(derived, at("2026-02-01T00:00:00Z"))).toBeNull();
  });

  it("resolves a pack of packs through both levels", () => {
    const { timelines, problems } = resolveBundleCostTimelines(
      [edge("case", "pack3", 4), edge("pack3", "single", 3)],
      base({ single: [["2026-01-01T00:00:00Z", 1_000]] }),
    );

    expect(problems).toEqual([]);
    expect(timelines.get("pack3")![0]!.unitCostMicros).toBe(3_000);
    expect(timelines.get("case")![0]!.unitCostMicros).toBe(12_000);
  });

  it("propagates a leaf change all the way up the nesting", () => {
    const { timelines } = resolveBundleCostTimelines(
      [edge("case", "pack3", 4), edge("pack3", "single", 3)],
      base({
        single: [
          ["2026-01-01T00:00:00Z", 1_000],
          ["2026-06-01T00:00:00Z", 1_100],
        ],
      }),
    );

    const caseTimeline = timelines.get("case")!;
    expect(costEffectiveAt(caseTimeline, at("2026-05-31T00:00:00Z"))!.unitCostMicros).toBe(
      12_000,
    );
    expect(costEffectiveAt(caseTimeline, at("2026-06-01T00:00:00Z"))!.unitCostMicros).toBe(
      13_200,
    );
  });

  it("overrides a bundle's own directly-supplied cost", () => {
    // Shopify carries a stale cost on the pack. The mapping exists precisely
    // because that number was the one that could not be trusted.
    const { timelines } = resolveBundleCostTimelines(
      [edge("pack3", "single", 3)],
      base({
        single: [["2026-01-01T00:00:00Z", 10_000]],
        pack3: [["2026-01-01T00:00:00Z", 25_000]],
      }),
    );

    expect(timelines.get("pack3")![0]!.unitCostMicros).toBe(30_000);
  });

  it("refuses a bundle whose component has no cost at all", () => {
    const { timelines, problems } = resolveBundleCostTimelines(
      [edge("pack3", "single", 3)],
      base({}),
    );

    expect(timelines.has("pack3")).toBe(false);
    expect(problems).toEqual([
      {
        bundleVariantId: "pack3",
        reason: "MISSING_COMPONENT_COST",
        detail: "Component single has no resolvable cost",
      },
    ]);
  });

  it("reports a direct cycle instead of overflowing", () => {
    const { timelines, problems } = resolveBundleCostTimelines(
      [edge("a", "b", 1), edge("b", "a", 1)],
      base({}),
    );

    expect(timelines.size).toBe(0);
    expect(problems.filter((p) => p.reason === "CYCLE")).toHaveLength(1);
    expect(problems.find((p) => p.reason === "CYCLE")!.bundleVariantId).toBe("a");
  });

  it("reports a cycle reached through several hops", () => {
    const { problems } = resolveBundleCostTimelines(
      [edge("a", "b", 1), edge("b", "c", 1), edge("c", "a", 1)],
      base({}),
    );

    expect(problems.some((p) => p.reason === "CYCLE")).toBe(true);
  });

  it("refuses a bundle that contains itself", () => {
    const { problems } = resolveBundleCostTimelines(
      [edge("a", "a", 2)],
      base({ a: [["2026-01-01T00:00:00Z", 100]] }),
    );

    expect(problems[0]!.reason).toBe("CYCLE");
  });

  it("refuses nesting beyond the depth bound", () => {
    const chain: BundleEdge[] = [];
    const levels = MAX_BUNDLE_DEPTH + 3;
    for (let i = 0; i < levels; i += 1) {
      chain.push(edge(`level${i}`, `level${i + 1}`, 2));
    }

    const { problems } = resolveBundleCostTimelines(
      chain,
      base({ [`level${levels}`]: [["2026-01-01T00:00:00Z", 1_000]] }),
    );

    expect(problems.some((p) => p.reason === "TOO_DEEP")).toBe(true);
  });

  it("rejects a non-positive quantity rather than discounting the bundle", () => {
    const { timelines, problems } = resolveBundleCostTimelines(
      [edge("pack3", "single", 0)],
      base({ single: [["2026-01-01T00:00:00Z", 10_000]] }),
    );

    expect(timelines.has("pack3")).toBe(false);
    expect(problems[0]!.reason).toBe("INVALID_QUANTITY");
  });

  it("resolves a diamond without double-counting the shared component", () => {
    // kit contains one 3-pack and one twin-pack; both are made of the single.
    const { timelines } = resolveBundleCostTimelines(
      [
        edge("kit", "pack3", 1),
        edge("kit", "pack2", 1),
        edge("pack3", "single", 3),
        edge("pack2", "single", 2),
      ],
      base({ single: [["2026-01-01T00:00:00Z", 1_000]] }),
    );

    expect(timelines.get("kit")![0]!.unitCostMicros).toBe(5_000);
  });

  it("leaves healthy bundles resolved when a different one is broken", () => {
    const { timelines, problems } = resolveBundleCostTimelines(
      [edge("good", "single", 2), edge("bad", "unpriced", 1)],
      base({ single: [["2026-01-01T00:00:00Z", 1_000]] }),
    );

    expect(timelines.get("good")![0]!.unitCostMicros).toBe(2_000);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.bundleVariantId).toBe("bad");
  });

  it("emits no version where the derived cost did not actually change", () => {
    // Two components move in opposite directions by the same amount.
    const { timelines } = resolveBundleCostTimelines(
      [edge("kit", "up", 1), edge("kit", "down", 1)],
      base({
        up: [
          ["2026-01-01T00:00:00Z", 5_000],
          ["2026-03-01T00:00:00Z", 6_000],
        ],
        down: [
          ["2026-01-01T00:00:00Z", 5_000],
          ["2026-03-01T00:00:00Z", 4_000],
        ],
      }),
    );

    expect(timelines.get("kit")).toHaveLength(1);
  });

  it("returns nothing for a catalog with no bundles", () => {
    const { timelines, problems } = resolveBundleCostTimelines([], base({}));
    expect(timelines.size).toBe(0);
    expect(problems).toEqual([]);
  });
});

describe("bundlesAffectedBy", () => {
  const edges = [
    edge("case", "pack3", 4),
    edge("pack3", "single", 3),
    edge("kit", "single", 1),
    edge("unrelated", "other", 1),
  ];

  it("walks upward through every level of nesting", () => {
    expect(bundlesAffectedBy(edges, ["single"]).sort()).toEqual([
      "case",
      "kit",
      "pack3",
    ]);
  });

  it("does not name bundles that contain nothing that changed", () => {
    expect(bundlesAffectedBy(edges, ["other"])).toEqual(["unrelated"]);
  });

  it("returns nothing for a variant in no bundle", () => {
    expect(bundlesAffectedBy(edges, ["standalone"])).toEqual([]);
  });

  it("terminates on a cyclic mapping", () => {
    expect(
      bundlesAffectedBy([edge("a", "b", 1), edge("b", "a", 1)], ["a"]).sort(),
    ).toEqual(["a", "b"]);
  });

  it("names each affected bundle once for a diamond", () => {
    const diamond = [
      edge("kit", "pack3", 1),
      edge("kit", "pack2", 1),
      edge("pack3", "single", 3),
      edge("pack2", "single", 2),
    ];

    expect(bundlesAffectedBy(diamond, ["single"]).sort()).toEqual([
      "kit",
      "pack2",
      "pack3",
    ]);
  });
});

describe("detectBundleCandidates", () => {
  const variant = (
    variantId: string,
    sku: string | null,
    title = "Default",
    productId = "p1",
  ) => ({ variantId, productId, sku, title });

  it("matches a -3PK suffix to its base SKU", () => {
    const found = detectBundleCandidates([
      variant("v-single", "WIDGET-BLU"),
      variant("v-pack", "WIDGET-BLU-3PK"),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      bundleVariantId: "v-pack",
      componentVariantId: "v-single",
      quantity: 3,
      source: "SKU_PATTERN",
    });
  });

  it("accepts the common suffix spellings", () => {
    const cases: [string, number][] = [
      ["WIDGET-3PACK", 3],
      ["WIDGET-6PK", 6],
      ["WIDGET_12CT", 12],
      ["WIDGET-X4", 4],
      ["WIDGET-4X", 4],
      ["WIDGET-PACK-OF-8", 8],
      ["WIDGET 2PCS", 2],
    ];

    for (const [sku, quantity] of cases) {
      const found = detectBundleCandidates([
        variant("v-single", "WIDGET"),
        variant("v-pack", sku),
      ]);
      expect(found, sku).toHaveLength(1);
      expect(found[0]!.quantity, sku).toBe(quantity);
    }
  });

  it("ignores a bare trailing number, which is usually a size", () => {
    const found = detectBundleCandidates([
      variant("v-single", "SHIRT"),
      variant("v-size", "SHIRT-3"),
    ]);

    expect(found).toEqual([]);
  });

  it("requires a separator so an embedded digit is not a pack count", () => {
    const found = detectBundleCandidates([
      variant("v-single", "WIDGET"),
      variant("v-other", "WIDGET3PK"),
    ]);

    expect(found).toEqual([]);
  });

  it("proposes nothing when the base SKU is not in the catalog", () => {
    expect(
      detectBundleCandidates([variant("v-pack", "GHOST-3PK")]),
    ).toEqual([]);
  });

  it("refuses to anchor on a SKU two variants share", () => {
    const found = detectBundleCandidates([
      variant("v-a", "WIDGET"),
      variant("v-b", "widget"),
      variant("v-pack", "WIDGET-3PK"),
    ]);

    expect(found).toEqual([]);
  });

  it("rejects a quantity of one", () => {
    expect(
      detectBundleCandidates([
        variant("v-single", "WIDGET"),
        variant("v-pack", "WIDGET-1PK"),
      ]),
    ).toEqual([]);
  });

  it("matches case-insensitively and tolerates a doubled separator", () => {
    const found = detectBundleCandidates([
      variant("v-single", "widget-blu"),
      variant("v-pack", "Widget-Blu--3pk"),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]!.quantity).toBe(3);
  });

  it("reads a multi-pack title against the single sibling of one product", () => {
    const found = detectBundleCandidates([
      variant("v-single", null, "Single", "p1"),
      variant("v-pack", null, "3-Pack", "p1"),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      bundleVariantId: "v-pack",
      componentVariantId: "v-single",
      quantity: 3,
      source: "TITLE_PATTERN",
    });
  });

  it("understands the written pack phrasings", () => {
    for (const [title, quantity] of [
      ["Pack of 4", 4],
      ["6 Pack", 6],
      ["Bundle of 10", 10],
      ["Twin Pack", 2],
      ["Triple Pack", 3],
      ["12-count", 12],
    ] as [string, number][]) {
      const found = detectBundleCandidates([
        variant("v-single", null, "Single", "p1"),
        variant("v-pack", null, title, "p1"),
      ]);
      expect(found, title).toHaveLength(1);
      expect(found[0]!.quantity, title).toBe(quantity);
    }
  });

  it("does not guess when a product has two non-pack variants", () => {
    const found = detectBundleCandidates([
      variant("v-single", null, "Single", "p1"),
      variant("v-refill", null, "Refill", "p1"),
      variant("v-pack", null, "3-Pack", "p1"),
    ]);

    expect(found).toEqual([]);
  });

  it("never crosses products on a title match alone", () => {
    const found = detectBundleCandidates([
      variant("v-single", null, "Single", "p1"),
      variant("v-pack", null, "3-Pack", "p2"),
    ]);

    expect(found).toEqual([]);
  });

  it("prefers the SKU signal over the title signal for one variant", () => {
    const found = detectBundleCandidates([
      variant("v-single", "WIDGET", "Single", "p1"),
      variant("v-pack", "WIDGET-6PK", "3-Pack", "p1"),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]!.quantity).toBe(6);
    expect(found[0]!.source).toBe("SKU_PATTERN");
  });

  it("never proposes a variant as its own component", () => {
    // A SKU that is its own base after the marker is stripped.
    expect(
      detectBundleCandidates([variant("v", "3PK", "3-Pack", "p1")]),
    ).toEqual([]);
  });

  it("proposes nothing for a catalog with no pack naming", () => {
    expect(
      detectBundleCandidates([
        variant("v1", "A", "Small"),
        variant("v2", "B", "Large"),
      ]),
    ).toEqual([]);
  });
});
