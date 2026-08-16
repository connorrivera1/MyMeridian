import { beforeEach, describe, expect, it, vi } from "vitest";

const requireShopContext = vi.fn();
const requireRecentReauthentication = vi.fn();
const requireActivePlan = vi.fn();
const planAllows = vi.fn();
const firstDeniedRequestLimit = vi.fn();
const recordSensitiveAction = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  withShopContext: async (
    request: Request,
    work: (context: unknown) => unknown,
  ) => work(await requireShopContext(request)),
}));
vi.mock("~/lib/reauth.server", () => ({
  requireRecentReauthentication: (...args: unknown[]) =>
    requireRecentReauthentication(...args),
}));
vi.mock("~/lib/plan.server", () => ({
  planAllows: (...args: unknown[]) => planAllows(...args),
  requireActivePlan: (...args: unknown[]) => requireActivePlan(...args),
}));
vi.mock("~/lib/rate-limit.server", () => ({
  firstDeniedRequestLimit: (...args: unknown[]) => firstDeniedRequestLimit(...args),
  RATE_LIMIT_MESSAGE: "Too many requests. Wait a little while and try again.",
  rateLimitHeaders: () => ({ "retry-after": "60", "cache-control": "no-store" }),
}));
vi.mock("~/lib/security-audit.server", () => ({
  recordSensitiveAction: (...args: unknown[]) => recordSensitiveAction(...args),
}));

const { loader } = await import("./app.profit-export");

beforeEach(() => {
  vi.clearAllMocks();
  requireShopContext.mockResolvedValue({
    shop: { id: "shop_1" },
    user: { id: "user_1" },
    session: null,
  });
  requireActivePlan.mockResolvedValue({ planId: "growth" });
  planAllows.mockReturnValue(true);
  firstDeniedRequestLimit.mockResolvedValue(null);
});

describe("profit export route", () => {
  it("rejects an oversized range before opening an export stream", async () => {
    const response = await loader({
      request: new Request(
        "https://app.mymeridian.test/app/profit-export?from=2020-01-01&to=2026-01-01",
      ),
    } as never);

    expect(response.status).toBe(400);
    expect(firstDeniedRequestLimit).not.toHaveBeenCalled();
    expect(recordSensitiveAction).not.toHaveBeenCalled();
  });

  it("rate-limits and audits an allowed export request", async () => {
    const response = await loader({
      request: new Request(
        "https://app.mymeridian.test/app/profit-export?from=2026-01-01&to=2026-01-31",
      ),
    } as never);

    expect(response.status).toBe(200);
    expect(firstDeniedRequestLimit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "profit_export", subject: "user_1" }),
    );
    expect(recordSensitiveAction).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop_1",
        action: "PROFIT_EXPORT_STARTED",
      }),
    );
  });

  it("returns a safe throttling response", async () => {
    firstDeniedRequestLimit.mockResolvedValue({});
    const response = await loader({
      request: new Request("https://app.mymeridian.test/app/profit-export"),
    } as never);

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("Too many requests");
    expect(recordSensitiveAction).not.toHaveBeenCalled();
  });
});
