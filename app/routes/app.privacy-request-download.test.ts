import { beforeEach, describe, expect, it, vi } from "vitest";

const requireShopContext = vi.fn();
const collectDataRequestForDownload = vi.fn();
const recordSensitiveAction = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  requireShopContext: (...args: unknown[]) => requireShopContext(...args),
}));
vi.mock("~/lib/data-request.server", () => ({
  collectDataRequestForDownload: (...args: unknown[]) =>
    collectDataRequestForDownload(...args),
}));
vi.mock("~/lib/security-audit.server", () => ({
  recordSensitiveAction: (...args: unknown[]) => recordSensitiveAction(...args),
}));

const { action, headers, loader } =
  await import("./app.privacy-request-download");

beforeEach(() => {
  vi.clearAllMocks();
  requireShopContext.mockResolvedValue({
    shop: { id: "shop_1", domain: "northwind.myshopify.com" },
  });
  collectDataRequestForDownload.mockResolvedValue({
    report: { customer: { email: "shopper@example.com" }, orders: [] },
    requestedAt: new Date("2026-08-05T12:00:00.000Z"),
  });
});

describe("customer data export download resource", () => {
  it("authenticates, scopes, and returns a no-store attachment", async () => {
    const request = new Request(
      "https://meridian.example/app/privacy-requests/request_1/download",
      { method: "POST" },
    );
    const response = await action({
      request,
      params: { id: "request_1" },
    } as never);

    expect(requireShopContext).toHaveBeenCalledWith(request);
    expect(collectDataRequestForDownload).toHaveBeenCalledWith(
      "shop_1",
      "request_1",
    );
    expect(recordSensitiveAction).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop_1",
        action: "CUSTOMER_EXPORT_DOWNLOADED",
        resource: "data_request:request_1",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="meridian-data-request-2026-08-05.json"',
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      customer: { email: "shopper@example.com" },
      orders: [],
    });
  });

  it("does not distinguish expired, removed, or cross-shop ids", async () => {
    collectDataRequestForDownload.mockResolvedValue(null);

    const thrown = await action({
      request: new Request(
        "https://meridian.example/app/privacy-requests/elsewhere/download",
        { method: "POST" },
      ),
      params: { id: "elsewhere" },
    } as never).catch((error) => error as Response);

    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(404);
    expect(thrown.headers.get("Cache-Control")).toContain("no-store");
  });

  it("publishes no-store headers through the route boundary", () => {
    expect(headers({} as never)).toMatchObject({
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    });
  });

  it("refuses side effects through GET", () => {
    const response = loader({
        request: new Request(
          "https://meridian.example/app/privacy-requests/request_1/download",
        ),
        params: { id: "request_1" },
      } as never);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});
