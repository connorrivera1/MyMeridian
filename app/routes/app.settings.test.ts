import { CostRuleKind, SyncStatus } from "@prisma/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireShopContext = vi.fn();
const requireActivePlan = vi.fn();
const planAllows = vi.fn(() => true);
const startBackfill = vi.fn();
const recomputeShopProfitability = vi.fn();
const prismaMock = {
  costRule: {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  connector: { findMany: vi.fn(async () => []) },
  order: { count: vi.fn(async () => 12_000) },
  product: { count: vi.fn(async () => 340) },
  shop: { findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
};

vi.mock("~/lib/auth.server", () => ({
  requireShopContext: (...args: unknown[]) => requireShopContext(...args),
}));
vi.mock("~/lib/plan.server", () => ({
  requireActivePlan: (...args: unknown[]) => requireActivePlan(...args),
  planAllows,
}));
vi.mock("~/lib/backfill.server", () => ({
  startBackfill: (...args: unknown[]) => startBackfill(...args),
}));
vi.mock("~/lib/recompute.server", () => ({
  recomputeShopProfitability: (...args: unknown[]) =>
    recomputeShopProfitability(...args),
}));
vi.mock("~/data/analytics.server", () => ({
  invalidateAnalyticsCache: vi.fn(),
}));
vi.mock("~/db.server", () => ({ default: prismaMock }));

const {
  action,
  BackfillButton,
  backfillControlFor,
  loader,
  ruleNeedsConfirmation,
} = await import("./app.settings");

const admin = { graphql: vi.fn() };
const context = {
  shop: { id: "shop_1", domain: "northwind.myshopify.com" },
  admin,
  isDemo: false,
};

function resyncRequest() {
  return new Request("https://meridian.example/app/settings", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "resync" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireShopContext.mockResolvedValue(context);
  requireActivePlan.mockResolvedValue({ planId: "growth" });
});

describe("Settings historical-import action", () => {
  it("reports a cursor resume after the server wins the stale claim", async () => {
    startBackfill.mockResolvedValue({ started: true, resumed: true });

    await expect(
      action({ request: resyncRequest() } as never),
    ).resolves.toEqual({
      ok: true,
      message:
        "Interrupted import resumed from its saved order-history checkpoint.",
    });
    expect(startBackfill).toHaveBeenCalledWith("shop_1", admin);
  });

  it("rejects a duplicate start on the server even if a stale page submitted", async () => {
    startBackfill.mockResolvedValue({ started: false, reason: "active" });

    await expect(
      action({ request: resyncRequest() } as never),
    ).resolves.toEqual({
      ok: false,
      message:
        "An import is already active. This request did not start another one.",
    });
  });
});

describe("Settings historical-import loader", () => {
  it("exposes a stale RUNNING cursor as recoverable authenticated state", async () => {
    requireShopContext.mockResolvedValue({
      ...context,
      shop: {
        ...context.shop,
        name: "Northwind",
        currency: "USD",
        timezone: "UTC",
        fulfillmentSlaDays: 2,
        lastComputedAt: null,
        isDemo: false,
        grantedScopes: "read_orders,read_products",
        syncStatus: SyncStatus.RUNNING,
        syncStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        syncCursor: "cursor_page_480",
        syncStage: "Importing order history",
        syncError: null,
        syncCompletedAt: null,
        earliestOrderAt: new Date("2024-01-01T00:00:00.000Z"),
        hasAllOrdersScope: true,
      },
    });

    const data = await loader({
      request: new Request("https://meridian.example/app/settings"),
    } as never);

    expect(data.sync).toMatchObject({
      status: SyncStatus.RUNNING,
      orders: 12_000,
      products: 340,
      isStale: true,
      hasResumeCursor: true,
    });
  });
});

describe("Settings historical-import controls", () => {
  it("enables stale RUNNING recovery and names the saved checkpoint", () => {
    expect(
      backfillControlFor({
        status: SyncStatus.RUNNING,
        isStale: true,
        hasResumeCursor: true,
      }),
    ).toEqual({
      buttonLabel: "Resume import",
      statusLabel: "Interrupted",
      disabled: false,
      recoveryCopy:
        "The previous import's server claim expired. Resume from its saved order-history checkpoint.",
    });
  });

  it("keeps a fresh RUNNING import disabled", () => {
    expect(
      backfillControlFor({
        status: SyncStatus.RUNNING,
        isStale: false,
        hasResumeCursor: true,
      }),
    ).toEqual({
      buttonLabel: "Importing…",
      statusLabel: "Importing",
      disabled: true,
      recoveryCopy: null,
    });
  });

  it("renders stale recovery enabled and a fresh duplicate disabled", () => {
    const stale = backfillControlFor({
      status: SyncStatus.RUNNING,
      isStale: true,
      hasResumeCursor: true,
    });
    const active = backfillControlFor({
      status: SyncStatus.RUNNING,
      isStale: false,
      hasResumeCursor: true,
    });

    const staleHtml = renderToStaticMarkup(
      createElement(BackfillButton, { control: stale, busy: false }),
    );
    const activeHtml = renderToStaticMarkup(
      createElement(BackfillButton, { control: active, busy: false }),
    );

    expect(staleHtml).toContain(">Resume import</button>");
    expect(staleHtml).not.toContain("disabled");
    expect(activeHtml).toContain(">Importing…</button>");
    expect(activeHtml).toContain("disabled");
  });
});

describe("Settings paid-route guard", () => {
  it("runs before the loader reads merchant data", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/app/plan" },
    });
    requireActivePlan.mockRejectedValue(redirect);

    await expect(
      loader({
        request: new Request("https://meridian.example/app/settings"),
      } as never),
    ).rejects.toBe(redirect);

    expect(prismaMock.costRule.findMany).not.toHaveBeenCalled();
    expect(prismaMock.connector.findMany).not.toHaveBeenCalled();
    expect(prismaMock.order.count).not.toHaveBeenCalled();
    expect(prismaMock.product.count).not.toHaveBeenCalled();
  });

  it("runs before the action parses or writes a cost rule", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/app/plan" },
    });
    requireActivePlan.mockRejectedValue(redirect);
    const request = new Request("https://meridian.example/app/settings", {
      method: "POST",
      body: new URLSearchParams({ id: "rule_1", fixedPerOrder: "9.25" }),
    });

    await expect(action({ request } as never)).rejects.toBe(redirect);
    expect(prismaMock.costRule.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.costRule.update).not.toHaveBeenCalled();
  });
});

