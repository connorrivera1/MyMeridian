import { createHmac } from "node:crypto";

import type { Customer, Prisma } from "@prisma/client";
import { Prisma as PrismaRuntime } from "@prisma/client";

import prisma from "~/db.server";
import {
  normaliseWebhookTopic,
  payloadReferencesCustomer,
  scrubCustomerFromWebhookPayload,
  type CustomerReference,
} from "~/lib/webhook-payload.server";

const CUSTOMER_ERASURE_LOCK_CLASS = 4_242_002;
const CUSTOMER_ERASURE_KEY_BYTES = 32;

function normalizedCustomerId(value: string | number): string {
  return String(value)
    .trim()
    .replace(/^gid:\/\/shopify\/Customer\//i, "");
}

function customerErasureMasterKey(): Buffer {
  const configured = process.env.MERIDIAN_CUSTOMER_ERASURE_KEY;
  if (!configured && process.env.NODE_ENV !== "test") {
    throw new Error(
      "MERIDIAN_CUSTOMER_ERASURE_KEY is required to protect customer erasure guards",
    );
  }
  const masterKey = configured
    ? Buffer.from(configured, "base64")
    : Buffer.from("meridian-test-erasure-key-not-for-production", "utf8");
  if (configured && masterKey.length !== CUSTOMER_ERASURE_KEY_BYTES) {
    throw new Error(
      `MERIDIAN_CUSTOMER_ERASURE_KEY must decode to ${CUSTOMER_ERASURE_KEY_BYTES} bytes for customer erasure guards`,
    );
  }
  return masterKey;
}

/** Fail deployment startup before a compliance delivery can be acknowledged. */
export function validateCustomerErasureConfiguration(): void {
  customerErasureMasterKey();
}

function identifierDigest(
  shopId: string,
  kind: "shopify-id" | "email",
  value: string,
): string {
  const masterKey = customerErasureMasterKey();
  const erasureKey = createHmac("sha256", masterKey)
    .update("meridian-customer-erasure-hmac-key-v1")
    .digest();
  return createHmac("sha256", erasureKey)
    .update(shopId)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex");
}

/** Shop-scoped, one-way identifiers; raw PCD never enters the tombstone row. */
export function customerErasureHashes(
  shopId: string,
  customer: CustomerReference,
): string[] {
  const hashes = new Set<string>();
  if (customer.id !== undefined && customer.id !== null) {
    const id = normalizedCustomerId(customer.id);
    if (id) hashes.add(identifierDigest(shopId, "shopify-id", id));
  }
  if (typeof customer.email === "string") {
    const email = customer.email.trim().toLowerCase();
    if (email) hashes.add(identifierDigest(shopId, "email", email));
  }
  return [...hashes].sort();
}

async function lockCustomerIdentifiers(
  tx: Prisma.TransactionClient,
  hashes: string[],
): Promise<void> {
  // Sorted acquisition prevents a deadlock when one import knows both id and
  // email while another only knows one of them.
  for (const hash of hashes) {
    await tx.$executeRaw`
      select pg_advisory_xact_lock(
        ${CUSTOMER_ERASURE_LOCK_CLASS}::int,
        hashtext(${hash})::int
      )
    `;
  }
}

/**
 * Acquire the same compliance guard inside a caller-owned transaction.
 *
 * Order ingestion needs customer association, order header and line items to
 * commit as one snapshot. Starting a second transaction through
 * `upsertCustomerUnlessErased` would split that fact and let redaction land in
 * the gap, so the shared lock/check is exposed without exposing raw digests to
 * callers.
 */
export async function customerErasureStateInTransaction(
  tx: Prisma.TransactionClient,
  shopId: string,
  customer: CustomerReference,
): Promise<{ hashes: string[]; erased: boolean }> {
  const hashes = customerErasureHashes(shopId, customer);
  if (hashes.length === 0) return { hashes, erased: false };

  await lockCustomerIdentifiers(tx, hashes);
  const erased = await tx.customerErasure.findFirst({
    where: { shopId, identifierHash: { in: hashes } },
    select: { id: true },
  });
  return { hashes, erased: erased !== null };
}

export async function withCustomerErasureLock<T>(
  shopId: string,
  customer: CustomerReference,
  run: (
    tx: Prisma.TransactionClient,
    state: { hashes: string[]; erased: boolean },
  ) => Promise<T>,
): Promise<T> {
  const hashes = customerErasureHashes(shopId, customer);
  if (hashes.length === 0) {
    return prisma.$transaction((tx) => run(tx, { hashes, erased: false }));
  }

  return prisma.$transaction(
    async (tx) => {
      const state = await customerErasureStateInTransaction(
        tx,
        shopId,
        customer,
      );
      return run(tx, state);
    },
    { timeout: 20_000, maxWait: 15_000 },
  );
}

export interface ImportedCustomer {
  shopId: string;
  shopifyId: string | number;
  email?: string | null;
  acquisitionChannel: Prisma.CustomerUncheckedCreateInput["acquisitionChannel"];
  acquisitionCampaignId?: string | null;
  firstOrderAt: Date;
}

/** Atomic check-and-upsert used by live order sync and historical import. */
export async function upsertCustomerUnlessErased(
  input: ImportedCustomer,
): Promise<Customer | null> {
  const shopifyId = String(input.shopifyId).startsWith(
    "gid://shopify/Customer/",
  )
    ? String(input.shopifyId)
    : `gid://shopify/Customer/${input.shopifyId}`;
  // Shopify's customer id is the stable identity. Email is deliberately not a
  // blocking key here: two different customer records can legitimately share
  // an address, or an address can later be reassigned. Redaction stores an
  // email digest for queue/export scrubbing, while re-import prevention keys on
  // the Shopify id so it cannot suppress a different person.
  const reference = { id: shopifyId };

  return withCustomerErasureLock(
    input.shopId,
    reference,
    async (tx, { erased }) => {
      if (erased) return null;
      return tx.customer.upsert({
        where: {
          shopId_shopifyId: { shopId: input.shopId, shopifyId },
        },
        create: {
          shopId: input.shopId,
          shopifyId,
          email: input.email ?? null,
          acquisitionChannel: input.acquisitionChannel,
          acquisitionCampaignId: input.acquisitionCampaignId ?? null,
          firstOrderAt: input.firstOrderAt,
        },
        update: { email: input.email ?? undefined },
      });
    },
  );
}

export interface CustomerRedactionResult {
  customerId: string | null;
  exportsRemoved: number;
  queuedPayloadsScrubbed: number;
}

/**
 * Make erasure durable, scrub retry payloads, remove held exports and delete
 * the normalized customer in one serialized transaction.
 */
export async function redactCustomerEverywhere(input: {
  shopId: string;
  webhookId: string;
  customer: CustomerReference;
}): Promise<CustomerRedactionResult> {
  return withCustomerErasureLock(
    input.shopId,
    input.customer,
    async (tx, { hashes }) => {
      if (hashes.length === 0) {
        return {
          customerId: null,
          exportsRemoved: 0,
          queuedPayloadsScrubbed: 0,
        };
      }

      await tx.customerErasure.createMany({
        data: hashes.map((identifierHash) => ({
          shopId: input.shopId,
          identifierHash,
        })),
        skipDuplicates: true,
      });

      const pending = await tx.webhookEvent.findMany({
        where: {
          shopId: input.shopId,
          processedAt: null,
          payload: { not: PrismaRuntime.DbNull },
        },
        select: { id: true, webhookId: true, topic: true, payload: true },
      });

      let queuedPayloadsScrubbed = 0;
      for (const event of pending) {
        const payload = event.payload as Record<string, unknown> | null;
        if (!payload || !payloadReferencesCustomer(payload, input.customer)) {
          continue;
        }

        const topic = normaliseWebhookTopic(event.topic);
        if (event.webhookId === input.webhookId) {
          // The current redaction id is required if the transaction rolls back
          // and the queue must try again. Email is not required for recovery.
          if (input.customer.id !== undefined) {
            await tx.webhookEvent.updateMany({
              where: { id: event.id, processedAt: null },
              data: {
                payload: {
                  customer: { id: input.customer.id },
                } as Prisma.InputJsonValue,
              },
            });
            queuedPayloadsScrubbed += 1;
          }
          continue;
        }

        if (topic === "ORDERS_CREATE" || topic === "ORDERS_UPDATED") {
          await tx.webhookEvent.updateMany({
            where: { id: event.id, processedAt: null },
            data: {
              payload: scrubCustomerFromWebhookPayload(
                topic,
                payload,
                input.customer,
              ) as Prisma.InputJsonValue,
            },
          });
        } else {
          // A pending access request is superseded by erasure, and duplicate
          // redaction deliveries are redundant after this tombstone commits.
          await tx.webhookEvent.updateMany({
            where: { id: event.id, processedAt: null },
            data: {
              processedAt: new Date(),
              payload: PrismaRuntime.DbNull,
              payloadExpiresAt: null,
              error: null,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
        }
        queuedPayloadsScrubbed += 1;
      }

      const rawId =
        input.customer.id === undefined
          ? null
          : normalizedCustomerId(input.customer.id);
      // Shopify's customer id is authoritative when present. Email can be
      // shared or reassigned, so using it alongside an id would erase an
      // unrelated shopper's queued access report merely because the address
      // happened to match. Email is only the fallback for an id-less request.
      const exportIdentity = rawId
        ? {
            OR: [
              { shopifyCustomerId: rawId },
              { shopifyCustomerId: `gid://shopify/Customer/${rawId}` },
            ],
          }
        : input.customer.email
          ? {
              customerEmail: {
                equals: input.customer.email,
                mode: "insensitive" as const,
              },
            }
          : null;
      const exports = exportIdentity
        ? await tx.dataRequest.deleteMany({
            where: { shopId: input.shopId, ...exportIdentity },
          })
        : { count: 0 };

      const customer = rawId
        ? await tx.customer.findFirst({
            where: {
              shopId: input.shopId,
              OR: [
                { shopifyId: rawId },
                { shopifyId: `gid://shopify/Customer/${rawId}` },
              ],
            },
            select: { id: true },
          })
        : null;

      if (customer) {
        await tx.order.updateMany({
          where: { shopId: input.shopId, customerId: customer.id },
          data: {
            customerId: null,
            isFirstOrder: false,
            // Attribution URLs and campaign strings may contain shopper ids,
            // email addresses, or personalized tokens. The order's economic
            // ledger survives, but these purpose-limited identity-adjacent
            // values do not.
            campaignId: null,
            campaignName: null,
            utmSource: null,
            utmMedium: null,
            utmCampaign: null,
            landingSite: null,
          },
        });
        await tx.customer.delete({ where: { id: customer.id } });
      }

      return {
        customerId: customer?.id ?? null,
        exportsRemoved: exports.count,
        queuedPayloadsScrubbed,
      };
    },
  );
}
