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

function usesDedicatedTenantLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  const systemUrl = env.DATABASE_URL?.trim();
  const tenantUrl = env.MERIDIAN_TENANT_DATABASE_URL?.trim();
  if (!systemUrl || !tenantUrl) return false;
  try {
    return new URL(systemUrl).username !== new URL(tenantUrl).username;
  } catch {
    return false;
  }
}

if (process.env.NODE_ENV !== "production") {
  global.__meridianPrisma = systemPrisma;
  if (tenantPrisma) global.__meridianTenantPrisma = tenantPrisma;
}

type TransactionClient = Prisma.TransactionClient;
const tenantStorage = new AsyncLocalStorage<TransactionClient | undefined>();

/** Explicit privileged client for authentication, workers and operations. */
export { systemPrisma };

export interface TenantDatabaseContext {
  shopId: string;
  userId?: string | null;
}

/**
 * Run merchant-data work under PostgreSQL RLS on one transaction/connection.
 * Deployed Fly Managed Postgres uses a separate least-privileged tenant login
 * directly. Local/integration environments may use the migration owner, so
 * they immediately SET LOCAL ROLE down to the tenant group instead.
 */
export async function withTenantDatabase<T>(
  context: TenantDatabaseContext,
  work: () => Promise<T>,
): Promise<T> {
  const client = tenantPrisma ?? systemPrisma;
  return client.$transaction(
    async (tx) => {
      // Managed Postgres has two separately provisioned runtime identities and
      // forbids custom role creation. In that deployment the dedicated tenant
      // login is the RLS principal. Local and integration databases retain the
      // group-role path so those checks exercise the same tenant policy.
      if (!usesDedicatedTenantLogin()) {
        await tx.$executeRawUnsafe("SET LOCAL ROLE meridian_tenant");
      }
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

/**
 * Begin background work outside a request's tenant transaction.
 *
 * AsyncLocalStorage otherwise follows an unawaited worker promise after the
 * request commits. That leaves durable workers holding a closed transaction
 * client instead of their intended system database connection.
 */
export function withoutTenantDatabase<T>(work: () => T): T {
  return tenantStorage.run(undefined, work);
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
