import { beforeEach, describe, expect, it, vi } from "vitest";

const shopUpdate = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    shop: { update: (...args: unknown[]) => shopUpdate(...args) },
  },
}));

const { refreshShopPlanSignal } = await import("./shop-plan.server");

function adminWith(body: unknown, status = 200) {
  return {
    graphql: vi.fn(async (query: string) => {
      expect(query).toContain("partnerDevelopment");
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  shopUpdate.mockResolvedValue(undefined);
});

describe("Shopify billing store type", () => {
  it("persists and returns ShopPlan.partnerDevelopment", async () => {
    const admin = adminWith({
      data: {
        shop: {
          plan: { displayName: "Development", partnerDevelopment: true },
        },
      },
    });

    await expect(refreshShopPlanSignal("shop-1", admin)).resolves.toBe(true);
    expect(shopUpdate).toHaveBeenCalledWith({
      where: { id: "shop-1" },
      data: { planName: "Development", partnerDevelopment: true },
    });
  });

  it("persists a development-to-paid transition as false", async () => {
    const admin = adminWith({
      data: {
        shop: {
          plan: { displayName: "Shopify", partnerDevelopment: false },
        },
      },
    });

    await expect(refreshShopPlanSignal("shop-1", admin)).resolves.toBe(false);
    expect(shopUpdate).toHaveBeenCalledWith({
      where: { id: "shop-1" },
      data: { planName: "Shopify", partnerDevelopment: false },
    });
  });

  it("fails closed when Shopify omits the durable signal", async () => {
    const admin = adminWith({
      data: { shop: { plan: { displayName: "Development" } } },
    });

    await expect(refreshShopPlanSignal("shop-1", admin)).rejects.toThrow(
      /omitted ShopPlan\.partnerDevelopment/,
    );
    expect(shopUpdate).not.toHaveBeenCalled();
  });

  it("fails closed on GraphQL errors", async () => {
    const admin = adminWith({ errors: [{ message: "access denied" }] });
    await expect(refreshShopPlanSignal("shop-1", admin)).rejects.toThrow(
      /access denied/,
    );
    expect(shopUpdate).not.toHaveBeenCalled();
  });
});
