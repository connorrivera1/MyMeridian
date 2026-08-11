import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Costs surface, server-rendered.
 *
 * The page carries one claim that has to survive every future edit to it: that
 * saving a cost and restating history are visibly different acts. If that
 * wording or that separation ever quietly collapses into a single "Save"
 * button, a merchant will rewrite a quarter they had already reported without
 * ever being told that is what they were doing.
 */

const recordVariantCost = vi.fn();
const enqueueRestatement = vi.fn();
const closePeriod = vi.fn();
const reopenPeriod = vi.fn();
const confirmBundleComponent = vi.fn();
const removeBundleComponent = vi.fn();
const upsertBundleComponent = vi.fn();
const enqueueBundleDetection = vi.fn();
const variantFindFirst = vi.fn();

vi.mock("~/lib/cost-history.server", () => ({
  recordVariantCost: (...args: unknown[]) => recordVariantCost(...args),
}));
vi.mock("~/lib/restatement.server", () => ({
  enqueueRestatement: (...args: unknown[]) => enqueueRestatement(...args),
  closePeriod: (...args: unknown[]) => closePeriod(...args),
  reopenPeriod: (...args: unknown[]) => reopenPeriod(...args),
}));
vi.mock("~/lib/bundles.server", () => ({
  confirmBundleComponent: (...args: unknown[]) => confirmBundleComponent(...args),
  removeBundleComponent: (...args: unknown[]) => removeBundleComponent(...args),
  upsertBundleComponent: (...args: unknown[]) => upsertBundleComponent(...args),
  enqueueBundleDetection: (...args: unknown[]) => enqueueBundleDetection(...args),
}));
vi.mock("~/lib/auth.server", () => ({
  requireShopContext: async () => ({
    shop: { id: "shop_1", currency: "USD", timezone: "America/New_York" },
  }),
}));
vi.mock("~/lib/plan.server", () => ({
  requireActivePlan: async () => ({ planId: "growth", status: "active" }),
}));
vi.mock("~/db.server", () => ({
  default: {
    variant: {
      findMany: async () => [],
      count: async () => 0,
      findFirst: (...args: unknown[]) => variantFindFirst(...args),
    },
    bundleComponent: { findMany: async () => [] },
    periodSnapshot: { findMany: async () => [] },
    periodRestatement: { findMany: async () => [] },
    recalcJob: { findMany: async () => [] },
  },
}));

const { CostsView, action } = await import("./app.costs");

function data(overrides: Record<string, unknown> = {}) {
  return {
    currency: "USD",
    timezone: "America/New_York",
    variantCount: 2,
    variantsShown: 2,
    variants: [
      {
        id: "v1",
        label: "Widget — Single (WIDGET)",
        unitCost: "5.2500",
        costSource: "MANUAL",
        history: [
          {
            id: "c1",
            unitCost: "5.2500",
            effectiveAt: "2026-02-01T00:00:00.000Z",
            source: "MANUAL",
            note: "Corrected freight",
          },
        ],
      },
      {
        id: "v2",
        label: "Widget — 3-Pack (WIDGET-3PK)",
        unitCost: "15.7500",
        costSource: "BUNDLE_ROLLUP",
        history: [],
      },
    ],
    proposals: [
      {
        id: "b1",
        bundle: "Widget — 3-Pack (WIDGET-3PK)",
        component: "Widget — Single (WIDGET)",
        quantity: 3,
        source: "SKU_PATTERN",
        evidence: 'SKU "WIDGET-3PK" matches "WIDGET" ×3',
      },
    ],
    mappings: [],
    periods: [
      {
        periodKey: "2026-03",
        status: "CLOSED",
        orderCount: 42,
        netRevenue: "12500.00",
        cogs: "4200.00",
        netProfit: "3100.00",
        restatementCount: 1,
        capturedAt: "2026-04-01T00:00:00.000Z",
      },
    ],
    restatements: [
      {
        id: "r1",
        periodKey: "2026-03",
        reason: "Corrected Q1 freight",
        ordersAffected: 42,
        lineItemsAffected: 61,
        cogsBefore: "4200.00",
        cogsAfter: "4410.00",
        netProfitBefore: "3100.00",
        netProfitAfter: "2890.00",
        appliedAt: "2026-04-02T00:00:00.000Z",
      },
    ],
    jobs: [
      {
        id: "j1",
        kind: "COST_RESTATEMENT",
        status: "RUNNING",
        attempts: 1,
        error: null,
        createdAt: "2026-04-02T09:00:00.000Z",
        finishedAt: null,
      },
    ],
    ...overrides,
  };
}

