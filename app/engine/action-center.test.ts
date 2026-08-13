import { describe, expect, it } from "vitest";

import { buildActionCenter } from "./action-center";
import type { ActionCenterInput } from "./action-center";
import type { ProfitConfidence } from "./profit-confidence";

const complete: ProfitConfidence = {
  level: "COMPLETE", label: "Complete", measured: [], configured: [], missing: [], nextStep: null,
};
const base = (): ActionCenterInput => ({
  period: { orderCount: 3, orders: [
    { contributionProfitCents: -12_000, hasMissingCogs: false },
    { contributionProfitCents: 4_000, hasMissingCogs: false },
  ] },
  products: [{ productId: "bottle", title: "Water Bottle", units: 21, contributionProfitCents: -12_000, hasMissingCogs: false, classification: "BLEEDING" }],
  channels: [{ channel: "FACEBOOK", spendCents: 15_000, netRevenueCents: 10_000, contributionProfitCents: -9_000, hasMissingCogs: false }],
  capacity: { hasData: false, alerts: [], forecast: [] },
  confidence: complete,
  range: "30d",
});

describe("buildActionCenter", () => {
  it("prioritizes measured order losses above product and channel follow-ups", () => {
    const actions = buildActionCenter(base());
    expect(actions.map((action) => action.title)).toEqual([
      "1 Orders Lost Contribution",
      "Water Bottle Is Losing Money",
      "Facebook Ads Has Negative Contribution",
    ]);
    expect(actions[0]).toMatchObject({ severity: "CRITICAL", confidence: "High" });
  });

  it("does not recommend a product or channel when COGS evidence is missing", () => {
    const input = base();
    input.period.orders[0]!.hasMissingCogs = true;
    input.products[0]!.hasMissingCogs = true;
    input.channels[0]!.hasMissingCogs = true;
    const actions = buildActionCenter(input);
    expect(actions).toEqual([]);
  });

  it("keeps capacity forecasts explicitly projected and auditable", () => {
    const input = base();
    input.period.orders = [];
    input.products = [];
    input.channels = [];
    input.capacity = {
      hasData: true,
      alerts: [{ id: "backlog", severity: "CRITICAL", title: "Backlog exceeds promise", detail: "731 orders are waiting.", daysUntil: null }],
      forecast: [{ date: new Date(), projectedInbound: 200, projectedFulfilled: 100, projectedBacklog: 731, projectedShipDelayDays: 7.3, overCapacity: true }],
    };
    const [action] = buildActionCenter(input);
    expect(action?.likelyExplanation).toContain("projection");
    expect(action?.evidence).toContain("Trailing observed fulfilment throughput");
  });

  it("preserves a dismissal until the evidence crosses a material impact bucket", () => {
    const first = buildActionCenter(base())[0]!;
    const actions = buildActionCenter({ ...base(), dismissedKeys: new Set([first.key]) });
    expect(actions.some((action) => action.key === first.key)).toBe(false);
  });

  it("keeps Starter focused on data quality until decision intelligence is unlocked", () => {
    const input = base();
    input.confidence = {
      level: "PARTIAL", label: "Partial", measured: [], configured: [],
      missing: [{ label: "Paid spend", detail: "No source is connected.", state: "MISSING" }],
      nextStep: "Connect a paid-marketing source.",
    };
    const actions = buildActionCenter({ ...input, includeDecisionIntelligence: false });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.severity).toBe("DATA");
  });
});
