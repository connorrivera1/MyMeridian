import prisma, { systemPrisma, withTenantDatabase } from "~/db.server";
import { readinessConfiguration } from "~/lib/readiness.server";

export async function loader() {
  const configuration = readinessConfiguration();
  if (!configuration.ready) {
    return Response.json(
      {
        status: "not_ready",
        reason: "configuration",
        missing: configuration.missing,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await systemPrisma.$queryRaw`SELECT 1`;

    // A reachable database is not enough: the merchant login must actually be
    // denied identity tables and must see no shop outside its transaction-local
    // tenant. This catches a deployment that accidentally points both URLs at
    // the privileged migration/worker login.
    const sentinelShop = "__meridian_readiness_no_such_shop__";
    const visibleShops = await withTenantDatabase(
      { shopId: sentinelShop, userId: "__meridian_readiness_no_such_user__" },
      () => prisma.shop.count(),
    );
    if (visibleShops !== 0)
      throw new Error("Tenant database can enumerate shops.");

    let identityDenied = false;
    try {
      await withTenantDatabase({ shopId: sentinelShop }, () =>
        prisma.user.count(),
      );
    } catch {
      identityDenied = true;
    }
    if (!identityDenied)
      throw new Error("Tenant database can read identity tables.");

    return Response.json(
      { status: "ready", database: "reachable", tenantIsolation: "enforced" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "not_ready", reason: "database" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
