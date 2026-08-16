import { beforeEach, describe, expect, it, vi } from "vitest";

const membershipUpsert = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    shopMembership: {
      upsert: (...a: unknown[]) => membershipUpsert(...a),
    },
  },
}));

const {
  clearPendingStoreCookie,
  completePendingLink,
  normalizeShopDomain,
  readPendingStore,
  serializePendingStoreCookie,
} = await import("./store-link.server");

beforeEach(() => {
  vi.clearAllMocks();
});

function withCookie(cookie?: string): Request {
  return new Request("https://mymeridian.app/app", {
    headers: cookie ? { cookie } : {},
  });
}

describe("shop domain normalisation", () => {
  it("accepts a bare handle and completes it", () => {
    expect(normalizeShopDomain("acme")).toBe("acme.myshopify.com");
  });

  it("accepts a full domain, a URL, and stray whitespace or case", () => {
    for (const input of [
      "acme.myshopify.com",
      "https://acme.myshopify.com",
      "https://acme.myshopify.com/admin",
      "  ACME.myshopify.com  ",
    ]) {
      expect(normalizeShopDomain(input), input).toBe("acme.myshopify.com");
    }
  });

  it("refuses anything that is not a myshopify store", () => {
    // The value is put straight into Shopify's install URL, so a host we did
    // not intend is a redirect to a host we did not intend.
    for (const hostile of [
      "",
      "   ",
      "evil.test",
      "acme.myshopify.com.evil.test",
      "acme.myshopify.co",
      "-acme.myshopify.com",
      "acme shop.myshopify.com",
    ]) {
      expect(normalizeShopDomain(hostile), hostile).toBeNull();
    }
  });
});

describe("pending-store cookie", () => {
  it("is HttpOnly, Lax and short-lived", () => {
    const cookie = serializePendingStoreCookie("acme.myshopify.com", true);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    // Long enough to walk Shopify's install screens, short enough that a
    // forgotten one does not linger.
    expect(cookie).toContain("Max-Age=600");
  });

  it("omits Secure where it cannot be honoured, and clears with Max-Age=0", () => {
    expect(serializePendingStoreCookie("a.myshopify.com", false)).not.toContain(
      "Secure",
    );
    expect(clearPendingStoreCookie(false)).toContain("Max-Age=0");
  });

  it("reads back what it wrote", () => {
    const cookie = serializePendingStoreCookie("acme.myshopify.com", false);
    const value = cookie.split(";")[0];

    expect(readPendingStore(withCookie(value))).toBe("acme.myshopify.com");
  });
});

/**
 * The link is the moment a web account gains access to a store's numbers, so
 * these are the cases that decide whether that access is sound.
 */
describe("completing a pending link", () => {
  const cookie = "mymeridian_pending_store=acme.myshopify.com";

  it("grants the membership when Shopify authenticated the same store", () => {
    // Both halves present: a signed-in web user, and a request Shopify itself
    // just authenticated for the store the cookie names.
    return completePendingLink(
      withCookie(cookie),
      "user-1",
      "acme.myshopify.com",
      "shop-1",
    ).then((granted) => {
      expect(granted).toBe(true);
      expect(membershipUpsert.mock.calls[0]?.[0].create).toEqual({
        userId: "user-1",
        shopId: "shop-1",
        role: "OWNER",
      });
    });
  });

  it("grants nothing without a signed-in web user", async () => {
    // The embedded app's normal case: a merchant with no web account at all.
    expect(
      await completePendingLink(withCookie(cookie), null, "acme.myshopify.com", "shop-1"),
    ).toBe(false);
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  it("grants nothing without a pending cookie", async () => {
    expect(
      await completePendingLink(withCookie(), "user-1", "acme.myshopify.com", "shop-1"),
    ).toBe(false);
    expect(membershipUpsert).not.toHaveBeenCalled();
  });

  /**
   * The case the cross-check exists for.
   *
   * The cookie is attacker-writable, so it must not be able to name a store
   * the request was not authenticated for. Forging it only means the forger
   * has to then authenticate as that store, which is the thing they cannot do.
   */
  it("grants nothing when the cookie names a different store", async () => {
    expect(
      await completePendingLink(
        withCookie("mymeridian_pending_store=victim.myshopify.com"),
        "user-1",
        "acme.myshopify.com",
        "shop-1",
      ),
    ).toBe(false);
    expect(membershipUpsert).not.toHaveBeenCalled();
  });
});
