import {
  ConnectorProvider,
  ConnectorStatus,
  type Connector,
} from "@prisma/client";

import prisma from "~/db.server";

const PAID_MARKETING_PROVIDERS = [
  ConnectorProvider.FACEBOOK_ADS,
  ConnectorProvider.GOOGLE_ADS,
  ConnectorProvider.TIKTOK_ADS,
] as const;

type PaidConnectorState = Pick<Connector, "status" | "lastSyncedAt">;

export interface AdSpendCoverage {
  mode: "connected" | "unavailable";
  /** Sources whose connection has completed at least one sync. */
  syncedSourceCount: number;
}

/**
 * Decide whether a zero in `AdSpend` is an observed zero or missing input.
 *
 * `CONNECTED` alone is insufficient: OAuth may finish before the first import,
 * and showing `$0` during that gap would turn "not loaded yet" into a financial
 * claim. A live source counts only after it has a successful sync timestamp.
 */
export function classifyAdSpendCoverage(
  isDemo: boolean,
  connectors: readonly PaidConnectorState[],
): AdSpendCoverage {
  // The demo seed deliberately writes no AdSpend rows. A controlled fixture is
  // not evidence that paid spend was observed, so it follows the same honest
  // missing-input path as a live store with no completed connector sync.
  if (isDemo) return { mode: "unavailable", syncedSourceCount: 0 };

  const syncedSourceCount = connectors.filter(
    (connector) =>
      connector.status === ConnectorStatus.CONNECTED &&
      connector.lastSyncedAt !== null,
  ).length;

  return {
    mode: syncedSourceCount > 0 ? "connected" : "unavailable",
    syncedSourceCount,
  };
}

/** What this store can actually measure, not what the schema could hold. */
export async function loadAdSpendCoverage(
  shopId: string,
  isDemo: boolean,
): Promise<AdSpendCoverage> {
  // The seeded demo has no connector and deliberately contains no spend data.
  // Do not query connector state, but do surface the unavailable input.
  if (isDemo) return classifyAdSpendCoverage(true, []);

  const connectors = await prisma.connector.findMany({
    where: {
      shopId,
      provider: { in: [...PAID_MARKETING_PROVIDERS] },
    },
    select: {
      status: true,
      lastSyncedAt: true,
    },
  });

  return classifyAdSpendCoverage(false, connectors);
}
