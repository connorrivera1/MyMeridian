import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  requireMerchantMutationAllowance,
  requireStandaloneMutationOrigin,
} from "./auth.server";

const firstDeniedRequestLimit = vi.fn();

vi.mock("./rate-limit.server", () => ({
  firstDeniedRequestLimit: (...args: unknown[]) =>
    firstDeniedRequestLimit(...args),
  RATE_LIMIT_MESSAGE: "Too many requests. Wait a little while and try again.",
  rateLimitHeaders: () => ({ "retry-after": "60" }),
}));

const webAccount = { user: { id: "user_1" } };

function request(method: string, headers: HeadersInit = {}) {
  return new Request("https://app.mymeridian.test/app/settings", {
    method,
    headers,
  });
}

describe("standalone merchant mutation origin boundary", () => {
  it("rejects a cookie-authenticated cross-site mutation", () => {
    expect(() =>
      requireStandaloneMutationOrigin(
        request("POST", { origin: "https://attacker.example" }),
        webAccount,
      ),
    ).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("accepts same-origin standalone mutations and safe reads", () => {
    expect(() =>
      requireStandaloneMutationOrigin(
        request("POST", { origin: "https://app.mymeridian.test" }),
        webAccount,
      ),
    ).not.toThrow();
    expect(() =>
      requireStandaloneMutationOrigin(request("GET"), webAccount),
    ).not.toThrow();
  });

  it("does not add a redundant cookie-origin rule to Shopify sessions", () => {
    expect(() =>
      requireStandaloneMutationOrigin(request("POST"), { user: null }),
    ).not.toThrow();
  });
});

describe("merchant mutation abuse boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firstDeniedRequestLimit.mockResolvedValue(null);
  });

  it("durably limits unsafe merchant mutations by their authenticated subject", async () => {
    await requireMerchantMutationAllowance(
      new Request("https://meridian.example/app/settings", { method: "POST" }),
      { shop: { id: "shop_1" }, user: { id: "user_1" } } as never,
    );

    expect(firstDeniedRequestLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "merchant_mutation",
        subject: "user_1",
        subjectLimit: 30,
      }),
    );
  });

  it("does not allocate buckets for safe reads and fails closed when limited", async () => {
    await requireMerchantMutationAllowance(
      new Request("https://meridian.example/app/settings"),
      { shop: { id: "shop_1" }, user: null } as never,
    );
    expect(firstDeniedRequestLimit).not.toHaveBeenCalled();

    firstDeniedRequestLimit.mockResolvedValue({ retryAfterSeconds: 60 });
    await expect(
      requireMerchantMutationAllowance(
        new Request("https://meridian.example/app/settings", { method: "POST" }),
        { shop: { id: "shop_1" }, user: null } as never,
      ),
    ).rejects.toMatchObject({ status: 429 });
  });
});
