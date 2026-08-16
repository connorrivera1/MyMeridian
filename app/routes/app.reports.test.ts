import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireActivePlan = vi.fn();
const count = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  withShopContext: async (
    _request: Request,
    work: (context: unknown) => unknown,
  ) =>
    work({
      shop: { id: "shop_1" },
      isDemo: false,
    }),
}));
vi.mock("~/lib/plan.server", () => ({
  requireActivePlan: (...args: unknown[]) => requireActivePlan(...args),
}));
vi.mock("~/db.server", () => ({
  default: { order: { count: (...args: unknown[]) => count(...args) } },
}));
vi.mock("~/data/analytics.server", () => ({
  resolveRange: () => ({
    from: new Date("2026-08-01T00:00:00.000Z"),
    to: new Date("2026-08-31T00:00:00.000Z"),
  }),
}));

const { ReportsView, loader } = await import("./app.reports");

beforeEach(() => {
  vi.clearAllMocks();
  requireActivePlan.mockResolvedValue({ planId: "starter" });
  count.mockResolvedValue(12);
});

describe("reports and exports", () => {
  it("offers the selected period's private order-profit CSV", async () => {
    const data = await loader({
      request: new Request("https://example.test/app/reports?range=30d"),
    } as never);

    expect(requireActivePlan).toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        processedAt: {
          gte: new Date("2026-08-01T00:00:00.000Z"),
          lte: new Date("2026-08-31T00:00:00.000Z"),
        },
      },
    });

    const html = renderToStaticMarkup(createElement(ReportsView, { data }));

    expect(html).toContain("Order Profitability Export");
    expect(html).toContain("12 orders");
    expect(html).toContain("Download CSV");
    expect(html).toContain("ad spend");
    expect(html).toContain("from=2026-08-01T00%3A00%3A00.000Z");
    expect(html).toContain("to=2026-08-31T00%3A00%3A00.000Z");
  });
});
