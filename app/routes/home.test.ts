import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("home resource route", () => {
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
    await expect(response.text()).resolves.toContain(
      "MyMeridian — see what your Shopify store actually keeps",
    );

    const second = await loader({
      request: new Request("https://mymeridian.example/"),
    } as never);
    await expect(second.text()).resolves.toContain("<!doctype html>");
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
