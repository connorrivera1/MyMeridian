import { randomBytes } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
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
  let runtimeSystem: PrismaClient | null = null;
  let runtimeTenant: PrismaClient | null = null;
  let runtimeSystemRole = "";
  let runtimeTenantRole = "";

  function runtimeUrl(role: string, password: string): string {
    const url = new URL(TEST_URL!);
    url.username = role;
    url.password = password;
    return url.toString();
  }

  async function asRuntimeTenant<T>(
    shopId: string,
    userId: string | null,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!runtimeTenant) throw new Error("Runtime tenant client is unavailable.");
    return runtimeTenant.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE meridian_tenant");
      await tx.$executeRaw(Prisma.sql`
        SELECT set_config('meridian.shop_id', ${shopId}, true)
      `);
      await tx.$executeRaw(Prisma.sql`
        SELECT set_config('meridian.user_id', ${userId ?? ""}, true)
      `);
      return work(tx);
    });
  }

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

    // Production has two non-owner LOGIN roles. Exercise those credentials
    // directly so a future grant change cannot leave a deployment with an
    // apparently valid migration owner but an unusable or over-privileged app.
    const suffix = randomBytes(8).toString("hex");
    runtimeSystemRole = `meridian_test_system_${suffix}`;
    runtimeTenantRole = `meridian_test_tenant_${suffix}`;
    const systemPassword = randomBytes(24).toString("hex");
    const tenantPassword = randomBytes(24).toString("hex");
    const databaseName = new URL(TEST_URL!).pathname.slice(1);

    await systemPrisma.$executeRawUnsafe(
      `CREATE ROLE \"${runtimeSystemRole}\" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${systemPassword}'`,
    );
    await systemPrisma.$executeRawUnsafe(
      `CREATE ROLE \"${runtimeTenantRole}\" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${tenantPassword}'`,
    );
    await systemPrisma.$executeRawUnsafe(
      `GRANT CONNECT ON DATABASE \"${databaseName}\" TO \"${runtimeSystemRole}\", \"${runtimeTenantRole}\"`,
    );
    await systemPrisma.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA public TO \"${runtimeSystemRole}\", \"${runtimeTenantRole}\"`,
    );
    await systemPrisma.$executeRawUnsafe(
      `GRANT meridian_system TO \"${runtimeSystemRole}\"`,
    );
    await systemPrisma.$executeRawUnsafe(
      `GRANT meridian_tenant TO \"${runtimeTenantRole}\"`,
    );
    // Fly Managed Postgres places each provisioned Writer login in a broad
    // writer role. Simulate that inherited table privilege here: RLS must
    // still deny identity data to the tenant runtime connection.
    await systemPrisma.$executeRawUnsafe(
      `GRANT SELECT ON TABLE \"User\" TO \"${runtimeTenantRole}\"`,
    );
    runtimeSystem = new PrismaClient({
      datasources: { db: { url: runtimeUrl(runtimeSystemRole, systemPassword) } },
    });
    runtimeTenant = new PrismaClient({
      datasources: { db: { url: runtimeUrl(runtimeTenantRole, tenantPassword) } },
    });
  });

  afterAll(async () => {
    await runtimeSystem?.$disconnect();
    await runtimeTenant?.$disconnect();
    if (!systemPrisma) return;
    await systemPrisma.shop.deleteMany({
      where: { id: { in: [shopA, shopB] } },
    });
    await systemPrisma.user.deleteMany({
      where: { id: { in: [userA, userB] } },
    });
    if (runtimeSystemRole) {
      await systemPrisma.$executeRawUnsafe(
        `REVOKE ALL PRIVILEGES ON SCHEMA public FROM \"${runtimeSystemRole}\"`,
      );
      await systemPrisma.$executeRawUnsafe(
        `REVOKE ALL PRIVILEGES ON DATABASE \"${new URL(TEST_URL!).pathname.slice(1)}\" FROM \"${runtimeSystemRole}\"`,
      );
      await systemPrisma.$executeRawUnsafe(
        `REVOKE meridian_system FROM \"${runtimeSystemRole}\"`,
      );
      await systemPrisma.$executeRawUnsafe(
        `DROP ROLE IF EXISTS \"${runtimeSystemRole}\"`,
      );
    }
    if (runtimeTenantRole) {
      await systemPrisma.$executeRawUnsafe(
        `REVOKE SELECT ON TABLE \"User\" FROM \"${runtimeTenantRole}\"`,
      );
      await systemPrisma.$executeRawUnsafe(
        `REVOKE ALL PRIVILEGES ON SCHEMA public FROM \"${runtimeTenantRole}\"`,
      );
      await systemPrisma.$executeRawUnsafe(
        `REVOKE ALL PRIVILEGES ON DATABASE \"${new URL(TEST_URL!).pathname.slice(1)}\" FROM \"${runtimeTenantRole}\"`,
      );
      await systemPrisma.$executeRawUnsafe(
        `REVOKE meridian_tenant FROM \"${runtimeTenantRole}\"`,
      );
      await systemPrisma.$executeRawUnsafe(
        `DROP ROLE IF EXISTS \"${runtimeTenantRole}\"`,
      );
    }
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

  it("enforces RLS for a separately provisioned production tenant login", async () => {
    const visible = await asRuntimeTenant(shopA, userA, (tx) =>
      tx.product.findMany({
        where: { shopId: { in: [shopA, shopB] } },
        include: { shop: { select: { id: true } } },
      }),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ id: productA, shopId: shopA });

    const crossShopWrite = await asRuntimeTenant(shopA, userA, (tx) =>
      tx.product.updateMany({
        where: { id: productB },
        data: { title: "Runtime tenant cross-shop write" },
      }),
    );
    expect(crossShopWrite.count).toBe(0);

    // This runtime login has a direct SELECT grant to simulate Fly's inherited
    // Writer role. Forced RLS must still make identity rows invisible and
    // reject writes without relying on a missing-table-privilege error.
    await expect(runtimeTenant!.user.count()).resolves.toBe(0);
    await expect(
      runtimeTenant!.user.create({
        data: { email: `blocked-${stamp}@example.com` },
      }),
    ).rejects.toThrow();
    await expect(
      runtimeTenant!.$executeRawUnsafe("SET ROLE meridian_system"),
    ).rejects.toThrow();
  });

  it("keeps the separately provisioned system login non-owner but operational", async () => {
    const role = await runtimeSystem!.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >(Prisma.sql`
      SELECT rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = ${runtimeSystemRole}
    `);
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    const [users, products] = await Promise.all([
      runtimeSystem!.user.count({ where: { id: { in: [userA, userB] } } }),
      runtimeSystem!.product.findMany({
        where: { id: { in: [productA, productB] } },
      }),
    ]);
    expect(users).toBe(2);
    expect(products).toHaveLength(2);
  });
});
