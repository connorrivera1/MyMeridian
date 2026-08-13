import { describe, expect, it } from "vitest";

import { assessPricingOutcome } from "./recommendation-outcomes";

describe("assessPricingOutcome", () => {
  const acceptedAt = new Date("2026-08-01T00:00:00Z");

  it("does not invent an outcome before Shopify shows a price change", () => {
    expect(assessPricingOutcome({ acceptedAt, observedPriceChangeAt: null, observedDays: 0, observedMonthlyProfitDeltaCents: null })).toMatchObject({
      status: "AWAITING_PRICE_CHANGE", label: "Waiting for price change",
    });
  });

  it("requires a full observation period before comparing results", () => {
    expect(assessPricingOutcome({ acceptedAt, observedPriceChangeAt: acceptedAt, observedDays: 14, observedMonthlyProfitDeltaCents: 12_000 })).toMatchObject({
      status: "INSUFFICIENT_OBSERVATION",
    });
  });

  it("uses non-causal observed-after-change language", () => {
    const outcome = assessPricingOutcome({ acceptedAt, observedPriceChangeAt: acceptedAt, observedDays: 28, observedMonthlyProfitDeltaCents: 12_000 });
    expect(outcome).toMatchObject({ status: "OBSERVED_AFTER_CHANGE", label: "Observed after change" });
    expect(outcome.detail).toContain("not a causal claim");
  });
});
