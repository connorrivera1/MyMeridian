import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();
vi.mock("~/db.server", () => ({
  default: { connector: { updateMany: (...args: unknown[]) => updateMany(...args) } },
}));

const { claimConnectorWork, releaseConnectorWork, CONNECTOR_WORK_LEASE_MS } = await import("./lease.server");

describe("cross-process connector work lease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims only an expired or empty lease and releases only its own token", async () => {
    const now = new Date("2026-08-11T12:00:00Z");
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    const token = await claimConnectorWork("connector_1", "ad-health", now);

    expect(token).toMatch(/^ad-health:/);
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: "connector_1", OR: expect.any(Array) },
      data: { workLeaseToken: token, workLeaseExpiresAt: new Date(now.getTime() + CONNECTOR_WORK_LEASE_MS) },
    });

    await releaseConnectorWork("connector_1", token!);
    expect(updateMany.mock.calls[1]![0]).toEqual({
      where: { id: "connector_1", workLeaseToken: token },
      data: { workLeaseToken: null, workLeaseExpiresAt: null },
    });
  });

  it("returns null when another process owns the live lease", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await expect(claimConnectorWork("connector_1", "carrier")).resolves.toBeNull();
  });
});
