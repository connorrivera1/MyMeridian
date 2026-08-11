import { ConnectorProvider } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MERIDIAN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");

const connectorUpdate = vi.fn();
vi.mock("~/db.server", () => ({
  default: { connector: { update: (...args: unknown[]) => connectorUpdate(...args) } },
}));
vi.mock("~/lib/recompute.server", () => ({ recomputeShopProfitability: vi.fn() }));
vi.mock("~/lib/shopify-catalog.server", () => ({ adminClientForShop: vi.fn() }));

const { encryptSecret, decryptSecret } = await import("~/lib/crypto.server");
const { ensureShipStationWebhook } = await import("./shipping.server");

describe("ShipStation webhook registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectorUpdate.mockResolvedValue({});
  });

  it("registers the v2 shipped event with a secret custom header", async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => {
      void _input;
      return _init?.method === "POST"
        ? Response.json({ webhook_id: "se-webhook-1" })
        : Response.json([]);
    });
    const result = await ensureShipStationWebhook({
      id: "connector_1",
      provider: ConnectorProvider.SHIPSTATION,
      accessTokenEnc: encryptSecret("shipstation-key"),
      webhookId: null,
      webhookSecretEnc: null,
    }, "https://meridian.example", fetcher);

    expect(result).toEqual({
      webhookId: "se-webhook-1",
      target: "https://meridian.example/webhooks/shipstation/connector_1",
    });
    const request = fetcher.mock.calls[1]![1]!;
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({ "API-Key": "shipstation-key" });
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      event: "fulfillment_shipped_v2",
      url: result.target,
      headers: [{ key: "X-Meridian-Webhook-Secret", value: expect.any(String) }],
    });
    const stored = connectorUpdate.mock.calls[0]![0].data.webhookSecretEnc;
    expect(stored).not.toContain(body.headers[0].value);
    expect(decryptSecret(stored)).toBe(body.headers[0].value);
  });
});