function render(overrides: Record<string, unknown> = {}, result = null) {
  // Every control on this page is a `<Form>`, which needs a data router rather
  // than the plain MemoryRouter the read-only views are rendered under.
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () =>
        createElement(CostsView, {
          data: data(overrides) as never,
          result: result as never,
          busy: false,
        }),
    },
  ]);

  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/"] }));
}

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return { request: new Request("https://example.com/app/costs", { method: "POST", body }) } as never;
};

beforeEach(() => {
  vi.clearAllMocks();
  variantFindFirst.mockResolvedValue({ id: "v1" });
  recordVariantCost.mockResolvedValue({
    divergedFrom: null,
    changedCurrentCost: true,
  });
});

describe("Costs page", () => {
  it("says plainly that saving a cost does not move a reported figure", () => {
    const html = render();
    expect(html).toContain("does not");
    expect(html).toContain("already reported");
  });

  it("shows each variant's cost timeline with its source", () => {
    const html = render();
    expect(html).toContain("Widget — Single (WIDGET)");
    expect(html).toContain("2026-02-01");
    expect(html).toContain("Bundle rollup");
  });

  it("renders a four-decimal cost without rounding it away", () => {
    const html = render({
      variants: [
        {
          id: "v1",
          label: "Widget",
          unitCost: "1.2375",
          costSource: "MANUAL",
          history: [],
        },
      ],
    });
    expect(html).toContain("$1.2375");
  });

  it("shows a proposal with the evidence behind it, and does not present it as applied", () => {
    const html = render();
    expect(html).toContain("Proposed bundle");
    expect(html).toContain("matches &quot;WIDGET&quot; ×3");
    expect(html).toContain("Confirm");
  });

  it("labels a closed period and offers to reopen it", () => {
    const html = render();
    expect(html).toContain("Closed");
    expect(html).toContain("Reopen");
  });

  it("shows what a restatement did to a month, both sides", () => {
    const html = render();
    expect(html).toContain("Corrected Q1 freight");
    expect(html).toContain("$4,200");
    expect(html).toContain("$4,410");
  });

  it("tells the merchant when work is still running", () => {
    const html = render();
    expect(html).toContain("running in the background");
  });

  it("says nothing about background work when the queue is quiet", () => {
    const html = render({ jobs: [] });
    expect(html).not.toContain("running in the background");
  });

  it("offers an empty state rather than a bare table", () => {
    const html = render({ periods: [], restatements: [], variants: [] });
    expect(html).toContain("No month has been frozen yet");
    expect(html).toContain("No history has been restated");
  });

  it("renders every control in the app's own chrome", () => {
    const html = render();
    // Raw browser controls in a HUD read as a web form bolted on.
    expect(html).toContain('class="field-input"');
    expect(html).toContain('class="btn primary"');
    expect(html).not.toContain("settings-form");
  });
});

