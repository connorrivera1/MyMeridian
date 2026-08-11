import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MERIDIAN_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");

vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/lib/recompute.server", () => ({ recomputeShopProfitability: vi.fn() }));
vi.mock("~/lib/shopify-catalog.server", () => ({ adminClientForShop: vi.fn() }));

const { encryptSecret } = await import("~/lib/crypto.server");
const { fetchShipStationCosts } = await import("./shipping.server");

describe("ShipStation live contract adapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hydrates label shipment IDs, captures late voids, and never retains shipment addresses", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      void _init;
      const url = new URL(String(input));
      if (url.pathname === "/v2/shipments") {
        return Response.json({ shipments: [{
          shipment_id: "se-shipment-1",
          external_shipment_id: "#1001",
          ship_to: { name: "Private recipient" },
        }], pages: 1 });
      }
      if (url.pathname === "/v2/labels" && url.searchParams.get("label_status") === "voided") {
        return Response.json({ labels: [{
          label_id: "se-old-void",
          shipment_id: "se-shipment-1",
          shipment_cost: { amount: "9.50", currency: "USD" },
          voided: true,
          voided_at: "2026-08-11T12:05:00Z",
          created_at: "2026-06-01T00:00:00Z",
        }], pages: 1 });
      }
      if (url.pathname === "/v2/labels") {
        return Response.json({ labels: [{
          label_id: "se-new",
          shipment_id: "se-shipment-1",
          shipment_cost: { amount: "12.75", currency: "USD" },
          created_at: "2026-08-11T12:00:00Z",
        }], pages: 1 });
      }
      throw new Error(`Unexpected ShipStation URL ${url}`);
    });

    const result = await fetchShipStationCosts(
      encryptSecret("shipstation-api-key"),
      new Date("2026-08-11T12:00:00Z"),
      fetcher,
    );

    expect(result).toHaveLength(2);
    expect(result.map((row) => row.externalOrderRef)).toEqual(["#1001", "#1001"]);
    expect(result.find((row) => row.externalId === "se-old-void")?.voided).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Private recipient");
    expect(fetcher.mock.calls.every((call) => {
      const headers = call[1]?.headers as Record<string, string>;
      return headers["API-Key"] === "shipstation-api-key";
    })).toBe(true);
  });
});
