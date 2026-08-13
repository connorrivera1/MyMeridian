import { describe, expect, it } from "vitest";

import { assessProfitConfidence } from "./profit-confidence";
import { ZERO_COST_RULES } from "./types";

const order = (overrides: Partial<{ hasMissingCogs: boolean; usesModeledCosts: boolean; shippingCostMeasured: boolean }> = {}) => ({
  hasMissingCogs: false,
  usesModeledCosts: false,
  shippingCostMeasured: true,
  ...overrides,
});

describe("assessProfitConfidence", () => {
  it("does not invent a confidence score where a period has no orders", () => {
    const confidence = assessProfitConfidence({
      orders: [],
      rules: ZERO_COST_RULES,
      adSpend: { mode: "unavailable", syncedSourceCount: 0 },
    });
    expect(confidence).toMatchObject({ level: "LIMITED", label: "Limited" });
    expect(confidence.missing[0]?.label).toBe("Shopify orders");
  });

  it("keeps missing COGS and disconnected paid marketing explicit", () => {
    const confidence = assessProfitConfidence({
      orders: [order(), order({ hasMissingCogs: true, shippingCostMeasured: false })],
      rules: ZERO_COST_RULES,
      adSpend: { mode: "unavailable", syncedSourceCount: 0 },
    });
    expect(confidence.level).toBe("PARTIAL");
    expect(confidence.missing.map((item) => item.label)).toEqual([
      "Product COGS",
      "Paid marketing spend",
    ]);
    expect(confidence.configured.some((item) => item.label === "Shipping costs")).toBe(true);
  });

  it("calls merchant rules configured estimates rather than measured values", () => {
    const confidence = assessProfitConfidence({
      orders: [order()],
      rules: {
        ...ZERO_COST_RULES,
        paymentPercentRate: 0.029,
        provenance: {
          ...ZERO_COST_RULES.provenance,
          paymentFee: { origin: "MERCHANT_CONFIGURED", confirmed: true },
        },
      },
      adSpend: { mode: "connected", syncedSourceCount: 2 },
    });
    expect(confidence).toMatchObject({ level: "STRONG" });
    expect(confidence.configured).toContainEqual({
      state: "CONFIGURED",
      label: "Payment processing",
      detail: "Merchant-confirmed estimate",
    });
  });

  it("only reports complete when every surfaced input is measured", () => {
    const confidence = assessProfitConfidence({
      orders: [order()],
      rules: ZERO_COST_RULES,
      adSpend: { mode: "connected", syncedSourceCount: 1 },
    });
    expect(confidence.level).toBe("COMPLETE");
    expect(confidence.missing).toEqual([]);
  });
});
