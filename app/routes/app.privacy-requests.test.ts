import { beforeEach, describe, expect, it, vi } from "vitest";

const requireShopContext = vi.fn();
const listDataRequests = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  requireShopContext: (...args: unknown[]) => requireShopContext(...args),
  withShopContext: async (
    request: Request,
    work: (context: unknown) => unknown,
  ) => work(await requireShopContext(request)),
}));
vi.mock("~/lib/data-request.server", () => ({
  DATA_REQUEST_RETENTION_DAYS: 31,
  listDataRequests: (...args: unknown[]) => listDataRequests(...args),
}));

const { headers, loader } = await import("./app.privacy-requests");

const emptyRequests = {
  outstanding: [],
  history: [],
  historyPage: 1,
  historyPageCount: 1,
  collectedTotal: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireShopContext.mockResolvedValue({
    shop: { id: "shop_1", domain: "northwind.myshopify.com" },
  });
  listDataRequests.mockResolvedValue(emptyRequests);
});

describe("entitlement-exempt privacy request route", () => {
  it("forbids caching shopper request metadata", () => {
    expect(headers({} as never)).toMatchObject({
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    });
  });

  it("lists only the authenticated shop without resolving a plan or a report", async () => {
    const loaded = await loader({
      request: new Request(
        "https://meridian.example/app/privacy-requests?historyPage=2",
      ),
    } as never);

    expect(loaded).toEqual({ requests: emptyRequests, retentionDays: 31 });
    expect(JSON.stringify(loaded)).not.toContain('"report"');
    expect(listDataRequests).toHaveBeenCalledWith("shop_1", {
      historyPage: 2,
    });
  });

  it("normalizes a malformed history page before querying", async () => {
    await loader({
      request: new Request(
        "https://meridian.example/app/privacy-requests?historyPage=not-a-number",
      ),
    } as never);

    expect(listDataRequests).toHaveBeenCalledWith("shop_1", {
      historyPage: 1,
    });
  });
});
