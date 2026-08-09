import type { Prisma } from "@prisma/client";

import prisma from "~/db.server";

/**
 * Serialised, atomic writes to the rows hanging off one order.
 *
 * Line items and fulfilments are written by deleting every row for the order
 * and recreating them. That is the right shape — Shopify sends the full
 * collection each time and there is no stable way to diff it — but unguarded it
 * has two failure modes, and both are reachable in ordinary use because Shopify
 * routinely sends `orders/create` immediately followed by `orders/updated`.
 * Those are different webhook ids, so the delivery-level idempotency in
 * `webhooks.server.ts` does not suppress either one. The historical import runs
 * concurrently with live webhooks too, and writes the same rows.
 *
 *   Interleaved as A-delete, B-delete, A-create, B-create, the second insert
 *   violates `@@unique([orderId, shopifyId])`. The handler throws, the error is
 *   recorded on an already-claimed `WebhookEvent` row, and that delivery is
 *   lost for good.
 *
 *   Interleaved as A-delete, A-create, B-delete, B-create it converges — but
 *   between B's delete and B's create the order has *no line items*, and a
 *   dashboard request reading it in that window computes zero COGS. The order
 *   reports 100% margin. It fails in the direction that looks like good news,
 *   which is the worst direction for a tool whose entire promise is that the
 *   number is true.
 *
 * Two things are needed, and a transaction alone supplies only one. The
 * transaction closes the read window: no one observes the intermediate state.
 * The advisory lock is what makes concurrent writers take turns rather than
 * collide, and it is transaction-scoped (`_xact_`), so it releases on commit or
 * rollback with no unlock path to forget.
 *
 * The lock is namespaced by a class id so an order lock can never collide with
 * an advisory lock taken elsewhere for something unrelated. `hashtext` maps the
 * cuid to an int4; a hash collision between two different orders costs some
 * needless serialisation and never costs correctness.
 *
 * Reads that do not need to be inside the critical section — resolving variants,
 * for instance — belong outside it. Keep this block small: every statement here
 * is time another writer for the same order spends waiting.
 */
const ORDER_LOCK_CLASS = 4_242_001;

export async function withOrderLock<T>(
  orderId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        select pg_advisory_xact_lock(
          ${ORDER_LOCK_CLASS}::int,
          hashtext(${orderId})::int
        )
      `;
      return run(tx);
    },
    {
      // A backfill page imports 25 orders in sequence, so a webhook for one of
      // them can queue behind real work. Generous enough to wait it out, short
      // enough that a genuinely stuck transaction surfaces as an error rather
      // than as a hung request.
      timeout: 20_000,
      maxWait: 15_000,
    },
  );
}
