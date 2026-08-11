import { beforeEach, describe, expect, it, vi } from "vitest";

const membershipFindMany = vi.fn();
const membershipUpsert = vi.fn();
const membershipDeleteMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    shopMembership: {
      findMany: (...a: unknown[]) => membershipFindMany(...a),
      upsert: (...a: unknown[]) => membershipUpsert(...a),
      deleteMany: (...a: unknown[]) => membershipDeleteMany(...a),
    },
  },
}));

const { grantMembership, listMemberships, resolveAccessibleShop, revokeMembershipsForShop } =
  await import("./shop-access.server");

const user = { id: "user-1" } as never;

const membership = (shopId: string, domain: string) => ({
  shopId,
  role: "OWNER" as const,
  shop: { id: shopId, domain, name: domain },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolving which store a web session may read", () => {
  it("returns null when the account has connected no store", async () => {
    // The normal state straight after signup. Not an error — the caller sends
    // them to connect one.
    membershipFindMany.mockResolvedValue([]);
    expect(await resolveAccessibleShop(user, null)).toBeNull();
  });

  it("defaults to the most recent membership", async () => {
    membershipFindMany.mockResolvedValue([
      membership("shop-new", "new.myshopify.com"),
      membership("shop-old", "old.myshopify.com"),
    ]);

    const shop = await resolveAccessibleShop(user, null);
    expect(shop?.id).toBe("shop-new");
    expect(membershipFindMany.mock.calls[0]?.[0].orderBy).toEqual({
      createdAt: "desc",
    });
  });

  it("honours an explicit store choice the user is a member of", async () => {
    membershipFindMany.mockResolvedValue([
      membership("shop-new", "new.myshopify.com"),
      membership("shop-old", "old.myshopify.com"),
    ]);

    const shop = await resolveAccessibleShop(user, "shop-old");
    expect(shop?.id).toBe("shop-old");
  });

  /**
   * The security property of the whole web dashboard.
   *
   * The store id arrives from the query string, so it is attacker-controlled.
   * It is matched against the memberships already returned for this user
   * rather than looked up, which is why a forged id can only ever miss.
   */
  it("never returns a store the user is not a member of", async () => {
    membershipFindMany.mockResolvedValue([membership("shop-mine", "mine.myshopify.com")]);

    const shop = await resolveAccessibleShop(user, "shop-someone-elses");

    expect(shop?.id).toBe("shop-mine");
    // And the lookup was scoped to this user, not to the requested id.
    expect(membershipFindMany.mock.calls[0]?.[0].where).toEqual({ userId: "user-1" });
  });

  it("falls back rather than erroring when a chosen store goes stale", async () => {
    // Membership revoked or store uninstalled since the id was put in the URL.
    // Logging someone out over a stale bookmark helps nobody.
    membershipFindMany.mockResolvedValue([membership("shop-a", "a.myshopify.com")]);
    expect((await resolveAccessibleShop(user, "shop-gone"))?.id).toBe("shop-a");
  });
});

describe("membership writes", () => {
  it("is idempotent, because re-installing is normal", async () => {
    await grantMembership("user-1", "shop-1");

    const call = membershipUpsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({ userId_shopId: { userId: "user-1", shopId: "shop-1" } });
    expect(call.create.role).toBe("OWNER");
  });

  it("drops every membership when a store uninstalls", async () => {
    // Otherwise the web dashboard keeps serving the last-imported numbers for
    // a store that just revoked the app.
    await revokeMembershipsForShop("shop-1");
    expect(membershipDeleteMany.mock.calls[0]?.[0]).toEqual({
      where: { shopId: "shop-1" },
    });
  });
});

describe("listing memberships", () => {
  it("summarises each store for the switcher", async () => {
    membershipFindMany.mockResolvedValue([membership("shop-1", "a.myshopify.com")]);

    expect(await listMemberships("user-1")).toEqual([
      {
        shopId: "shop-1",
        domain: "a.myshopify.com",
        name: "a.myshopify.com",
        role: "OWNER",
      },
    ]);
  });
});
