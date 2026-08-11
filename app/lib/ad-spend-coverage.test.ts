import { ConnectorStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("~/db.server", () => ({
  default: {
    connector: { findMany: (...args: unknown[]) => findMany(...args) },
  },
}));

const { classifyAdSpendCoverage, loadAdSpendCoverage } = await import(
  "./ad-spend-coverage.server"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ad-spend coverage", () => {
  it("does not turn the demo's absent spend data into a measured zero", () => {
    expect(classifyAdSpendCoverage(true, [])).toEqual({
      mode: "unavailable",
      syncedSourceCount: 0,
    });
  });

  it("does not turn an unconfigured or never-synced connector into a measured zero", () => {
    expect(
      classifyAdSpendCoverage(false, [
        { status: ConnectorStatus.NOT_CONFIGURED, lastSyncedAt: null },
        { status: ConnectorStatus.CONNECTED, lastSyncedAt: null },
      ]),
    ).toEqual({ mode: "unavailable", syncedSourceCount: 0 });
  });

  it("recognises a paid source only after a successful sync", () => {
    expect(
      classifyAdSpendCoverage(false, [
        {
          status: ConnectorStatus.CONNECTED,
          lastSyncedAt: new Date("2026-08-10T12:00:00Z"),
        },
        { status: ConnectorStatus.ERROR, lastSyncedAt: null },
      ]),
    ).toEqual({ mode: "connected", syncedSourceCount: 1 });
  });

  it("does not query live connectors for the no-spend demo", async () => {
    await expect(loadAdSpendCoverage("demo_shop", true)).resolves.toEqual({
      mode: "unavailable",
      syncedSourceCount: 0,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reads only paid connector sync state for a live store", async () => {
    findMany.mockResolvedValue([
      {
        status: ConnectorStatus.CONNECTED,
        lastSyncedAt: new Date("2026-08-10T12:00:00Z"),
      },
    ]);

    await expect(loadAdSpendCoverage("shop_1", false)).resolves.toEqual({
      mode: "connected",
      syncedSourceCount: 1,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        provider: { in: ["FACEBOOK_ADS", "GOOGLE_ADS", "TIKTOK_ADS"] },
      },
      select: { status: true, lastSyncedAt: true },
    });
  });
});
