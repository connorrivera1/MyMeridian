import { Confidence, RecStatus } from "@prisma/client";

import prisma from "~/db.server";
import { loadStrategicProductIds } from "~/data/analytics.server";
import { loadPricingInputs } from "~/data/queries.server";
import { centsToDollars } from "~/engine/money";
import { recommendPrice } from "~/engine/pricing";

const LOOKBACK_DAYS = 180;

const CONFIDENCE_MAP = {
  HIGH: Confidence.HIGH,
  MEDIUM: Confidence.MEDIUM,
  LOW: Confidence.LOW,
} as const;

/**
 * Refresh the pending price recommendations for a shop.
 *
 * Recommendations the merchant has already applied or dismissed are left alone
 * — regenerating them would nag about a decision that was already made.
 */
export async function generatePricingRecommendations(
  shopId: string,
): Promise<number> {
  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 86_400_000);

  // Ask the profit engine which products are working loss leaders first, so the
  // pricing model can leave them alone instead of "fixing" the funnel.
  const strategicProductIds = await loadStrategicProductIds(shopId, { from, to });

  const inputs = await loadPricingInputs(shopId, { from, to }, { strategicProductIds });

  const actioned = await prisma.pricingRecommendation.findMany({
    where: { shopId, status: { not: RecStatus.PENDING } },
    select: { variantId: true },
  });
  const actionedVariantIds = new Set(actioned.map((r) => r.variantId));

  await prisma.pricingRecommendation.deleteMany({
    where: { shopId, status: RecStatus.PENDING },
  });

  const recommendations = inputs
    .filter((input) => !actionedVariantIds.has(input.variantId))
    .map(recommendPrice)
    // Nothing actionable to say, and no elasticity worth reporting.
    .filter(
      (rec) =>
        rec.method !== "INSUFFICIENT_DATA" ||
        rec.elasticity !== null,
    );

  if (recommendations.length === 0) return 0;

  await prisma.pricingRecommendation.createMany({
    data: recommendations.map((rec) => ({
      shopId,
      variantId: rec.variantId,
      currentPrice: centsToDollars(rec.currentPriceCents).toFixed(2),
      suggestedPrice: centsToDollars(rec.suggestedPriceCents).toFixed(2),
      expectedUnitsDeltaPct: rec.expectedUnitsDeltaPct.toFixed(4),
      expectedProfitDelta: centsToDollars(rec.expectedProfitDeltaCents).toFixed(2),
      elasticity: rec.elasticity !== null ? rec.elasticity.toFixed(4) : null,
      confidence: CONFIDENCE_MAP[rec.confidence],
      method: rec.method,
      rationale: rec.rationale,
      status: RecStatus.PENDING,
    })),
  });

  return recommendations.length;
}
