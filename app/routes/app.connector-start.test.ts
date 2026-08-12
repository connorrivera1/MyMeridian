import { beforeEach, describe, expect, it, vi } from "vitest";

const requireShopContext = vi.fn();
const requireActivePlan = vi.fn();
const planAllows = vi.fn();
const beginConnectorOAuth = vi.fn();
const firstDeniedRequestLimit = vi.fn();
const recordSensitiveAction = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  withShopContext: async (
    request: Request,
    work: (context: unknown) => unknown,
  ) => work(await requireShopContext(request)),
}));
vi.mock("~/lib/connector-oauth.server", () => ({
  connectorProviderForSlug: (slug: string) =>
    slug === "meta" ? "FACEBOOK_ADS" : null,
  beginConnectorOAuth: (...args: unknown[]) => beginConnectorOAuth(...args),
}));
vi.mock("~/lib/plan.server", () => ({
  requireActivePlan: (...args: unknown[]) => requireActivePlan(...args),
  planAllows: (...args: unknown[]) => planAllows(...args),
}));
vi.mock("~/lib/public-origin.server", () => ({
  publicAppOrigin: () => "https://meridian.example",
}));
vi.mock("~/lib/reauth.server", () => ({
  requireRecentReauthentication: vi.fn(),
}));
vi.mock("~/lib/rate-limit.server", () => ({
  firstDeniedRequestLimit: (...args: unknown[]) =>
    firstDeniedRequestLimit(...args),
  RATE_LIMIT_MESSAGE: "Too many requests. Wait a little while and try again.",
  rateLimitHeaders: () => ({ "retry-after": "60" }),
}));
vi.mock("~/lib/security-audit.server", () => ({
  recordSensitiveAction: (...args: unknown[]) => recordSensitiveAction(...args),
}));

const { action } = await import("./app.connector-start");

const request = () =>
  new Request("https://meridian.example/app/connections/meta/start", {
    method: "POST",
  });

beforeEach(() => {
  vi.clearAllMocks();
  requireShopContext.mockResolvedValue({
    shop: { id: "shop_1", domain: "northwind.myshopify.com" },
    user: { id: "user_1" },
    session: null,
  });
  requireActivePlan.mockResolvedValue({ planId: "growth" });
  planAllows.mockReturnValue(true);
  firstDeniedRequestLimit.mockResolvedValue(null);
  recordSensitiveAction.mockResolvedValue(undefined);
  beginConnectorOAuth.mockResolvedValue("https://provider.example/authorize");
});

describe("connector OAuth start", () => {
  it("rate limits and audit logs a successful authorization start", async () => {
    await expect(
      action({ request: request(), params: { provider: "meta" } } as never),
    ).rejects.toMatchObject({ status: 302 });

    expect(firstDeniedRequestLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "connector_oauth_start",
        subject: "user_1",
        subjectLimit: 3,
      }),
    );
    expect(recordSensitiveAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CONNECTOR_OAUTH_STARTED",
        resource: "connector:meta",
      }),
    );
  });

  it("returns a safe rate-limit response before creating OAuth state", async () => {
    firstDeniedRequestLimit.mockResolvedValue({ retryAfterSeconds: 60 });

    const result = await action({
      request: request(),
      params: { provider: "meta" },
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(429);
    expect(beginConnectorOAuth).not.toHaveBeenCalled();
    expect(recordSensitiveAction).not.toHaveBeenCalled();
  });
});
