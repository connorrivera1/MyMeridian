import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorProvider,
  ConnectorStatus,
  CostRuleOrigin,
  SyncStatus,
} from "@prisma/client";

const shopFindUnique = vi.fn();
const shopCreate = vi.fn();
const shopUpdate = vi.fn();
const connectorCreateMany = vi.fn();
const connectorFindUnique = vi.fn();
const connectorUpsert = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUnique: (...args: unknown[]) => shopFindUnique(...args),
      create: (...args: unknown[]) => shopCreate(...args),
      update: (...args: unknown[]) => shopUpdate(...args),
    },
    connector: {
      createMany: (...args: unknown[]) => connectorCreateMany(...args),
      findUnique: (...args: unknown[]) => connectorFindUnique(...args),
      upsert: (...args: unknown[]) => connectorUpsert(...args),
    },
  },
}));

const { ensureShopProvisioned, synchroniseShopifyShippingConnector } =
  await import("./provision.server");

/**
 * What a store is given at install.
 *
 * The Settings screen renders one row per `Connector`, so a provider with no
 * row is not shown as "Not configured" — it is not shown at all. `TIKTOK_ADS`
 * was in that position: present in the schema enum, labelled and given a
 * purpose string on the Settings screen, and created by the seed, but never
 * created here. The demo store therefore listed a TikTok Ads connector that no
 * real install could ever produce, while the engine computed TikTok CAC and
 * ROAS beside a table that did not mention TikTok.
 */

const DOMAIN = "meridian-test.myshopify.com";

/** The connector rows a `shop.create` call would write. */
function createdConnectors() {
  const [call] = shopCreate.mock.calls;
  return (
    call![0] as {
      data: { connectors: { create: { provider: string; status: string }[] } };
    }
  ).data.connectors.create;
}

/** The cost assumptions a `shop.create` call would write. */
function createdCostRules() {
  const [call] = shopCreate.mock.calls;
  return (
    call![0] as {
      data: {
        costRules: {
          create: {
            kind: string;
            origin: CostRuleOrigin;
            confirmedAt: Date | null;
          }[];
        };
      };
    }
  ).data.costRules.create;
}

beforeEach(() => {
  shopFindUnique.mockReset();
  shopCreate.mockReset();
  shopUpdate.mockReset();
  connectorCreateMany.mockReset();
  connectorFindUnique.mockReset();
  connectorUpsert.mockReset();

  shopCreate.mockResolvedValue({ id: "shop_1", domain: DOMAIN });
  shopUpdate.mockResolvedValue({ id: "shop_1", domain: DOMAIN });
  connectorCreateMany.mockResolvedValue({ count: 0 });
  connectorFindUnique.mockResolvedValue(null);
  connectorUpsert.mockResolvedValue({});
});

describe("Shopify Shipping protected-data approval", () => {
  it("does not re-enable a permission-blocked connector on every authenticated page", async () => {
    const approvalMessage =
      "Shopify has not approved protected customer data for Shipping reports yet. Request approval in the Partner Dashboard, then retry this connection.";
    connectorFindUnique.mockResolvedValue({
      status: ConnectorStatus.ERROR,
      lastError: approvalMessage,
    });

    await synchroniseShopifyShippingConnector(
      "shop_1",
      "read_orders,read_reports",
    );

    expect(connectorUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: ConnectorStatus.ERROR,
          lastError: approvalMessage,
        }),
      }),
    );
  });

  it("connects normally when read_reports is granted and no approval block exists", async () => {
    await synchroniseShopifyShippingConnector(
      "shop_1",
      "read_orders,read_reports",
    );

    expect(connectorUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: ConnectorStatus.CONNECTED,
          lastError: null,
        }),
      }),
    );
  });
});

describe("connectors given to a new store", () => {
  it("creates a row for every provider the schema declares", async () => {
    shopFindUnique.mockResolvedValue(null);
    await ensureShopProvisioned(DOMAIN);

    const provisioned = createdConnectors()
      .map((c) => c.provider)
      .sort();

    // Adding a provider to the enum and forgetting this list is the whole bug.
    // Reading the enum rather than restating it is what makes that impossible.
    expect(provisioned).toEqual(Object.values(ConnectorProvider).sort());
  });

  it("includes TikTok, the channel the engine reports on and the seed connects", async () => {
    shopFindUnique.mockResolvedValue(null);
    await ensureShopProvisioned(DOMAIN);

    const tiktok = createdConnectors().find(
      (c) => c.provider === ConnectorProvider.TIKTOK_ADS,
    );

    expect(tiktok).toBeDefined();
    expect(tiktok!.status).toBe(ConnectorStatus.NOT_CONFIGURED);
  });

  it("connects Shopify and nothing else — no ad platform has an OAuth flow yet", async () => {
    shopFindUnique.mockResolvedValue(null);
    await ensureShopProvisioned(DOMAIN);

    const connected = createdConnectors().filter(
      (c) => c.status === ConnectorStatus.CONNECTED,
    );

    // A row claiming CONNECTED for a platform with no token is the same false
    // promise the listing copy was carrying, one layer down.
    expect(connected.map((c) => c.provider)).toEqual([
      ConnectorProvider.SHOPIFY,
    ]);
  });
});

describe("cost assumptions given to a new store", () => {
  it("persists every install default as unconfirmed", async () => {
    shopFindUnique.mockResolvedValue(null);

    await ensureShopProvisioned(DOMAIN);

    const rules = createdCostRules();
    expect(rules).toHaveLength(4);
    expect(
      rules.every(
        (rule) =>
          rule.origin === CostRuleOrigin.INSTALL_DEFAULT &&
          rule.confirmedAt === null,
      ),
    ).toBe(true);
  });
});

describe("an install that already exists", () => {
  it("backfills providers a store predates, on reinstall", async () => {
    shopFindUnique.mockResolvedValue({
      id: "shop_1",
      domain: DOMAIN,
      uninstalledAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    await ensureShopProvisioned(DOMAIN);

    expect(connectorCreateMany).toHaveBeenCalledTimes(1);
    const args = connectorCreateMany.mock.calls[0]![0] as {
      data: { provider: string; shopId: string }[];
      skipDuplicates: boolean;
    };

    // Rows the store already has must survive untouched — a merchant's
    // connected Shopify row carries its own displayName and sync stamp.
    expect(args.skipDuplicates).toBe(true);
    expect(args.data.map((row) => row.provider).sort()).toEqual(
      Object.values(ConnectorProvider).sort(),
    );
    expect(args.data.every((row) => row.shopId === "shop_1")).toBe(true);
  });

  it("re-runs the import on reinstall rather than trusting the old sync state", async () => {
    shopFindUnique.mockResolvedValue({
      id: "shop_1",
      domain: DOMAIN,
      uninstalledAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    await ensureShopProvisioned(DOMAIN);

    const [args] = shopUpdate.mock.calls[0]! as [
      { data: { syncStatus: SyncStatus; uninstalledAt: null } },
    ];
    expect(args.data.syncStatus).toBe(SyncStatus.PENDING);
    expect(args.data.uninstalledAt).toBeNull();
  });

  it("writes nothing at all for a live install", async () => {
    const live = { id: "shop_1", domain: DOMAIN, uninstalledAt: null };
    shopFindUnique.mockResolvedValue(live);

    await expect(ensureShopProvisioned(DOMAIN)).resolves.toBe(live);

    // This runs on every authenticated request. A write here would be a write
    // on every page load.
    expect(shopUpdate).not.toHaveBeenCalled();
    expect(shopCreate).not.toHaveBeenCalled();
    expect(connectorCreateMany).not.toHaveBeenCalled();
  });
});
