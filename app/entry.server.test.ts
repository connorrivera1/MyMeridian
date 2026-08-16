import { expect, it, vi } from "vitest";

const startup = vi.hoisted(() => ({
  validateErasureKey: vi.fn(),
  startRetention: vi.fn(),
  startWebhooks: vi.fn(),
  startIntegrations: vi.fn(),
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
vi.mock("./integrations/scheduler.server", () => ({
  startIntegrationScheduler: startup.startIntegrations,
}));

it("validates the stable erasure key before starting either background worker", async () => {
  const { addSecurityHeaders } = await import("./entry.server");

  expect(startup.validateErasureKey).toHaveBeenCalledOnce();
  expect(startup.startRetention).toHaveBeenCalledOnce();
  expect(startup.startWebhooks).toHaveBeenCalledOnce();
  expect(startup.startIntegrations).toHaveBeenCalledOnce();
  expect(startup.validateErasureKey.mock.invocationCallOrder[0]).toBeLessThan(
    startup.startRetention.mock.invocationCallOrder[0]!,
  );
  expect(startup.validateErasureKey.mock.invocationCallOrder[0]).toBeLessThan(
    startup.startWebhooks.mock.invocationCallOrder[0]!,
  );
  expect(startup.validateErasureKey.mock.invocationCallOrder[0]).toBeLessThan(
    startup.startIntegrations.mock.invocationCallOrder[0]!,
  );

  const defaults = new Headers();
  addSecurityHeaders(defaults);
  expect(defaults.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );
  expect(defaults.get("x-content-type-options")).toBe("nosniff");

  const stricter = new Headers({
    "referrer-policy": "no-referrer",
    "x-content-type-options": "custom-route-policy",
  });
  addSecurityHeaders(stricter);
  expect(stricter.get("referrer-policy")).toBe("no-referrer");
  expect(stricter.get("x-content-type-options")).toBe(
    "custom-route-policy",
  );
});