describe("Settings cost confirmation", () => {
  it("keeps amber status until every applied install default is confirmed", () => {
    const base = {
      percentRate: null,
      fixedPerOrder: null,
      fixedPerItem: null,
      monthlyAmount: null,
      active: true,
      origin: "INSTALL_DEFAULT" as const,
      confirmedAt: null,
    };
    const installed = [
      { ...base, percentRate: 0.029, fixedPerOrder: 0.3 },
      { ...base, fixedPerOrder: 8.5 },
      { ...base, fixedPerOrder: 1.75, fixedPerItem: 0.35 },
      // Provisioned overhead is zero, so it has no numerical effect yet.
      { ...base, monthlyAmount: 0 },
    ];

    expect(installed.filter(ruleNeedsConfirmation)).toHaveLength(3);
    const partlyReviewed = installed.map((rule, index) =>
      index < 2
        ? { ...rule, confirmedAt: new Date("2026-08-10T00:00:00.000Z") }
        : rule,
    );
    expect(partlyReviewed.filter(ruleNeedsConfirmation)).toHaveLength(1);
    expect(
      partlyReviewed
        .map((rule) => ({
          ...rule,
          confirmedAt: new Date("2026-08-10T00:00:00.000Z"),
        }))
        .filter(ruleNeedsConfirmation),
    ).toHaveLength(0);
  });

  it("requires confirmation when monthly overhead becomes non-zero", () => {
    expect(
      ruleNeedsConfirmation({
        percentRate: null,
        fixedPerOrder: null,
        fixedPerItem: null,
        monthlyAmount: 100,
        active: true,
        origin: "INSTALL_DEFAULT",
        confirmedAt: null,
      }),
    ).toBe(true);
  });

  it("confirms only the active rule saved by this shop", async () => {
    prismaMock.costRule.findFirst.mockResolvedValue({
      id: "shipping_rule",
      kind: CostRuleKind.SHIPPING_DEFAULT,
    });
    prismaMock.costRule.update.mockResolvedValue({ id: "shipping_rule" });
    recomputeShopProfitability.mockResolvedValue({ ordersUpdated: 12 });
    const request = new Request("https://meridian.example/app/settings", {
      method: "POST",
      body: new URLSearchParams({
        id: "shipping_rule",
        fixedPerOrder: "9.25",
      }),
    });

    await expect(action({ request } as never)).resolves.toEqual({
      ok: true,
      message: "Saved. Reprofiled 12 orders.",
    });

    expect(prismaMock.costRule.findFirst).toHaveBeenCalledWith({
      where: { id: "shipping_rule", shopId: "shop_1", active: true },
    });
    const update = prismaMock.costRule.update.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(update.where).toEqual({ id: "shipping_rule" });
    expect(update.data.fixedPerOrder).toBe("9.2500");
    expect(update.data.confirmedAt).toBeInstanceOf(Date);
    expect(update.data).not.toHaveProperty("origin");
    expect(recomputeShopProfitability).toHaveBeenCalledWith("shop_1");
  });

  it("does not treat a bare rule id as confirmation", async () => {
    const request = new Request("https://meridian.example/app/settings", {
      method: "POST",
      body: new URLSearchParams({ id: "shipping_rule" }),
    });

    await expect(action({ request } as never)).resolves.toEqual({
      ok: false,
      message: "Those figures don't look right.",
    });
    expect(prismaMock.costRule.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.costRule.update).not.toHaveBeenCalled();
  });

  it("does not confirm a rule from an unrelated field", async () => {
    prismaMock.costRule.findFirst.mockResolvedValue({
      id: "payment_rule",
      kind: CostRuleKind.PAYMENT_FEE,
    });
    const request = new Request("https://meridian.example/app/settings", {
      method: "POST",
      body: new URLSearchParams({
        id: "payment_rule",
        monthlyAmount: "100",
      }),
    });

    await expect(action({ request } as never)).resolves.toEqual({
      ok: false,
      message: "That cost rule is missing a required figure.",
    });
    expect(prismaMock.costRule.update).not.toHaveBeenCalled();
  });
});
