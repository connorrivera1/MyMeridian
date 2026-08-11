import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import prisma from "~/db.server";

function actorHash(actor: string): string {
  return createHash("sha256").update(actor).digest("hex");
}

export async function recordMerchantAccess(input: {
  shopId: string;
  actorType: "shopify_session" | "web_account";
  actorId: string;
  request: Request;
}): Promise<void> {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  const hash = actorHash(input.actorId);
  try {
    await prisma.securityAuditEvent.create({
      data: {
        shopId: input.shopId,
        actorType: input.actorType,
        actorHash: hash,
        action: "MERCHANT_APP_ACCESS",
        resource: "protected_commerce_data",
        requestPath: new URL(input.request.url).pathname.slice(0, 500),
        dedupeKey: `access:${input.shopId}:${hash}:${hour}`,
        occurredAt: now,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return;
    }
    throw error;
  }
}

export async function recordSensitiveAction(input: {
  shopId: string;
  actorType: "shopify_session" | "web_account";
  actorId: string;
  request: Request;
  action: string;
  resource: string;
  dedupeKey?: string;
}): Promise<void> {
  await prisma.securityAuditEvent.create({
    data: {
      shopId: input.shopId,
      actorType: input.actorType,
      actorHash: actorHash(input.actorId),
      action: input.action.slice(0, 100),
      resource: input.resource.slice(0, 200),
      requestPath: new URL(input.request.url).pathname.slice(0, 500),
      dedupeKey: input.dedupeKey ?? null,
    },
  });
}

export async function purgeExpiredSecurityAuditEvents(
  now = new Date(),
  retentionDays = 365,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const deleted = await prisma.securityAuditEvent.deleteMany({
    where: { occurredAt: { lt: cutoff } },
  });
  return deleted.count;
}
