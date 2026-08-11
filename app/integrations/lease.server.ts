import { randomUUID } from "node:crypto";

import prisma from "~/db.server";

export const CONNECTOR_WORK_LEASE_MS = 4 * 60 * 1000;
const CONNECTOR_WORK_HEARTBEAT_MS = 60 * 1000;

/** Atomically claim provider work across every running Meridian process. */
export async function claimConnectorWork(
  connectorId: string,
  purpose: string,
  now = new Date(),
) {
  const token = `${purpose}:${randomUUID()}`;
  const claimed = await prisma.connector.updateMany({
    where: {
      id: connectorId,
      OR: [
        { workLeaseToken: null },
        { workLeaseExpiresAt: null },
        { workLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      workLeaseToken: token,
      workLeaseExpiresAt: new Date(now.getTime() + CONNECTOR_WORK_LEASE_MS),
    },
  });
  return claimed.count === 1 ? token : null;
}

export async function releaseConnectorWork(connectorId: string, token: string) {
  await prisma.connector.updateMany({
    where: { id: connectorId, workLeaseToken: token },
    data: { workLeaseToken: null, workLeaseExpiresAt: null },
  });
}

export async function withConnectorWork<T>(
  connectorId: string,
  purpose: string,
  now: Date,
  work: () => Promise<T>,
): Promise<{ claimed: false } | { claimed: true; value: T }> {
  const token = await claimConnectorWork(connectorId, purpose, now);
  if (!token) return { claimed: false };
  const heartbeat = setInterval(() => {
    void prisma.connector.updateMany({
      where: { id: connectorId, workLeaseToken: token },
      data: { workLeaseExpiresAt: new Date(Date.now() + CONNECTOR_WORK_LEASE_MS) },
    }).catch((error) =>
      console.error(`[connector-lease:${connectorId}] heartbeat failed`, error),
    );
  }, CONNECTOR_WORK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return { claimed: true, value: await work() };
  } finally {
    clearInterval(heartbeat);
    try {
      await releaseConnectorWork(connectorId, token);
    } catch (error) {
      // The bounded lease expires by itself. Do not turn successful provider
      // work into a retry merely because cleanup briefly lost the database.
      console.error(`[connector-lease:${connectorId}] release failed`, error);
    }
  }
}
