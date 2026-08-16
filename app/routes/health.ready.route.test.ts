import { beforeEach, describe, expect, it, vi } from "vitest";

const readinessConfiguration = vi.fn();

vi.mock("~/db.server", () => ({
  default: {},
  systemPrisma: { $queryRaw: vi.fn() },
  withTenantDatabase: vi.fn(),
}));
vi.mock("~/lib/readiness.server", () => ({
  readinessConfiguration: () => readinessConfiguration(),
}));

const { loader } = await import("./health.ready");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readiness route", () => {
  it("does not disclose missing secret or provider configuration names", async () => {
    readinessConfiguration.mockReturnValue({
      ready: false,
      missing: ["META_APP_SECRET", "MERIDIAN_OPERATOR_TOTP_SECRET"],
    });

    const response = await loader();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "not_ready",
      reason: "configuration",
    });
  });
});
