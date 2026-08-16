import { describe, expect, it, vi } from "vitest";

vi.mock("~/shopify.server", () => ({
  hasShopifyCredentials: true,
  authenticate: null,
}));
vi.mock("~/db.server", () => ({ default: {} }));

const { shouldLoadAppBridge } = await import("./auth.server");

describe("operator route isolation", () => {
  it("never loads Shopify App Bridge on operator pages", () => {
    expect(
      shouldLoadAppBridge(new Request("https://app.example.com/operator")),
    ).toBe(false);
    expect(
      shouldLoadAppBridge(
        new Request(
          "https://app.example.com/operator?shop=merchant.myshopify.com&host=c2hvcA",
        ),
      ),
    ).toBe(false);
    expect(
      shouldLoadAppBridge(
        new Request("https://app.example.com/operator/login", {
          headers: { authorization: "Bearer merchant-session-token" },
        }),
      ),
    ).toBe(false);
  });
});
