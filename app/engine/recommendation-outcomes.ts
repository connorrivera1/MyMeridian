export type RecommendationOutcomeStatus =
  | "NOT_TRACKED"
  | "AWAITING_PRICE_CHANGE"
  | "INSUFFICIENT_OBSERVATION"
  | "OBSERVED_AFTER_CHANGE";

export interface PricingOutcomeInput {
  acceptedAt: Date | null;
  observedPriceChangeAt: Date | null;
  observedDays: number;
  observedMonthlyProfitDeltaCents: number | null;
}

export interface PricingOutcome {
  status: RecommendationOutcomeStatus;
  label: string;
  detail: string;
}

export const MIN_PRICING_OUTCOME_DAYS = 28;

/** A later result may follow a price change, but is never presented as causal. */
export function assessPricingOutcome(input: PricingOutcomeInput): PricingOutcome {
  if (!input.acceptedAt) {
    return { status: "NOT_TRACKED", label: "Not tracked", detail: "This recommendation was not accepted." };
  }
  if (!input.observedPriceChangeAt) {
    return {
      status: "AWAITING_PRICE_CHANGE",
      label: "Waiting for price change",
      detail: "Set the approved price in Shopify first. Meridian never changes a price automatically.",
    };
  }
  if (input.observedDays < MIN_PRICING_OUTCOME_DAYS || input.observedMonthlyProfitDeltaCents === null) {
    return {
      status: "INSUFFICIENT_OBSERVATION",
      label: "Insufficient observation period",
      detail: `Meridian needs ${MIN_PRICING_OUTCOME_DAYS} days of observed post-change orders before comparing results.`,
    };
  }
  return {
    status: "OBSERVED_AFTER_CHANGE",
    label: "Observed after change",
    detail: "This is an observed comparison after the price change, not a causal claim.",
  };
}
