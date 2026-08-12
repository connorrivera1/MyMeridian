import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Queue mechanics without a database.
 *
 * The integration suite proves the SQL; this proves the decisions around it —
 * which enqueue collapses onto which, what happens when the dedupe key is held
 * by work that has already read its inputs, and whether a failure is retried or
 * given up on. Those are the branches a merchant hits on a bad day, and they
 * cannot depend on a Postgres being present to be tested.
 */

interface JobRow {
  id: string;
  shopId: string;
  kind: string;
  status: string;
  dedupeKey: string | null;
  payload: unknown;
  result: unknown;
  attempts: number;
  availableAt: Date;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
}

let rows: JobRow[];
let nextId: number;

class FakeKnownRequestError extends Error {
  constructor(readonly code: string) {
    super(`fake prisma error ${code}`);
  }
}

/** Set to fail the next create with a unique violation, once. */
let failNextCreateWithConflict = false;

function matches(row: JobRow, where: any): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.dedupeKey !== undefined && row.dedupeKey !== where.dedupeKey) {
    return false;
  }
  if (where.leaseToken !== undefined && row.leaseToken !== where.leaseToken) {
    return false;
  }
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (where.availableAt?.lte && row.availableAt > where.availableAt.lte) {
    return false;
  }
  if (where.OR) {
    const ok = where.OR.some((clause: any) => {
      if ("leaseExpiresAt" in clause) {
        if (clause.leaseExpiresAt === null) return row.leaseExpiresAt === null;
        if (clause.leaseExpiresAt?.lte) {
          return (
            row.leaseExpiresAt !== null &&
            row.leaseExpiresAt <= clause.leaseExpiresAt.lte
          );
        }
      }
      return false;
    });
    if (!ok) return false;
  }
  return true;
}

function applyData(row: JobRow, data: any): void {
  for (const [key, value] of Object.entries(data ?? {})) {
    if (
      value &&
      typeof value === "object" &&
      "increment" in (value as Record<string, unknown>)
    ) {
      (row as any)[key] =
        ((row as any)[key] ?? 0) + (value as { increment: number }).increment;
      continue;
    }
    (row as any)[key] = value;
  }
}

vi.mock("@prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: FakeKnownRequestError },
  RecalcJobKind: {
    COST_RESTATEMENT: "COST_RESTATEMENT",
    BUNDLE_ROLLUP: "BUNDLE_ROLLUP",
    BUNDLE_DETECTION: "BUNDLE_DETECTION",
  },
  RecalcJobStatus: {
    QUEUED: "QUEUED",
    RUNNING: "RUNNING",
    COMPLETE: "COMPLETE",
    FAILED: "FAILED",
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    recalcJob: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = rows.find((candidate) => matches(candidate, where));
        return row ? { ...row } : null;
      }),
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const found = rows
          .filter((row) => matches(row, where))
          .sort((a, b) => {
            void orderBy;
            return (
              a.availableAt.getTime() - b.availableAt.getTime() ||
              a.createdAt.getTime() - b.createdAt.getTime()
            );
          });
        return found[0] ? { ...found[0] } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        if (failNextCreateWithConflict) {
          failNextCreateWithConflict = false;
          throw new FakeKnownRequestError("P2002");
        }
        if (
          data.dedupeKey &&
          rows.some((row) => row.dedupeKey === data.dedupeKey)
        ) {
          throw new FakeKnownRequestError("P2002");
        }
        const row: JobRow = {
          id: `job_${nextId++}`,
          result: null,
          attempts: 0,
          leaseToken: null,
          leaseExpiresAt: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          createdAt: new Date(2026, 0, nextId),
          availableAt: new Date(),
          status: "QUEUED",
          dedupeKey: null,
          ...data,
        };
        rows.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) throw new Error("no row");
        applyData(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const found = rows.filter((row) => matches(row, where));
        for (const row of found) applyData(row, data);
        return { count: found.length };
      }),
    },
  },
}));

const {
  completeRecalcJob,
  drainRecalcQueue,
  enqueueExclusiveRecalcJob,
  enqueueRecalcJob,
  failRecalcJob,
  leaseNextRecalcJob,
  recalcRetryDelayMs,
  registerRecalcHandler,
  runRecalcJob,
  RECALC_MAX_ATTEMPTS,
} = await import("./recalc-queue.server");

beforeEach(() => {
  rows = [];
  nextId = 1;
  failNextCreateWithConflict = false;
});

const enqueue = (over: Record<string, unknown> = {}) =>
  enqueueRecalcJob({
    shopId: "shop_1",
    kind: "BUNDLE_ROLLUP" as any,
    payload: {},
    ...over,
  });

