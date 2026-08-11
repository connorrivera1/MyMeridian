import { ConnectorProvider, ConnectorStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MERIDIAN_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");

const mocks = vi.hoisted(() => ({
  connectorFindUnique: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: { connector: { findUnique: (...args: unknown[]) => mocks.connectorFindUnique(...args) } },
}));
vi.mock("~/integrations/shipping.server", () => ({
  reconcileCarrierConnector: (...args: unknown[]) => mocks.reconcile(...args),
}));
vi.mock("~/integrations/lease.server", () => ({
  withConnectorWork: async (
    _connectorId: string,
    _purpose: string,
    _now: Date,
    work: () => Promise<unknown>,
  ) => ({ claimed: true, value: await work() }),
}));

const { encryptSecret } = await import("~/lib/crypto.server");
const { action } = await import("./webhooks.shipstation");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectorFindUnique.mockResolvedValue({
    id: "connector_1",
    provider: ConnectorProvider.SHIPSTATION,
    status: ConnectorStatus.CONNECTED,
    webhookSecretEnc: encryptSecret("listener-secret"),
    shop: { domain: "store.myshopify.com", currency: "USD" },
  });
  mocks.reconcile.mockResolvedValue({ ordersUpdated: 1 });
});

function request(secret: string, body = "{}") {
  return action({
    request: new Request("https://meridian.example/webhooks/shipstation/connector_1", {
      method: "POST",
      headers: { "X-Meridian-Webhook-Secret": secret },
      body,
    }),
    params: { connectorId: "connector_1" },
    context: {},
  } as never);
}

describe("ShipStation fulfillment webhook", () => {
  it("requires the encrypted per-connector header before immediate reconciliation", async () => {
    await expect(request("wrong-secret")).resolves.toMatchObject({ status: 401 });
    expect(mocks.reconcile).not.toHaveBeenCalled();

    await expect(request("listener-secret")).resolves.toMatchObject({ status: 204 });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "connector_1" }),
      expect.any(Date),
    );
  });

  it("rejects oversized webhook bodies before database or provider work", async () => {
    const response = await request("listener-secret", "x".repeat(256 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(mocks.connectorFindUnique).not.toHaveBeenCalled();
  });
});