describe("Costs actions", () => {
  it("records a cost and says history has not moved", async () => {
    const result = (await action(
      form({
        intent: "save-cost",
        variantId: "v1",
        unitCost: "6.50",
        effectiveAt: "2026-06-01",
      }),
    )) as { ok: boolean; message: string };

    expect(result.ok).toBe(true);
    expect(recordVariantCost).toHaveBeenCalledOnce();
    expect(enqueueRestatement).not.toHaveBeenCalled();
  });

  it("tells the merchant when a saved cost reaches back, without acting on it", async () => {
    recordVariantCost.mockResolvedValue({
      divergedFrom: new Date("2026-01-15T00:00:00.000Z"),
      changedCurrentCost: false,
    });

    const result = (await action(
      form({
        intent: "save-cost",
        variantId: "v1",
        unitCost: "6.50",
        effectiveAt: "2026-01-15",
      }),
    )) as { ok: boolean; message: string };

    expect(result.message).toContain("2026-01-15");
    expect(result.message).toContain("Restate history");
    expect(enqueueRestatement).not.toHaveBeenCalled();
  });

  it("refuses a variant that belongs to another shop", async () => {
    variantFindFirst.mockResolvedValue(null);

    const result = (await action(
      form({
        intent: "save-cost",
        variantId: "someone-elses",
        unitCost: "6.50",
        effectiveAt: "2026-06-01",
      }),
    )) as { ok: boolean; message: string };

    expect(result.ok).toBe(false);
    expect(recordVariantCost).not.toHaveBeenCalled();
  });

  it("rejects a cost that is not a number", async () => {
    const result = (await action(
      form({
        intent: "save-cost",
        variantId: "v1",
        unitCost: "not money",
        effectiveAt: "2026-06-01",
      }),
    )) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(recordVariantCost).not.toHaveBeenCalled();
  });

  it("rejects an unparseable effective date", async () => {
    const result = (await action(
      form({
        intent: "save-cost",
        variantId: "v1",
        unitCost: "6.50",
        effectiveAt: "the fifth of never",
      }),
    )) as { ok: boolean; message: string };

    expect(result.ok).toBe(false);
    expect(result.message).toContain("real date");
  });

  it("queues a restatement only when explicitly asked", async () => {
    const result = (await action(
      form({ intent: "restate", from: "2026-03-01", reason: "Q1 freight" }),
    )) as { ok: boolean; message: string };

    expect(result.ok).toBe(true);
    expect(enqueueRestatement).toHaveBeenCalledOnce();
    expect(enqueueRestatement.mock.calls[0]![0]).toMatchObject({
      shopId: "shop_1",
      reason: "Q1 freight",
      includeClosedPeriods: false,
    });
  });

  it("passes the closed-period confirmation through when it is ticked", async () => {
    await action(
      form({
        intent: "restate",
        from: "2026-03-01",
        reason: "Q1",
        includeClosed: "on",
      }),
    );

    expect(enqueueRestatement.mock.calls[0]![0].includeClosedPeriods).toBe(true);
  });

  it("will not restate from a date it cannot read", async () => {
    const result = (await action(
      form({ intent: "restate", from: "", reason: "Q1" }),
    )) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(enqueueRestatement).not.toHaveBeenCalled();
  });

  it("confirms and removes bundle mappings", async () => {
    await action(form({ intent: "confirm-bundle", id: "b1" }));
    expect(confirmBundleComponent).toHaveBeenCalledWith("shop_1", "b1");

    await action(form({ intent: "remove-bundle", id: "b1" }));
    expect(removeBundleComponent).toHaveBeenCalledWith("shop_1", "b1");
  });

  it("rejects a manual mapping with a fractional quantity", async () => {
    const result = (await action(
      form({
        intent: "add-bundle",
        bundleVariantId: "v2",
        componentVariantId: "v1",
        quantity: "2.5",
      }),
    )) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(upsertBundleComponent).not.toHaveBeenCalled();
  });

  it("surfaces a refusal from the server rather than swallowing it", async () => {
    upsertBundleComponent.mockRejectedValue(
      new Error("A bundle cannot contain itself"),
    );

    const result = (await action(
      form({
        intent: "add-bundle",
        bundleVariantId: "v1",
        componentVariantId: "v1",
        quantity: "2",
      }),
    )) as { ok: boolean; message: string };

    expect(result.ok).toBe(false);
    expect(result.message).toBe("A bundle cannot contain itself");
  });

  it("closes and reopens a period", async () => {
    await action(form({ intent: "close-period", periodKey: "2026-03" }));
    expect(closePeriod).toHaveBeenCalledWith("shop_1", "2026-03");

    await action(form({ intent: "reopen-period", periodKey: "2026-03" }));
    expect(reopenPeriod).toHaveBeenCalledWith("shop_1", "2026-03");
  });

  it("queues catalog detection", async () => {
    await action(form({ intent: "detect-bundles" }));
    expect(enqueueBundleDetection).toHaveBeenCalledWith("shop_1");
  });

  it("does nothing for an intent it does not recognise", async () => {
    const result = (await action(form({ intent: "drop-tables" }))) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
  });
});
