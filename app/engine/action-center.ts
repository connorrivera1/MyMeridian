import type { ChannelPerformance } from "./acquisition";
import type { CapacityAnalysis } from "./capacity";
import type { ProfitConfidence } from "./profit-confidence";
import type { PeriodProfit } from "./profit";
import type { ProductProfit } from "./products";
import { CHANNEL_LABELS } from "./types";

export type ActionSeverity = "CRITICAL" | "WARNING" | "OPPORTUNITY" | "DATA";
export type ActionConfidence = "High" | "Medium" | "Low";

export interface ActionRecommendation {
  key: string;
  severity: ActionSeverity;
  title: string;
  observedFact: string;
  likelyExplanation: string | null;
  suggestedAction: string;
  impactCents: number | null;
  impactLabel: string | null;
  confidence: ActionConfidence;
  evidence: string[];
  href: string;
  priority: number;
}

export interface ActionCenterInput {
  period: {
    orderCount: number;
    orders: readonly Pick<
      PeriodProfit["orders"][number],
      "contributionProfitCents" | "hasMissingCogs"
    >[];
  };
  products: readonly Pick<
    ProductProfit,
    | "productId"
    | "title"
    | "units"
    | "contributionProfitCents"
    | "hasMissingCogs"
    | "classification"
  >[];
  channels: readonly Pick<
    ChannelPerformance,
    | "channel"
    | "spendCents"
    | "netRevenueCents"
    | "contributionProfitCents"
    | "hasMissingCogs"
  >[];
  capacity: Pick<CapacityAnalysis, "alerts" | "hasData" | "forecast">;
  confidence: ProfitConfidence;
  /** Starter receives data-quality guidance; Growth unlocks decision analysis. */
  includeDecisionIntelligence?: boolean;
  range: string;
  dismissedKeys?: ReadonlySet<string>;
}

function impactBucket(cents: number): string {
  if (cents < 10_000) return "under-100";
  if (cents < 50_000) return "100-499";
  if (cents < 250_000) return "500-2499";
  if (cents < 1_000_000) return "2500-9999";
  return "10000-plus";
}

function actionKey(subject: string, impactCents: number | null = null): string {
  return impactCents === null ? subject : `${subject}:${impactBucket(impactCents)}`;
}

function priorityFor(severity: ActionSeverity, impactCents: number | null): number {
  const base: Record<ActionSeverity, number> = {
    CRITICAL: 400,
    WARNING: 300,
    OPPORTUNITY: 200,
    DATA: 100,
  };
  return base[severity] + Math.min(99, Math.floor(Math.abs(impactCents ?? 0) / 100_000));
}

function dedupeAndRank(
  actions: readonly ActionRecommendation[],
  dismissedKeys: ReadonlySet<string>,
): ActionRecommendation[] {
  const byKey = new Map<string, ActionRecommendation>();
  for (const action of actions) {
    if (dismissedKeys.has(action.key)) continue;
    const current = byKey.get(action.key);
    if (!current || action.priority > current.priority) byKey.set(action.key, action);
  }
  return [...byKey.values()]
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        Math.abs(right.impactCents ?? 0) - Math.abs(left.impactCents ?? 0) ||
        left.title.localeCompare(right.title),
    )
    .slice(0, 5);
}

/**
 * Builds only recommendations the current, aggregate analytical evidence can
 * support. The function deliberately has no AI or persistence dependency, so
 * its facts are repeatable and every card can expose its evidence.
 */