describe("enqueueRecalcJob", () => {
  it("creates a job when nothing matches the key", async () => {
    const job = await enqueue({ dedupeKey: "k" });
    expect(job.status).toBe("QUEUED");
    expect(rows).toHaveLength(1);
  });

  it("collapses onto an outstanding queued job and takes the newer payload", async () => {
    const first = await enqueue({ dedupeKey: "k", payload: { round: 1 } });
    const second = await enqueue({ dedupeKey: "k", payload: { round: 2 } });

    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ round: 2 });
  });

  it("keeps the earliest eligibility when a burst coalesces", async () => {
    const early = new Date("2026-01-01T00:00:00Z");
    const late = new Date("2026-01-02T00:00:00Z");

    await enqueue({ dedupeKey: "k", availableAt: early });
    await enqueue({ dedupeKey: "k", availableAt: late });

    expect(rows[0]!.availableAt).toEqual(early);
  });

  it("hands the key to a new job when the holder is already running", async () => {
    // The running job has read its inputs, so it cannot absorb this request —
    // and the unique index must not turn that into a 500 for the merchant.
    await enqueue({ dedupeKey: "k" });
    rows[0]!.status = "RUNNING";

    const second = await enqueue({ dedupeKey: "k", payload: { later: true } });

    expect(rows).toHaveLength(2);
    expect(rows[0]!.dedupeKey).toBeNull();
    expect(second.dedupeKey).toBe("k");
    expect(second.status).toBe("QUEUED");
  });

  it("still queues the work when two processes race for the key", async () => {
    failNextCreateWithConflict = true;

    const job = await enqueue({ dedupeKey: "k" });

    // Losing the key is the right losing move: a duplicate run of idempotent
    // work is a wasted sweep, a lost enqueue is a correction that never happens.
    expect(job.dedupeKey).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it("does not swallow an unrelated database error", async () => {
    const db = (await import("~/db.server")).default as any;
    db.recalcJob.create.mockImplementationOnce(async () => {
      throw new FakeKnownRequestError("P1001");
    });

    await expect(enqueue({ dedupeKey: "k" })).rejects.toThrow("P1001");
  });

  it("creates independent jobs when no key is given", async () => {
    await enqueue();
    await enqueue();
    expect(rows).toHaveLength(2);
  });
});

describe("enqueueExclusiveRecalcJob", () => {
  const enqueueExclusive = () =>
    enqueueExclusiveRecalcJob({
      shopId: "shop_1",
      kind: "BUNDLE_ROLLUP" as any,
      payload: {},
      dedupeKey: "exclusive",
    });

  it("creates the first request and collapses every outstanding duplicate", async () => {
    const first = await enqueueExclusive();
    const second = await enqueueExclusive();
    rows[0]!.status = "RUNNING";
    const third = await enqueueExclusive();

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, job: { id: first.job.id } });
    expect(third).toMatchObject({ created: false, job: { id: first.job.id } });
    expect(rows).toHaveLength(1);
  });

  it("releases a terminal residue before creating a new request", async () => {
    const first = await enqueueExclusive();
    rows[0]!.status = "FAILED";

    const second = await enqueueExclusive();

    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dedupeKey).toBeNull();
    expect(rows[1]!.dedupeKey).toBe("exclusive");
  });
});

describe("leaseNextRecalcJob", () => {
  it("claims a due job and stamps the first attempt", async () => {
    await enqueue();
    const leased = await leaseNextRecalcJob();

    expect(leased).not.toBeNull();
    expect(leased!.attempt).toBe(1);
    expect(rows[0]!.status).toBe("RUNNING");
    expect(rows[0]!.leaseToken).not.toBeNull();
  });

  it("returns nothing when the only job is not due yet", async () => {
    await enqueue({ availableAt: new Date(Date.now() + 60_000) });
    expect(await leaseNextRecalcJob()).toBeNull();
  });

  it("leaves a live lease alone", async () => {
    await enqueue();
    await leaseNextRecalcJob();
    expect(await leaseNextRecalcJob()).toBeNull();
  });

  it("reclaims a job whose worker died and left the lease to expire", async () => {
    await enqueue();
    await leaseNextRecalcJob();
    rows[0]!.leaseExpiresAt = new Date(Date.now() - 1_000);

    const retaken = await leaseNextRecalcJob();
    expect(retaken).not.toBeNull();
    expect(retaken!.attempt).toBe(2);
  });

  it("keeps the original start time across a takeover", async () => {
    await enqueue();
    const first = await leaseNextRecalcJob();
    const startedAt = rows[0]!.startedAt;
    rows[0]!.leaseExpiresAt = new Date(Date.now() - 1_000);

    await leaseNextRecalcJob();
    expect(rows[0]!.startedAt).toEqual(startedAt);
    expect(first!.leaseToken).not.toBe(rows[0]!.leaseToken);
  });

  it("takes the oldest due job first", async () => {
    await enqueue({ availableAt: new Date("2026-02-01T00:00:00Z") });
    await enqueue({ availableAt: new Date("2026-01-01T00:00:00Z") });

    const leased = await leaseNextRecalcJob();
    expect(leased!.job.id).toBe(rows[1]!.id);
  });
});

