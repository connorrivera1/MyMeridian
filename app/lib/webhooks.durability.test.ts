import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.SHOPIFY_APP_URL = "https://queue-test.example.com";
process.env.SCOPES = "read_orders,read_products";

const mocks = vi.hoisted(() => ({
  shopFindUnique: vi.fn(),
  eventCreate: vi.fn(),
  eventFindFirst: vi.fn(),
  eventUpdateMany: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: (...args: unknown[]) => mocks.shopFindUnique(...args) },
    webhookEvent: {
      create: (...args: unknown[]) => mocks.eventCreate(...args),
      findFirst: (...args: unknown[]) => mocks.eventFindFirst(...args),
      updateMany: (...args: unknown[]) => mocks.eventUpdateMany(...args),
    },
    session: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("~/lib/webhook-dispatch.server", () => ({
  dispatchPersistedWebhook: (...args: unknown[]) => mocks.dispatch(...args),
}));

const {
  claimWebhook,
  drainWebhookQueue,
  startWebhookDeliveryWorker,
  stopWebhookDeliveryWorker,
  webhooksSettled,
} = await import("./webhooks.server");

const candidate = {
  id: "event_1",
  webhookId: "delivery_1",
  shopDomain: "queue-test.myshopify.com",
  topic: "ORDERS_CREATE",
  payload: {
    id: 123,
    customer: { id: 456, email: "customer@example.com" },
  },
  attempts: 1,
};

function updateCallWith(field: string) {
  return mocks.eventUpdateMany.mock.calls.find(
    ([call]) =>
      call &&
      typeof call === "object" &&
      field in ((call as { data?: Record<string, unknown> }).data ?? {}),
  )?.[0];
}

beforeEach(() => {
  stopWebhookDeliveryWorker();
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.shopFindUnique.mockResolvedValue({ id: "shop_1" });
  mocks.eventCreate.mockResolvedValue({ id: "event_1" });
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.eventUpdateMany.mockResolvedValue({ count: 1 });
  mocks.dispatch.mockResolvedValue(undefined);
});

afterEach(() => {
  stopWebhookDeliveryWorker();
  vi.useRealTimers();
});

describe("durable webhook claims", () => {
  it("stores the verified payload and owns a lease before acknowledging", async () => {
    const payload = {
      id: 123,
      email: "root-email-is-not-used@example.com",
      customer: {
        id: 456,
        email: "customer@example.com",
        first_name: "must not persist",
      },
    };
    const claim = await claimWebhook(
      "delivery_1",
      "queue-test.myshopify.com",
      "ORDERS_CREATE",
      payload,
    );

    expect(claim.kind).toBe("claimed");
    expect(mocks.eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webhookId: "delivery_1",
        shopId: "shop_1",
        payload: {
          id: 123,
          customer: { id: 456, email: "customer@example.com" },
        },
        payloadExpiresAt: expect.any(Date),
        attempts: 1,
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
      }),
    });
  });

  it("does not retain a payload for an unknown or already-redacted shop", async () => {
    mocks.shopFindUnique.mockResolvedValue(null);
    await expect(
      claimWebhook("late_1", "gone.myshopify.com", "SHOP_REDACT", {
        shop_id: 1,
      }),
    ).resolves.toEqual({ kind: "untracked" });
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
});

describe("queue recovery", () => {
  it("leases a stale row, runs its route processor, then clears PCD", async () => {
    mocks.eventFindFirst
      .mockResolvedValueOnce(candidate)
      .mockResolvedValue(null);

    await expect(drainWebhookQueue()).resolves.toBe(1);

    expect(updateCallWith("attempts")).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ id: "event_1", processedAt: null }),
        data: expect.objectContaining({
          attempts: { increment: 1 },
          leaseToken: expect.any(String),
        }),
      }),
    );
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: "delivery_1",
        payload: candidate.payload,
        isReplay: true,
      }),
    );
    const successWrite = mocks.eventUpdateMany.mock.calls
      .map(([call]) => call)
      .find(
        (call) =>
          (call as { where?: { webhookId?: string } }).where?.webhookId ===
          "delivery_1",
      );
    expect(successWrite).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          processedAt: expect.any(Date),
          payload: Prisma.DbNull,
          leaseToken: null,
        }),
      }),
    );
  });

  it("releases a failed delivery with its payload intact and retries it later", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.eventFindFirst
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(null);
    mocks.dispatch.mockRejectedValueOnce(new Error("transient write failure"));

    await expect(drainWebhookQueue()).resolves.toBe(1);
    const failureWrite = mocks.eventUpdateMany.mock.calls
      .map(([call]) => call)
      .find(
        (call) =>
          (call as { data?: { error?: string } }).data?.error ===
          "Operation failed (Error).",
      ) as {
      data: Record<string, unknown>;
    };
    expect(failureWrite.data).toEqual(
      expect.objectContaining({
        error: "Operation failed (Error).",
        availableAt: expect.any(Date),
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    );
    expect(failureWrite.data).not.toHaveProperty("payload");
    expect(failureWrite.data).not.toHaveProperty("processedAt");

    mocks.eventFindFirst
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(null);
    mocks.dispatch.mockResolvedValueOnce(undefined);
    await expect(drainWebhookQueue()).resolves.toBe(1);

    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(
      mocks.eventUpdateMany.mock.calls
        .map(([call]) => call)
        .find(
          (call) =>
            (call as { where?: { webhookId?: string } }).where?.webhookId ===
            "delivery_1" &&
            (call as { data?: { payload?: unknown } }).data?.payload ===
              Prisma.DbNull,
        ),
    ).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ payload: Prisma.DbNull }),
      }),
    );
    consoleError.mockRestore();
  });

  it("never dispatches when another process wins the atomic lease", async () => {
    mocks.eventFindFirst
      .mockResolvedValueOnce(candidate)
      .mockResolvedValue(null);
    mocks.eventUpdateMany
      .mockResolvedValueOnce({ count: 0 }) // expiry sweep
      .mockResolvedValueOnce({ count: 0 }); // lease contention

    await expect(drainWebhookQueue()).resolves.toBe(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the stale lease recoverable if recording a failure also fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.eventFindFirst
      .mockResolvedValueOnce(candidate)
      .mockResolvedValue(null);
    mocks.eventUpdateMany
      .mockResolvedValueOnce({ count: 0 }) // expiry sweep
      .mockResolvedValueOnce({ count: 1 }) // lease
      .mockRejectedValueOnce(new Error("database unavailable"));
    mocks.dispatch.mockRejectedValueOnce(new Error("processor failed"));

    await expect(drainWebhookQueue()).resolves.toBe(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[%s] %s",
      "webhook:delivery_1 delivery-failure persistence",
      "Operation failed (Error).",
    );
    consoleError.mockRestore();
  });

  it("sweeps once at startup and again on the polling interval", async () => {
    vi.useFakeTimers();
    startWebhookDeliveryWorker();
    await webhooksSettled();
    expect(mocks.eventFindFirst).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await webhooksSettled();
    expect(mocks.eventFindFirst).toHaveBeenCalledTimes(2);
  });
});
