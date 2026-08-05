import { describe, expect, it } from "vitest";

import { estimateElasticity, recommendPrice, type PriceObservation } from "./pricing";

/**
 * Build a history where demand follows Q = A·P^e exactly, so the regression has
 * a known right answer to recover.
 */
function syntheticHistory(
  points: Array<{ priceCents: number; unitsPerDay: number }>,
  daysEach = 30,
): PriceObservation[] {
  const observations: PriceObservation[] = [];
  let day = 0;

  for (const point of points) {
    for (let i = 0; i < daysEach; i++) {
      observations.push({
        date: new Date(2026, 0, 1 + day++),
        priceCents: point.priceCents,
        units: point.unitsPerDay,
      });
    }
  }

  return observations;
}

// Q = 4000·P^-2 : at $5 -> 160/day, at $10 -> 40/day, at $20 -> 10/day.
const ELASTIC_MINUS_TWO = syntheticHistory([
  { priceCents: 500, unitsPerDay: 160 },
  { priceCents: 1000, unitsPerDay: 40 },
  { priceCents: 2000, unitsPerDay: 10 },
]);

describe("estimateElasticity", () => {
  it("recovers a known elasticity from clean data", () => {
    const result = estimateElasticity(ELASTIC_MINUS_TWO);

    expect(result).not.toBeNull();
    expect(result!.value).toBeCloseTo(-2, 5);
    expect(result!.rSquared).toBeCloseTo(1, 5);
    expect(result!.pricePoints).toBe(3);
  });

  it("returns null when the price never moved", () => {
    const flat = syntheticHistory([{ priceCents: 1999, unitsPerDay: 12 }], 90);
    expect(estimateElasticity(flat)).toBeNull();
  });

  it("returns null with a single observation", () => {
    expect(
      estimateElasticity([
        { date: new Date(), priceCents: 1000, units: 5 },
      ]),
    ).toBeNull();
  });

  it("drops price points that sold nothing rather than smoothing them", () => {
    const withDeadPoint = [
      ...ELASTIC_MINUS_TWO,
      ...syntheticHistory([{ priceCents: 9999, unitsPerDay: 0 }], 10),
    ];

    const result = estimateElasticity(withDeadPoint);

    expect(result!.pricePoints).toBe(3);
    expect(result!.value).toBeCloseTo(-2, 5);
  });

  it("weights price points by how long the store held them", () => {
    const brief = syntheticHistory(
      [
        { priceCents: 500, unitsPerDay: 160 },
        { priceCents: 1000, unitsPerDay: 40 },
      ],
      1,
    );
    const sustained = syntheticHistory(
      [
        { priceCents: 500, unitsPerDay: 160 },
        { priceCents: 1000, unitsPerDay: 40 },
      ],
      60,
    );

    // Same slope, but the sustained history carries far more evidence.
    expect(estimateElasticity(brief)!.observationDays).toBe(2);
    expect(estimateElasticity(sustained)!.observationDays).toBe(120);
  });
});

describe("recommendPrice", () => {
  const base = {
    variantId: "var-1",
    productTitle: "Trail Runner",
    variantTitle: "Default",
    unitCostMicros: 20_000, // $2.00
  };

  it("solves for the profit-maximising price when demand is elastic", () => {
    const rec = recommendPrice({
      ...base,
      currentPriceCents: 500,
      observations: ELASTIC_MINUS_TWO,
    });

    // P* = c·e/(1+e) = 2.00 × -2 / -1 = $4.00, charm-rounded to $3.99.
    expect(rec.method).toBe("ELASTICITY_REGRESSION");
    expect(rec.confidence).toBe("HIGH");
    expect(rec.elasticity).toBeCloseTo(-2, 4);
    expect(rec.suggestedPriceCents).toBe(399);
    expect(rec.expectedUnitsDeltaPct).toBeGreaterThan(0);
  });

  it("caps any single move at 25%", () => {
    const rec = recommendPrice({
      ...base,
      currentPriceCents: 2000,
      observations: ELASTIC_MINUS_TWO,
    });

    // Unclamped optimum is $4.00; the guard rail holds it near $15.
    expect(Math.abs(rec.priceChangePct)).toBeLessThanOrEqual(0.26);
    expect(rec.suggestedPriceCents).toBe(1499);
  });

  it("never recommends a price below the minimum margin floor", () => {
    const rec = recommendPrice({
      ...base,
      unitCostMicros: 450_000, // $45.00 cost
      currentPriceCents: 5000,
      observations: syntheticHistory([
        { priceCents: 5000, unitsPerDay: 20 },
        { priceCents: 6000, unitsPerDay: 8 },
        { priceCents: 7000, unitsPerDay: 3 },
      ]),
    });

    const marginAtSuggestion =
      (rec.suggestedPriceCents - 4500) / rec.suggestedPriceCents;

    expect(marginAtSuggestion).toBeGreaterThanOrEqual(0.15);
  });

  it("says so rather than guessing when the price has never changed", () => {
    const rec = recommendPrice({
      ...base,
      unitCostMicros: 60_000, // $6.00 against a $19.99 price — margin is healthy
      currentPriceCents: 1999,
      observations: syntheticHistory([{ priceCents: 1999, unitsPerDay: 8 }], 90),
    });

    expect(rec.method).toBe("INSUFFICIENT_DATA");
    expect(rec.suggestedPriceCents).toBe(rec.currentPriceCents);
    expect(rec.expectedProfitDeltaCents).toBe(0);
    expect(rec.rationale).toMatch(/one price|no demand response/i);
  });

  it("falls back to a margin target when margin is thin and elasticity is unknown", () => {
    const rec = recommendPrice({
      ...base,
      unitCostMicros: 150_000, // $15.00 cost on a $19.99 price = 25% margin
      currentPriceCents: 1999,
      observations: syntheticHistory([{ priceCents: 1999, unitsPerDay: 8 }], 90),
    });

    expect(rec.method).toBe("MARGIN_TARGET");
    expect(rec.confidence).toBe("LOW");
    expect(rec.suggestedPriceCents).toBeGreaterThan(1999);
    // No elasticity means no honest volume projection.
    expect(rec.expectedUnitsDeltaPct).toBe(0);
    expect(rec.rationale).toMatch(/never changed price/i);
  });

  it("calls out a backwards fit instead of reading it as pricing headroom", () => {
    // Units rising with price — something other than price drove demand.
    const backwards = syntheticHistory([
      { priceCents: 1000, unitsPerDay: 10 },
      { priceCents: 1500, unitsPerDay: 20 },
      { priceCents: 2000, unitsPerDay: 30 },
    ]);

    const rec = recommendPrice({
      ...base,
      currentPriceCents: 2000,
      observations: backwards,
    });

    expect(rec.elasticity).toBeGreaterThan(0);
    expect(rec.method).toBe("INSUFFICIENT_DATA");
    expect(rec.suggestedPriceCents).toBe(rec.currentPriceCents);
    expect(rec.rationale).toMatch(/backwards/i);
    expect(rec.rationale).not.toMatch(/room to raise/i);
  });

  it("does not claim high confidence from a weak fit", () => {
    const noisy: PriceObservation[] = [
      ...syntheticHistory([{ priceCents: 1000, unitsPerDay: 10 }], 5),
      ...syntheticHistory([{ priceCents: 1200, unitsPerDay: 11 }], 5),
    ];

    const rec = recommendPrice({
      ...base,
      currentPriceCents: 1200,
      observations: noisy,
    });

    expect(rec.confidence).toBe("LOW");
    expect(rec.method).not.toBe("ELASTICITY_REGRESSION");
  });
});
