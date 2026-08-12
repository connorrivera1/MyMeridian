import { LoginErrorType } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const login = vi.fn();

vi.mock("~/lib/auth.server", () => ({ demoAvailable: false }));
vi.mock("~/shopify.server", () => ({
  hasShopifyCredentials: true,
  login: (...args: unknown[]) => login(...args),
}));

const { action, loader } = await import("./auth.login");

beforeEach(() => {
  vi.clearAllMocks();
  login.mockResolvedValue({});
});

describe("Shopify login route", () => {
  it("delegates the initial install request to Shopify's validated login flow", async () => {
    const request = new Request("https://mymeridian.example/auth/login");

    await expect(loader({ request } as never)).resolves.toEqual({
      errors: {},
      configured: true,
      demoAvailable: false,
    });
    expect(login).toHaveBeenCalledWith(request);
  });

  it("turns Shopify's missing-shop result into actionable merchant copy", async () => {
    login.mockResolvedValue({ shop: LoginErrorType.MissingShop });

    await expect(
      action({
        request: new Request("https://mymeridian.example/auth/login", {
          method: "POST",
        }),
      } as never),
    ).resolves.toEqual({
      errors: { shop: "Enter your store's myshopify.com domain." },
    });
  });

  it("does not echo Shopify's internal invalid-domain error", async () => {
    login.mockResolvedValue({ shop: LoginErrorType.InvalidShop });

    await expect(
      loader({
        request: new Request(
          "https://mymeridian.example/auth/login?shop=not-a-store",
        ),
      } as never),
    ).resolves.toMatchObject({
      errors: {
        shop: "That doesn't look like a valid myshopify.com domain.",
      },
    });
  });
});
