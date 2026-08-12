import { AsyncLocalStorage } from "node:async_hooks";

import { Prisma, PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __meridianPrisma: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __meridianTenantPrisma: PrismaClient | undefined;
}

// Vite reloads server modules on every change in dev; without a global handle
// each reload opens a new pool and Postgres runs out of connections.
const systemPrisma = global.__meridianPrisma ?? new PrismaClient();
const tenantPrisma =
  global.__meridianTenantPrisma ??
  (process.env.MERIDIAN_TENANT_DATABASE_URL
    ? new PrismaClient({
        datasources: { db: { url: process.env.MERIDIAN_TENANT_DATABASE_URL } },
      })
    : null);

if (process.env.NODE_ENV !== "production") {
  global.__meridianPrisma = systemPrisma;
  if (tenantPrisma) global.__meridianTenantPrisma = tenantPrisma;
}

type TransactionClient = Prisma.TransactionClient;
const tenantStorage = new AsyncLocalStorage<TransactionClient>();

/** Explicit privileged client for authentication, workers and operations. */
export { systemPrisma };

export interface TenantDatabaseContext {
  shopId: string;
  userId?: string | null;
}

/**
 * Run merchant-data work under PostgreSQL RLS on one transaction/connection.
 * Production uses a least-privileged login URL. Local/integration environments
 * may use the migration owner, but immediately SET LOCAL ROLE down to the same
 * no-login tenant role the production login inherits.
 */
export async function withTenantDatabase<T>(
  context: TenantDatabaseContext,
  work: () => Promise<T>,
): Promise<T> {
  const client = tenantPrisma ?? systemPrisma;
  return client.$transaction(
    async (tx) => {
      // Do this even for the dedicated production login. Its own grants are
      // deliberately insufficient; the transaction must explicitly assume
      // the NOLOGIN RLS group before any merchant query can run.
      await tx.$executeRawUnsafe("SET LOCAL ROLE meridian_tenant");
      await tx.$executeRaw(Prisma.sql`
        SELECT set_config('meridian.shop_id', ${context.shopId}, true)
      `);
      await tx.$executeRaw(Prisma.sql`
        SELECT set_config('meridian.user_id', ${context.userId ?? ""}, true)
      `);
      return tenantStorage.run(tx, work);
    },
    { maxWait: 5_000, timeout: 30_000 },
  );
}

/** True only inside an active tenant-scoped database transaction. */
export function tenantDatabaseActive(): boolean {
  return Boolean(tenantStorage.getStore());
}

/*
 * Existing data modules import the default client. Inside withTenantDatabase,
 * this proxy delegates every model/query to the restricted transaction. A
 * nested Prisma transaction becomes part of the already-atomic outer one;
 * outside the scope, workers/auth/operator code retains the explicit system
 * client behaviour it had before this boundary existed.
 */
const prisma = new Proxy(systemPrisma, {
  get(target, property) {
    const active = tenantStorage.getStore();
    if (active && property === "$transaction") {
      return async (
        input:
          | Array<Promise<unknown>>
          | ((client: TransactionClient) => Promise<unknown>),
      ) => (Array.isArray(input) ? Promise.all(input) : input(active));
    }

    const source = active ?? target;
    const value = Reflect.get(source, property, source);
    return typeof value === "function" ? value.bind(source) : value;
  },
}) as PrismaClient;

export default prisma;
