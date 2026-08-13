import type { CostRuleSet, OrderProfit } from "./types";

export type ProfitConfidenceLevel = "COMPLETE" | "STRONG" | "PARTIAL" | "LIMITED";
export type ProfitInputState = "MEASURED" | "CONFIGURED" | "MISSING";

export interface ProfitConfidenceReason {
  state: ProfitInputState;
  label: string;
  detail: string;
}

export interface ProfitConfidence {
  level: ProfitConfidenceLevel;
  label: "Complete" | "Strong" | "Partial" | "Limited";
  measured: ProfitConfidenceReason[];
  configured: ProfitConfidenceReason[];
  missing: ProfitConfidenceReason[];
  nextStep: string | null;
}

export interface ProfitConfidenceInput {
  orders: readonly Pick<
    OrderProfit,
    "hasMissingCogs" | "usesModeledCosts" | "shippingCostMeasured"
  >[];
  rules: CostRuleSet;
  adSpend: { mode: "connected" | "unavailable"; syncedSourceCount: number };
}

function reason(
  state: ProfitInputState,
  label: string,
  detail: string,
): ProfitConfidenceReason {
  return { state, label, detail };
}

function hasConfiguredValue(rules: CostRuleSet, key: keyof CostRuleSet): boolean {
  const value = rules[key];
  return typeof value === "number" && value !== 0;
}

function configuredDetail(
  rules: CostRuleSet,
  source: keyof CostRuleSet["provenance"],
): string {
  return rules.provenance[source]?.confirmed
    ? "Merchant-confirmed estimate"
    : "Configured estimate";
}

/**
 * Translate the accounting engine's provenance into merchant language. This is
 * intentionally categorical: a single percentage would imply that an unknown
 * cost is partly known. The reasons carry the defensible coverage counts.
 */
export function assessProfitConfidence(
  input: ProfitConfidenceInput,
): ProfitConfidence {
  const measured: ProfitConfidenceReason[] = [];
  const configured: ProfitConfidenceReason[] = [];
  const missing: ProfitConfidenceReason[] = [];
  const { orders, rules } = input;

  if (orders.length === 0) {
    missing.push(reason("MISSING", "Shopify orders", "No orders exist in this reporting period."));
    return {
      level: "LIMITED",
      label: "Limited",
      measured,
      configured,
      missing,
      nextStep: "Import Shopify orders or choose a period with order activity.",
    };
  }

  measured.push(
    reason("MEASURED", "Shopify orders", `${orders.length.toLocaleString()} orders in this reporting period.`),
  );

  const missingCogs = orders.filter((order) => order.hasMissingCogs).length;
  if (missingCogs === 0) {
    measured.push(reason("MEASURED", "Product COGS", "Every order has Shopify cost-of-goods data."));
  } else {
    missing.push(
      reason(
        "MISSING",
        "Product COGS",
        `${missingCogs.toLocaleString()} of ${orders.length.toLocaleString()} orders are missing at least one COGS input.`,
      ),
    );
  }

  const shippingKnown = orders.filter(
    (order) => typeof order.shippingCostMeasured === "boolean",
  );
  if (shippingKnown.length > 0) {
    const shippingMeasured = shippingKnown.filter(
      (order) => order.shippingCostMeasured,
    ).length;
    if (shippingMeasured > 0) {
      measured.push(
        reason(
          "MEASURED",
          "Shipping costs",
          `${shippingMeasured.toLocaleString()} of ${shippingKnown.length.toLocaleString()} orders use measured shipping cost.`,
        ),
      );
    }
    if (shippingMeasured < shippingKnown.length) {
      configured.push(
        reason(
          "CONFIGURED",
          "Shipping costs",
          `${(shippingKnown.length - shippingMeasured).toLocaleString()} orders use the shipping fallback.`,
        ),
      );
    }
  }

  const ruleInputs: Array<{
    label: string;
    value: boolean;
    source: keyof CostRuleSet["provenance"];
  }> = [
    {
      label: "Payment Processing",
      value:
        hasConfiguredValue(rules, "paymentPercentRate") ||
        hasConfiguredValue(rules, "paymentFixedPerOrderCents"),
      source: "paymentFee",
    },
    {
      label: "Shipping Fallback",
      value: hasConfiguredValue(rules, "shippingDefaultPerOrderCents"),
      source: "shippingDefault",
    },
    {
      label: "Pick & Pack",
      value:
        hasConfiguredValue(rules, "pickPackPerOrderCents") ||
        hasConfiguredValue(rules, "pickPackPerItemCents"),
      source: "pickPack",
    },
    {
      label: "Overhead Allocation",
      value: hasConfiguredValue(rules, "monthlyOverheadCents"),
      source: "monthlyOverhead",
    },
  ];
  for (const item of ruleInputs) {
    if (!item.value) continue;
    configured.push(
      reason("CONFIGURED", item.label, configuredDetail(rules, item.source)),
    );
  }

  if (input.adSpend.mode === "connected") {
    measured.push(
      reason(
        "MEASURED",
        "Paid marketing spend",
        `${input.adSpend.syncedSourceCount.toLocaleString()} synced paid-marketing ${input.adSpend.syncedSourceCount === 1 ? "source" : "sources"}.`,
      ),
    );
  } else {
    missing.push(
      reason(
        "MISSING",
        "Paid marketing spend",
        "No paid-marketing source has completed a sync. If this store runs ads, their cost is excluded.",
      ),
    );
  }

  const allCogsMissing = missingCogs === orders.length;
  const level: ProfitConfidenceLevel = allCogsMissing
    ? "LIMITED"
    : missingCogs > 0
      ? "PARTIAL"
      : missing.length > 0
        ? "PARTIAL"
        : configured.length > 0
          ? "STRONG"
          : "COMPLETE";
  const label =
    level === "COMPLETE"
      ? "Complete"
      : level === "STRONG"
        ? "Strong"
        : level === "PARTIAL"
          ? "Partial"
          : "Limited";
  const firstMissing = missing[0];
  const firstConfigured = configured[0];

  return {
    level,
    label,
    measured,
    configured,
    missing,
    nextStep: firstMissing
      ? firstMissing.label === "Paid marketing spend"
        ? "Connect the paid-marketing source you use to include its recorded spend."
        : "Add Shopify Cost per item to the affected variants; Meridian will not invent historical COGS."
      : firstConfigured
        ? `Review ${firstConfigured.label.toLowerCase()} if the configured estimate no longer reflects the business.`
        : null,
  };
}
