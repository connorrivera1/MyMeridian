import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;
const suite = TEST_URL ? describe : describe.skip;

suite("PostgreSQL tenant row-level security", () => {
  let prisma: typeof import("~/db.server").default;
  let systemPrisma: typeof import("~/db.server").systemPrisma;
  let withTenantDatabase: typeof import("~/db.server").withTenantDatabase;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let shopA = "";
  let shopB = "";
  let userA = "";
  let userB = "";
  let productA = "";
  let productB = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    ({
      default: prisma,
      systemPrisma,
      withTenantDatabase,
    } = await import("~/db.server"));

    const [firstShop, secondShop, firstUser, secondUser] = await Promise.all([
      systemPrisma.shop.create({
        data: {
          domain: `rls-a-${stamp}.myshopify.com`,
          name: "RLS store A",
        },
      }),
      systemPrisma.shop.create({
        data: {
          domain: `rls-b-${stamp}.myshopify.com`,
          name: "RLS store B",
        },
      }),
      systemPrisma.user.create({
        data: { email: `rls-a-${stamp}@example.com` },
      }),
      systemPrisma.user.create({
        data: { email: `rls-b-${stamp}@example.com` },
      }),
    ]);
    shopA = firstShop.id;
    shopB = secondShop.id;
    userA = firstUser.id;
    userB = secondUser.id;

    const [firstProduct, secondProduct] = await Promise.all([
      systemPrisma.product.create({
        data: {
          shopId: shopA,
          shopifyId: `gid://shopify/Product/a-${stamp}`,
          title: "Only A may read this",
          handle: `a-${stamp}`,
        },
      }),
      systemPrisma.product.create({
        data: {
          shopId: shopB,
          shopifyId: `gid://shopify/Product/b-${stamp}`,
          title: "Only B may read this",
          handle: `b-${stamp}`,
        },
      }),
      systemPrisma.shopMembership.create({
        data: { shopId: shopA, userId: userA },
      }),
      systemPrisma.shopMembership.create({
        data: { shopId: shopB, userId: userB },
      }),
    ]);
    productA = firstProduct.id;
    productB = secondProduct.id;
  });

  afterAll(async () => {
    if (!systemPrisma) return;
    await systemPrisma.shop.deleteMany({
      where: { id: { in: [shopA, shopB] } },
    });
    await systemPrisma.user.deleteMany({
      where: { id: { in: [userA, userB] } },
    });
  });

  it("shows a merchant only the active shop even when the query has no shop filter", async () => {
    const visible = await withTenantDatabase(
      { shopId: shopA, userId: userA },
      () => prisma.product.findMany({ orderBy: { id: "asc" } }),
    );

    expect(visible.map((product) => product.id)).toContain(productA);
    expect(visible.map((product) => product.id)).not.toContain(productB);
    await expect(
      withTenantDatabase({ shopId: shopA, userId: userA }, () =>
        prisma.product.findUnique({ where: { id: productB } }),
      ),
    ).resolves.toBeNull();
  });

  it("blocks cross-shop inserts, updates, and deletes at PostgreSQL", async () => {
    await expect(
      withTenantDatabase({ shopId: shopA, userId: userA }, () =>
        prisma.product.create({
          data: {
            shopId: shopB,
            shopifyId: `gid://shopify/Product/attack-${stamp}`,
            title: "Cross-tenant insert",
            handle: `attack-${stamp}`,
          },
        }),
      ),
    ).rejects.toThrow();

    const result = await withTenantDatabase(
      { shopId: shopA, userId: userA },
      async () => ({
        updated: await prisma.product.updateMany({
          where: { id: productB },
          data: { title: "Cross-tenant update" },
        }),
        deleted: await prisma.product.deleteMany({ where: { id: productB } }),
      }),
    );
    expect(result.updated.count).toBe(0);
    expect(result.deleted.count).toBe(0);
    await expect(
      systemPrisma.product.findUniqueOrThrow({ where: { id: productB } }),
    ).resolves.toMatchObject({ title: "Only B may read this" });
  });

  it("requires both the active shop and user to read a membership", async () => {
    const ownMemberships = await withTenantDatabase(
      { shopId: shopA, userId: userA },
      () => prisma.shopMembership.findMany(),
    );
    const wrongUser = await withTenantDatabase(
      { shopId: shopA, userId: userB },
      () => prisma.shopMembership.findMany(),
    );
    const missingUser = await withTenantDatabase({ shopId: shopA }, () =>
      prisma.shopMembership.findMany(),
    );

    expect(ownMemberships).toHaveLength(1);
    expect(ownMemberships[0]).toMatchObject({ shopId: shopA, userId: userA });
    expect(wrongUser).toEqual([]);
    expect(missingUser).toEqual([]);
  });

  it("keeps identity tables unreachable from the tenant role", async () => {
    await expect(
      withTenantDatabase({ shopId: shopA, userId: userA }, () =>
        prisma.user.findMany(),
      ),
    ).rejects.toThrow();
  });

  it("leaves the explicit system client able to operate across shops", async () => {
    const products = await systemPrisma.product.findMany({
      where: { id: { in: [productA, productB] } },
    });
    expect(products).toHaveLength(2);
  });
});
