import { expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  validateErasureKey: vi.fn(),
  startRetention: vi.fn(),
  startWebhooks: vi.fn(),
}));

vi.mock("./shopify.server", () => ({
  addDocumentResponseHeaders: vi.fn(),
}));
vi.mock("./lib/customer-erasure.server", () => ({
  validateCustomerErasureConfiguration: startup.validateErasureKey,
}));
vi.mock("./lib/data-retention.server", () => ({
  startDataRetentionScheduler: startup.startRetention,
}));
vi.mock("./lib/webhooks.server", () => ({
  startWebhookDeliveryWorker: startup.startWebhooks,
}));

it("validates the stable erasure key before starting either background worker", async () => {
  await import("./entry.server");

  expect(startup.validateErasureKey).toHaveBeenCalledOnce();
  expect(startup.startRetention).toHaveBeenCalledOnce();
  expect(startup.startWebhooks).toHaveBeenCalledOnce();
  expect(startup.validateErasureKey.mock.invocationCallOrder[0]).toBeLessThan(
    startup.startRetention.mock.invocationCallOrder[0]!,
  );
  expect(startup.validateErasureKey.mock.invocationCallOrder[0]).toBeLessThan(
    startup.startWebhooks.mock.invocationCallOrder[0]!,
  );
});