export function buildActionCenter(input: ActionCenterInput): ActionRecommendation[] {
  const actions: ActionRecommendation[] = [];
  const rangeQuery = `?range=${encodeURIComponent(input.range)}`;
  const includeDecisionIntelligence = input.includeDecisionIntelligence ?? true;

  const lossOrders = includeDecisionIntelligence ? input.period.orders.filter(
    (order) => order.contributionProfitCents < 0 && !order.hasMissingCogs,
  ) : [];
  const lossCents = Math.abs(
    lossOrders.reduce((sum, order) => sum + order.contributionProfitCents, 0),
  );
  if (lossOrders.length > 0 && lossCents > 0) {
    const productsWithLosses = input.products
      .filter((product) => product.contributionProfitCents < 0 && !product.hasMissingCogs)
      .sort((a, b) => a.contributionProfitCents - b.contributionProfitCents);
    const concentration = Math.abs(
      productsWithLosses.slice(0, 2).reduce((sum, product) => sum + product.contributionProfitCents, 0),
    );
    const share = lossCents > 0 ? Math.round((concentration / lossCents) * 100) : 0;
    const key = actionKey("loss-orders", lossCents);
    actions.push({
      key,
      severity: "CRITICAL",
      title: `${lossOrders.length.toLocaleString()} orders lost contribution`,
      observedFact: `${lossOrders.length.toLocaleString()} orders had negative contribution after the recorded costs, totaling ${formatCents(lossCents)} in losses.`,
      likelyExplanation:
        productsWithLosses.length > 0
          ? `${share}% of measured losses are concentrated in ${productsWithLosses.slice(0, 2).map((product) => product.title).join(" and ")}.`
          : null,
      suggestedAction: "Review the affected orders, then check COGS, price and shipping eligibility before changing a product or promotion.",
      impactCents: lossCents,
      impactLabel: "measured negative contribution",
      confidence: "High",
      evidence: [
        `${lossOrders.length.toLocaleString()} orders with recorded COGS`,
        "Contribution includes available order, shipping, fee and recorded ad costs",
      ],
      href: `/app/orders${rangeQuery}`,
      priority: priorityFor("CRITICAL", lossCents),
    });
  }

  const worstProduct = includeDecisionIntelligence ? input.products
    .filter(
      (product) =>
        product.contributionProfitCents < 0 &&
        !product.hasMissingCogs &&
        product.classification !== "STRATEGIC_LOSS_LEADER",
    )
    .sort((a, b) => a.contributionProfitCents - b.contributionProfitCents)[0] : undefined;
  if (worstProduct) {
    const loss = Math.abs(worstProduct.contributionProfitCents);
    actions.push({
      key: actionKey(`product-loss:${worstProduct.productId}`, loss),
      severity: "WARNING",
      title: `${worstProduct.title} is losing money`,
      observedFact: `${worstProduct.title} sold ${worstProduct.units.toLocaleString()} units and produced ${formatCents(loss)} of negative contribution.`,
      likelyExplanation: "This is a product-level result after the available recorded and configured costs; it is not a claim that one input caused the loss.",
      suggestedAction: "Review its COGS, selling price and fulfilment cost. Confirm whether it is intentionally being used as a loss leader.",
      impactCents: loss,
      impactLabel: "measured negative contribution",
      confidence: "High",
      evidence: [
        `${worstProduct.units.toLocaleString()} units sold`,
        "Product has complete COGS coverage for this result",
      ],
      href: `/app/products${rangeQuery}`,
      priority: priorityFor("WARNING", loss),
    });
  }

  const worstChannel = includeDecisionIntelligence ? input.channels
    .filter(
      (channel) =>
        channel.spendCents > 0 &&
        channel.contributionProfitCents < 0 &&
        !channel.hasMissingCogs,
    )
    .sort((a, b) => a.contributionProfitCents - b.contributionProfitCents)[0] : undefined;
  if (worstChannel) {
    const loss = Math.abs(worstChannel.contributionProfitCents);
    actions.push({
      key: actionKey(`channel-loss:${worstChannel.channel}`, loss),
      severity: "WARNING",
      title: `${CHANNEL_LABELS[worstChannel.channel]} has negative contribution`,
      observedFact: `${CHANNEL_LABELS[worstChannel.channel]} generated ${formatCents(worstChannel.netRevenueCents)} revenue and ${formatCents(loss)} negative contribution after synchronized spend.`,
      likelyExplanation: "Channel results use Shopify order attribution plus recorded advertising spend; attribution is not treated as proof of causation.",
      suggestedAction: "Review the campaigns and product mix in this channel before reducing spend or changing a profitability threshold.",
      impactCents: loss,
      impactLabel: "negative contribution after recorded spend",
      confidence: "High",
      evidence: ["Synchronized paid-marketing spend", "Orders with complete COGS"],
      href: `/app/acquisition${rangeQuery}`,
      priority: priorityFor("WARNING", loss),
    });
  }

  if (includeDecisionIntelligence && input.capacity.hasData) {
    const capacityAlert = input.capacity.alerts.find(
      (alert) => alert.severity === "CRITICAL" || alert.severity === "WARNING",
    );
    if (capacityAlert) {
      const peak = Math.max(
        0,
        ...input.capacity.forecast.map((day) => day.projectedBacklog),
      );
      actions.push({
        key: `capacity:${capacityAlert.id}`,
        severity: capacityAlert.severity === "CRITICAL" ? "CRITICAL" : "WARNING",
        title: capacityAlert.title,
        observedFact: capacityAlert.detail,
        likelyExplanation: "This is a projection from trailing observed fulfilment throughput and demand patterns, not a guaranteed future result.",
        suggestedAction: "Review fulfilment capacity, the shipping promise and any planned promotion before the projected breach.",
        impactCents: null,
        impactLabel: peak > 0 ? `${peak.toLocaleString()} projected backlog` : null,
        confidence: "Medium",
        evidence: ["Trailing observed fulfilment throughput", "14-day demand projection"],
        href: `/app/fulfilment${rangeQuery}`,
        priority: priorityFor(capacityAlert.severity === "CRITICAL" ? "CRITICAL" : "WARNING", null),
      });
    }
  }

  if (input.confidence.level !== "COMPLETE") {
    const missingLabels = input.confidence.missing.map((item) => item.label);
    const key = `data-confidence:${input.confidence.level}:${missingLabels.join("|")}`;
    actions.push({
      key,
      severity: "DATA",
      title: `Profit data is ${input.confidence.label.toLowerCase()}`,
      observedFact:
        missingLabels.length > 0
          ? `${missingLabels.join(" and ")} ${missingLabels.length === 1 ? "is" : "are"} unavailable for at least part of this result.`
          : "One or more configured estimates are included in this result.",
      likelyExplanation: "Meridian keeps unavailable inputs out of the calculation instead of treating them as zero.",
      suggestedAction: input.confidence.nextStep ?? "Review the inputs used in this profitability calculation.",
      impactCents: null,
      impactLabel: null,
      confidence: "High",
      evidence: [
        ...input.confidence.missing.map((item) => item.detail),
        ...input.confidence.configured.map((item) => `${item.label}: ${item.detail}`),
      ],
      href: `/app/settings${rangeQuery}`,
      priority: priorityFor("DATA", null),
    });
  }

  return dedupeAndRank(actions, input.dismissedKeys ?? new Set());
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
