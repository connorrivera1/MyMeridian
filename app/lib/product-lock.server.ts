import type { Prisma } from "@prisma/client";

import prisma from "~/db.server";

/**
 * Serialise and atomically commit one Shopify product delivery.
 *
 * A product webhook overwrites current Product/Variant state and may append the
 * only durable record of a price transition. Those writes are one fact: if the
 * history insert fails, publishing the new current price would make a retry
 * believe there was no transition and lose the change forever.
 *
 * Delivery ids only deduplicate the same webhook. Shopify can deliver create
 * and update events for the same product concurrently, so they also need a
 * product-scoped lock. The lock is transaction-scoped and therefore releases
 * on commit or rollback. Including the shop id in the hashed key prevents two
 * tenants with the same Shopify numeric product id from contending.
 */
const PRODUCT_LOCK_CLASS = 4_242_003;

export async function withProductLock<T>(
  shopId: string,
  shopifyProductId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // PostgreSQL text values cannot contain NUL. The two values have distinct
  // shapes (Meridian cuid, then Shopify GID), so a printable separator keeps
  // the composite unambiguous before hashtext maps it to the lock key.
  const lockKey = `${shopId}|${shopifyProductId}`;

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        select pg_advisory_xact_lock(
          ${PRODUCT_LOCK_CLASS}::int,
          hashtext(${lockKey})::int
        )
      `;
      return run(tx);
    },
    { timeout: 20_000, maxWait: 15_000 },
  );
}
