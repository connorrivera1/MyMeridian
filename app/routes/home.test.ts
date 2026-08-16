import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inlineScriptHashes } from "~/lib/public-document-security.server";

const looksLikeShopifyRequest = vi.fn((_request: Request) => false);
const resolveWebUser = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  looksLikeShopifyRequest: (request: Request) =>
    looksLikeShopifyRequest(request),
  resolveWebUser: (...args: unknown[]) => resolveWebUser(...args),
}));
vi.mock("~/shopify.server", () => ({
  hasShopifyCredentials: true,
}));

const { loader } = await import("./home");

beforeEach(() => {
  vi.clearAllMocks();
  looksLikeShopifyRequest.mockReturnValue(false);
  resolveWebUser.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("home resource route", () => {
  it("redirects the www hostname to the canonical production origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SHOPIFY_APP_URL", "https://mymeridian.io");

    const response = await loader({
      request: new Request("https://www.mymeridian.io/?campaign=launch"),
    } as never);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://mymeridian.io/?campaign=launch",
    );
  });

  it("serves a fresh cache-revalidated marketing document to a visitor", async () => {
    const response = await loader({
      request: new Request("https://mymeridian.example/"),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const html = await response.text();
    expect(html).toContain(
      "MyMeridian — see what your Shopify store actually keeps",
    );
    expect(html).toContain("Join Waitlist");
    expect(html).not.toContain("Get Early Access");
    expect(html).toContain('action="/waitlist"');
    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain('href="/signup"');
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain(
      "'unsafe-inline'",
    );
    for (const hash of inlineScriptHashes(html)) {
      expect(policy).toContain(hash);
    }

    const second = await loader({
      request: new Request("https://mymeridian.example/"),
    } as never);
    await expect(second.text()).resolves.toContain("<!doctype html>");
  });

  it("gives concurrent visitors independent response bodies", async () => {
    const responses = await Promise.all(
      Array.from({ length: 32 }, () =>
        loader({
          request: new Request("https://mymeridian.example/"),
        } as never),
      ),
    );

    await expect(
      Promise.all(responses.map((response) => response.text())),
    ).resolves.toEqual(
      Array.from({ length: 32 }, () =>
        expect.stringContaining("<!doctype html>"),
      ),
    );
  });

  it("routes an embedded Shopify launch into the app before web-account lookup", async () => {
    looksLikeShopifyRequest.mockReturnValue(true);
    const request = new Request(
      "https://mymeridian.example/?shop=store.myshopify.com&host=c2hvcA",
    );

    let response: Response | null = null;
    try {
      await loader({ request } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "/app?shop=store.myshopify.com&host=c2hvcA",
    );
    expect(resolveWebUser).not.toHaveBeenCalled();
  });

  it("routes an existing web account to its dashboard", async () => {
    resolveWebUser.mockResolvedValue({ id: "user_1" });

    await expect(
      loader({
        request: new Request("https://mymeridian.example/"),
      } as never),
    ).rejects.toMatchObject({ status: 302 });
  });
});
