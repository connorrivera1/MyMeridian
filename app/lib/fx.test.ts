import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FX resolution order and its refusal to guess. The table is the record of
 * what rate every stored conversion used, so the assertions here are about
 * *which* rate wins and when the module declines to answer at all.
 */

const rateFindUnique = vi.fn();
const rateFindFirst = vi.fn();
const rateUpsert = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    exchangeRate: {
      findUnique: (...args: unknown[]) => rateFindUnique(...args),
      findFirst: (...args: unknown[]) => rateFindFirst(...args),
      upsert: (...args: unknown[]) => rateUpsert(...args),
    },
  },
}));

const { convertCents, fxDayKey, fxRate, FxRateUnavailableError } = await import(
  "./fx.server"
);

const DAY = new Date("2026-08-10T15:30:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  rateFindUnique.mockResolvedValue(null);
  rateFindFirst.mockResolvedValue(null);
  rateUpsert.mockResolvedValue({});
  vi.unstubAllEnvs();
});

describe("fxRate", () => {
  it("answers 1 for a same-currency conversion without touching anything", async () => {
    await expect(fxRate(DAY, "usd", "USD")).resolves.toBe(1);
    expect(rateFindUnique).not.toHaveBeenCalled();
  });

  it("prefers the exact cached day", async () => {
    rateFindUnique.mockResolvedValue({ rate: "1.1000000000" });
    await expect(fxRate(DAY, "EUR", "USD")).resolves.toBe(1.1);
    expect(rateFindFirst).not.toHaveBeenCalled();
  });

  it("uses the nearest earlier rate inside the staleness bound — Friday's rate is Saturday's rate", async () => {
    rateFindFirst.mockResolvedValue({
      day: new Date("2026-08-08T00:00:00.000Z"),
      rate: "1.0950000000",
    });
    await expect(fxRate(DAY, "EUR", "USD")).resolves.toBe(1.095);
  });

  it("rejects a rate more than a week stale and fetches instead", async () => {
    rateFindFirst.mockResolvedValue({
      day: new Date("2026-07-01T00:00:00.000Z"),
      rate: "1.0000000000",
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ rates: { USD: 1.12 } }), { status: 200 }),
    );

    await expect(fxRate(DAY, "EUR", "USD", fetcher)).resolves.toBe(1.12);
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      "/2026-08-10?from=EUR&to=USD",
    );
    // The fetched rate is cached: next month's recompute must reuse it.
    expect(rateUpsert).toHaveBeenCalledTimes(1);
  });

  it("throws rather than convert at a guessed rate when nothing answers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(fxRate(DAY, "EUR", "USD", fetcher)).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it("treats a malformed rate payload as unavailable, not as rate zero", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ rates: { USD: 0 } }), { status: 200 }),
      );
    await expect(fxRate(DAY, "EUR", "USD", fetcher)).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
  });

  it("honours MERIDIAN_FX_DISABLED by never fetching", async () => {
    vi.stubEnv("MERIDIAN_FX_DISABLED", "true");
    const fetcher = vi.fn<typeof fetch>();
    await expect(fxRate(DAY, "EUR", "USD", fetcher)).rejects.toBeInstanceOf(
      FxRateUnavailableError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("keys days in UTC", () => {
    expect(fxDayKey(new Date("2026-08-10T23:59:59.000Z"))).toBe("2026-08-10");
  });

  it("rounds converted cents exactly once", () => {
    expect(convertCents(3333, 1.1)).toBe(3666); // 3666.3 → 3666
    expect(convertCents(50, 1.129)).toBe(56); // 56.45 → 56
    expect(convertCents(-340, 1)).toBe(-340);
  });
});
