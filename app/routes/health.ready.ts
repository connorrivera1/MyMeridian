import prisma, { systemPrisma, withTenantDatabase } from "~/db.server";
import { addSecurityHeaders } from "~/lib/http-security";
import { readinessConfiguration } from "~/lib/readiness.server";

function readinessHeaders(): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  addSecurityHeaders(headers);
  return headers;
}

export async function loader() {
  const configuration = readinessConfiguration();
  if (!configuration.ready) {
    return Response.json(
      {
        status: "not_ready",
        reason: "configuration",
      },
      { status: 503, headers: readinessHeaders() },
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

    let identityIsolated = false;
    try {
      const visibleIdentities = await withTenantDatabase(
        { shopId: sentinelShop },
        () => prisma.user.count(),
      );
      // A direct table grant can exist through a managed-provider role. Forced
      // RLS is equally valid when it reduces the identity relation to zero
      // rows; a tenant must never see or mutate identity records.
      identityIsolated = visibleIdentities === 0;
    } catch {
      identityIsolated = true;
    }
    if (!identityIsolated)
      throw new Error("Tenant database can see identity tables.");

    return Response.json(
      { status: "ready", database: "reachable", tenantIsolation: "enforced" },
      { headers: readinessHeaders() },
    );
  } catch {
    return Response.json(
      { status: "not_ready", reason: "database" },
      { status: 503, headers: readinessHeaders() },
    );
  }
}