describe("completeRecalcJob", () => {
  it("publishes the result and releases the dedupe key", async () => {
    await enqueue({ dedupeKey: "k" });
    const leased = await leaseNextRecalcJob();

    const ok = await completeRecalcJob(leased!.job.id, leased!.leaseToken, {
      ordersAffected: 3,
    });

    expect(ok).toBe(true);
    expect(rows[0]!.status).toBe("COMPLETE");
    expect(rows[0]!.result).toEqual({ ordersAffected: 3 });
    // Released, so the same work can legitimately be asked for again later.
    expect(rows[0]!.dedupeKey).toBeNull();
    expect(rows[0]!.leaseToken).toBeNull();
  });

  it("refuses a worker whose lease was taken from it", async () => {
    await enqueue();
    const leased = await leaseNextRecalcJob();
    rows[0]!.leaseToken = "someone-else";

    expect(
      await completeRecalcJob(leased!.job.id, leased!.leaseToken, {}),
    ).toBe(false);
    expect(rows[0]!.status).toBe("RUNNING");
  });
});

describe("failRecalcJob", () => {
  it("requeues with backoff while attempts remain", async () => {
    await enqueue({ dedupeKey: "k" });
    const leased = await leaseNextRecalcJob();

    await failRecalcJob(
      leased!.job.id,
      leased!.leaseToken,
      1,
      new Error("boom"),
    );

    expect(rows[0]!.status).toBe("QUEUED");
    expect(rows[0]!.error).toBe("Operation failed (Error).");
    expect(rows[0]!.dedupeKey).toBe("k");
    expect(rows[0]!.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives up at the attempt ceiling rather than retrying for ever", async () => {
    await enqueue({ dedupeKey: "k" });
    const leased = await leaseNextRecalcJob();

    await failRecalcJob(
      leased!.job.id,
      leased!.leaseToken,
      RECALC_MAX_ATTEMPTS,
      new Error("poison"),
    );

    // A correction that cannot be applied is a merchant-visible problem, and a
    // job wedged in permanent retry hides it behind a spinner.
    expect(rows[0]!.status).toBe("FAILED");
    expect(rows[0]!.finishedAt).not.toBeNull();
    expect(rows[0]!.dedupeKey).toBeNull();
  });

  it("does not retain a runaway error message", async () => {
    await enqueue();
    const leased = await leaseNextRecalcJob();
    await failRecalcJob(
      leased!.job.id,
      leased!.leaseToken,
      1,
      new Error("x".repeat(5_000)),
    );

    expect(rows[0]!.error).toBe("Operation failed (Error).");
  });

  it("backs off exponentially and then stops growing", () => {
    expect(recalcRetryDelayMs(1)).toBe(10_000);
    expect(recalcRetryDelayMs(2)).toBe(20_000);
    expect(recalcRetryDelayMs(3)).toBe(40_000);
    expect(recalcRetryDelayMs(50)).toBe(15 * 60 * 1000);
  });
});

describe("runRecalcJob", () => {
  it("completes through the registered handler", async () => {
    registerRecalcHandler("BUNDLE_ROLLUP" as any, async () => ({ done: true }));
    await enqueue();
    const leased = await leaseNextRecalcJob();

    await runRecalcJob(leased!);

    expect(rows[0]!.status).toBe("COMPLETE");
    expect(rows[0]!.result).toEqual({ done: true });
  });

  it("fails the job rather than the sweep when no handler is registered", async () => {
    // COST_RESTATEMENT is never registered in this file, so this is the real
    // shape of a deploy whose registry did not get populated.
    await enqueue({ kind: "COST_RESTATEMENT" as any });
    const leased = await leaseNextRecalcJob();

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runRecalcJob(leased!);
    errors.mockRestore();

    expect(rows[0]!.status).toBe("QUEUED");
    expect(rows[0]!.error).toBe("Operation failed (Error).");
  });

  it("records a handler's own failure against the job", async () => {
    registerRecalcHandler("BUNDLE_ROLLUP" as any, async () => {
      throw new Error("handler exploded");
    });
    await enqueue();
    const leased = await leaseNextRecalcJob();

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runRecalcJob(leased!);
    errors.mockRestore();

    expect(rows[0]!.error).toBe("Operation failed (Error).");
  });
});

describe("drainRecalcQueue", () => {
  it("works through every due job", async () => {
    registerRecalcHandler("BUNDLE_ROLLUP" as any, async () => ({ ok: true }));
    await enqueue();
    await enqueue();

    expect(await drainRecalcQueue()).toBe(2);
    expect(rows.every((row) => row.status === "COMPLETE")).toBe(true);
  });

  it("stops at the batch size so queue work cannot monopolise the process", async () => {
    registerRecalcHandler("BUNDLE_ROLLUP" as any, async () => ({ ok: true }));
    for (let i = 0; i < 9; i += 1) await enqueue();

    expect(await drainRecalcQueue()).toBe(4);
  });

  it("returns zero on an empty queue", async () => {
    expect(await drainRecalcQueue()).toBe(0);
  });
});
