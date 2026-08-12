import { randomBytes } from "node:crypto";

import {
  ConnectorProvider,
  ConnectorStatus,
  ShippingCostSource,
  ShippingObservationStatus,
  type Connector,
} from "@prisma/client";

import prisma from "~/db.server";
import { toCents } from "~/engine/money";
import { allocateTaxCents } from "~/engine/tax";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";
import { adminClientForShop } from "~/lib/shopify-catalog.server";
import { withConnectorWork } from "./lease.server";

export interface ShippingObservationInput {
  source: ShippingCostSource;
  externalId: string;
  externalOrderRef: string | null;
  carrier: string | null;
  serviceLevel: string | null;
  currency: string;
  amount: string;
  labelCount: number;
  observedAt: Date;
  sourceUpdatedAt: Date | null;
  voided?: boolean;
}

type JsonRecord = Record<string, unknown>;
export type ShipStationShipmentReferences = ReadonlyMap<string, string>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function date(value: unknown, fallback: Date): Date {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function money(value: unknown): { amount: string; currency: string } {
  const object = record(value);
  return {
    amount: text(object?.amount) ?? "0.00",
    currency: (text(object?.currency) ?? "USD").toUpperCase().slice(0, 3),
  };
}

/** Translate ShipStation v2 labels without retaining addresses or tracking. */
export function parseShipStationLabels(
  payload: unknown,
  now = new Date(),
  shipmentReferences: ShipStationShipmentReferences = new Map(),
): ShippingObservationInput[] {
  const body = record(payload);
  const labels = Array.isArray(body?.labels) ? body.labels : [];
  return labels.flatMap((value) => {
    const label = record(value);
    const externalId = text(label?.label_id);
    if (!label || !externalId) return [];
    const cost = money(label.shipment_cost);
    const status = (text(label.status) ?? "").toLowerCase();
    const refundStatus = (text(label.refund_status) ?? "").toLowerCase();
    return [
      {
        source: ShippingCostSource.SHIPSTATION,
        externalId,
        externalOrderRef:
          text(label.external_shipment_id) ??
          text(label.external_order_id) ??
          text(label.shipment_number) ??
          text(label.order_number) ??
          (text(label.shipment_id)
            ? (shipmentReferences.get(text(label.shipment_id)!) ?? null)
            : null),
        carrier: text(label.carrier_code) ?? text(label.carrier_id),
        serviceLevel: text(label.service_code),
        currency: cost.currency,
        amount: cost.amount,
        labelCount: 1,
        observedAt: date(label.created_at ?? label.ship_date, now),
        sourceUpdatedAt: text(label.modified_at)
          ? date(label.modified_at, now)
          : text(label.voided_at)
            ? date(label.voided_at, now)
            : null,
        voided:
          label.voided === true ||
          Boolean(text(label.voided_at)) ||
          status === "voided" ||
          refundStatus === "approved" ||
          refundStatus === "refunded",
      },
    ];
  });
}

/** Keep only the identifiers needed to join labels to Shopify orders. */
export function parseShipStationShipmentReferences(payload: unknown) {
  const body = record(payload);
  const shipments = Array.isArray(body?.shipments) ? body.shipments : [];
  const references = new Map<string, string>();
  for (const value of shipments) {
    const shipment = record(value);
    const shipmentId = text(shipment?.shipment_id);
    const reference =
      text(shipment?.external_shipment_id) ??
      text(shipment?.shipment_number) ??
      text(shipment?.external_order_id);
    if (shipmentId && reference) references.set(shipmentId, reference);
  }
  return references;
}

interface ShopifyQlResponse {
  data?: {
    shopifyqlQuery?: {
      tableData?: { rows?: JsonRecord[] | null } | null;
      parseErrors?: (string | { message?: string })[] | null;
    } | null;
  };
  errors?: { message?: string }[];
}

/** Rows are already aggregated to a stable order/day/carrier/service key. */
export function parseShopifyShippingRows(
  payload: ShopifyQlResponse,
  storeCurrency = "USD",
): ShippingObservationInput[] {
  const errors = [
    ...(payload.errors ?? []).map((error) => error.message ?? "GraphQL error"),
    ...(payload.data?.shopifyqlQuery?.parseErrors ?? []).map((error) =>
      typeof error === "string"
        ? error
        : (error.message ?? "ShopifyQL parse error"),
    ),
  ];
  if (errors.length > 0)
    throw new Error(`Shopify Shipping query failed: ${errors.join("; ")}`);

  const rows = payload.data?.shopifyqlQuery?.tableData?.rows ?? [];
  return rows.flatMap((row) => {
    const orderRef = text(row.order_id) ?? text(row.order_name);
    const day = text(row.day);
    if (!orderRef || !day) return [];
    // Shopify documents shipping_label_costs as store-currency money. The
    // label currency is a grouping attribute and can differ on cross-border
    // purchases, so tagging the metric with it creates a false mismatch.
    const currency = storeCurrency.toUpperCase().slice(0, 3);
    const labelCurrency = (text(row.shipping_label_currency) ?? currency)
      .toUpperCase()
      .slice(0, 3);
    const carrier = text(row.shipping_carrier);
    const service = text(row.shipping_service);
    return [
      {
        source: ShippingCostSource.SHOPIFY_SHIPPING,
        externalId: [
          orderRef,
          day,
          carrier ?? "",
          service ?? "",
          labelCurrency,
        ].join("|"),
        externalOrderRef: orderRef,
        carrier,
        serviceLevel: service,
        currency,
        amount: text(row.shipping_label_costs) ?? "0.00",
        labelCount: Math.max(1, Number(row.shipping_labels ?? 1) || 1),
        observedAt: date(day, new Date(`${day}T00:00:00.000Z`)),
        sourceUpdatedAt: null,
      },
    ];
  });
}

export interface OrderReference {
  id: string;
  shopifyId: string;
  orderNumber: number;
  currency: string;
}

export function matchOrderReference(
  reference: string | null,
  orders: readonly OrderReference[],
): OrderReference | null {
  if (!reference) return null;
  const normalized = reference.trim();
  const numeric = normalized.replace(/^#/, "").match(/^\d+$/)?.[0] ?? null;
  return (
    orders.find((order) => order.shopifyId === normalized) ??
    orders.find(
      (order) =>
        order.shopifyId.endsWith(`/Order/${normalized}`) ||
        (numeric !== null && order.orderNumber === Number(numeric)),
    ) ??
    null
  );
}

function centsDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(cents));
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

interface SourceTotal {
  source: ShippingCostSource;
  cents: number;
  labels: number;
  newest: number;
}

/**
 * Never sum the same labels merely because two APIs can see them. Equal source
 * totals corroborate each other; conflicting totals choose the more complete
 * label count, then the newer observation, while preserving the conflict.
 */
export function selectCarrierTotal(
  observations: readonly {
    source: ShippingCostSource;
    amount: unknown;
    labelCount: number;
    observedAt: Date;
  }[],
): { selected: ShippingCostSource; cents: number; conflict: boolean } | null {
  const totals = new Map<ShippingCostSource, SourceTotal>();
  for (const observation of observations) {
    const current = totals.get(observation.source) ?? {
      source: observation.source,
      cents: 0,
      labels: 0,
      newest: 0,
    };
    current.cents += toCents(observation.amount as string);
    current.labels += observation.labelCount;
    current.newest = Math.max(current.newest, observation.observedAt.getTime());
    totals.set(observation.source, current);
  }
  const sources = [...totals.values()];
  if (sources.length === 0) return null;
  if (sources.length === 1)
    return {
      selected: sources[0]!.source,
      cents: sources[0]!.cents,
      conflict: false,
    };

  const conflict = new Set(sources.map((source) => source.cents)).size > 1;
  sources.sort(
    (a, b) =>
      b.labels - a.labels ||
      b.newest - a.newest ||
      (a.source === ShippingCostSource.SHIPSTATION ? -1 : 1),
  );
  return { selected: sources[0]!.source, cents: sources[0]!.cents, conflict };
}

export async function reconcileShippingObservations(
  shopId: string,
  inputs: readonly ShippingObservationInput[],
) {
  if (inputs.length === 0)
    return { observations: 0, matched: 0, conflicts: 0, ordersUpdated: 0 };
  const orders = await prisma.order.findMany({
    where: { shopId },
    select: { id: true, shopifyId: true, orderNumber: true, currency: true },
  });
  const affected = new Set<string>();
  let matched = 0;

  for (const input of inputs) {
    const order = matchOrderReference(input.externalOrderRef, orders);
    let status: ShippingObservationStatus = ShippingObservationStatus.UNMATCHED;
    let reason: string | null =
      "No Meridian order matched the provider reference.";
    if (input.voided) {
      status = ShippingObservationStatus.VOIDED;
      reason = "The provider reports this label as voided or refunded.";
    } else if (
      order &&
      order.currency.toUpperCase() !== input.currency.toUpperCase()
    ) {
      status = ShippingObservationStatus.CURRENCY_MISMATCH;
      reason = `Order currency ${order.currency} does not match carrier currency ${input.currency}.`;
    } else if (order) {
      status = ShippingObservationStatus.MATCHED;
      reason = null;
      matched++;
    }
    // Any update tied to an order can invalidate a cost that was applied by an
    // earlier observation (for example, a void or a newly detected currency
    // mismatch), so always recalculate that order from its current valid set.
    if (order) affected.add(order.id);

    await prisma.shippingCostObservation.upsert({
      where: {
        shopId_source_externalId: {
          shopId,
          source: input.source,
          externalId: input.externalId,
        },
      },
      create: {
        shopId,
        orderId: order?.id ?? null,
        source: input.source,
        externalId: input.externalId,
        externalOrderRef: input.externalOrderRef,
        carrier: input.carrier,
        serviceLevel: input.serviceLevel,
        currency: input.currency.toUpperCase(),
        amount: input.amount,
        labelCount: input.labelCount,
        observedAt: input.observedAt,
        sourceUpdatedAt: input.sourceUpdatedAt,
        status,
        discrepancyReason: reason,
      },
      update: {
        orderId: order?.id ?? null,
        externalOrderRef: input.externalOrderRef,
        carrier: input.carrier,
        serviceLevel: input.serviceLevel,
        currency: input.currency.toUpperCase(),
        amount: input.amount,
        labelCount: input.labelCount,
        observedAt: input.observedAt,
        sourceUpdatedAt: input.sourceUpdatedAt,
        status,
        discrepancyReason: reason,
      },
    });
  }

  let conflicts = 0;
  let ordersUpdated = 0;
  for (const orderId of affected) {
    const observations = await prisma.shippingCostObservation.findMany({
      where: { shopId, orderId, status: ShippingObservationStatus.MATCHED },
      select: {
        id: true,
        source: true,
        amount: true,
        labelCount: true,
        observedAt: true,
      },
    });
    const selected = selectCarrierTotal(observations);
    const fulfillments = await prisma.fulfillment.findMany({
      where: {
        shopId,
        orderId,
        status: { notIn: ["cancelled", "canceled", "error", "failure"] },
      },
      select: { id: true, itemCount: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (fulfillments.length === 0) {
      await prisma.shippingCostObservation.updateMany({
        where: { shopId, orderId, status: ShippingObservationStatus.MATCHED },
        data: {
          status: ShippingObservationStatus.UNMATCHED,
          discrepancyReason:
            "Order has no active fulfillment to receive carrier cost.",
        },
      });
      continue;
    }

    if (!selected) {
      await prisma.$transaction(
        fulfillments.map((fulfillment) =>
          prisma.fulfillment.update({
            where: { id: fulfillment.id },
            data: { shippingCost: "0.00" },
          }),
        ),
      );
      ordersUpdated++;
      continue;
    }

    if (selected.conflict) {
      conflicts++;
      await prisma.shippingCostObservation.updateMany({
        where: {
          shopId,
          orderId,
          source: { not: selected.selected },
          status: ShippingObservationStatus.MATCHED,
        },
        data: {
          status: ShippingObservationStatus.CONFLICT,
          discrepancyReason: `Conflicts with ${selected.selected}; preserved but excluded from order cost.`,
        },
      });
    }
    const shares = allocateTaxCents(
      selected.cents,
      fulfillments.map((fulfillment) => fulfillment.itemCount),
    );
    await prisma.$transaction(
      fulfillments.map((fulfillment, index) =>
        prisma.fulfillment.update({
          where: { id: fulfillment.id },
          data: { shippingCost: centsDecimal(shares[index] ?? 0) },
        }),
      ),
    );
    ordersUpdated++;
  }

  if (ordersUpdated > 0) await recomputeShopProfitability(shopId);
  return { observations: inputs.length, matched, conflicts, ordersUpdated };
}

const SHOPIFYQL_QUERY = `#graphql
  query MeridianShippingLabels($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData { rows }
      parseErrors
    }
  }
`;

export async function fetchShopifyShippingCosts(
  shopDomain: string,
  storeCurrency: string,
  since: Date,
  until: Date,
) {
  const query = [
    "FROM shipping_labels",
    "SHOW shipping_label_costs, shipping_labels",
    "GROUP BY order_id, order_name, shipping_carrier, shipping_service, shipping_label_currency, day",
    `SINCE ${since.toISOString().slice(0, 10)} UNTIL ${until.toISOString().slice(0, 10)}`,
    "ORDER BY day ASC LIMIT 10000",
  ].join(" ");
  const admin = await adminClientForShop(shopDomain);
  const response = await admin.graphql(SHOPIFYQL_QUERY, {
    variables: { query },
  });
  return parseShopifyShippingRows(
    (await response.json()) as ShopifyQlResponse,
    storeCurrency,
  );
}

const SHIPSTATION_PAGE_SIZE = 500;

async function fetchShipStationPages(
  apiKey: string,
  path: "labels" | "shipments",
  collection: "labels" | "shipments",
  parameters: Readonly<Record<string, string>>,
  fetcher: typeof fetch,
  shouldStop?: (pageValues: readonly JsonRecord[]) => boolean,
) {
  const values: JsonRecord[] = [];
  for (let page = 1; page <= 100; page++) {
    const url = new URL(`https://api.shipstation.com/v2/${path}`);
    for (const [key, value] of Object.entries(parameters))
      url.searchParams.set(key, value);
    url.searchParams.set("page_size", String(SHIPSTATION_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const response = await fetcher(url, {
      headers: { "API-Key": apiKey, Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`ShipStation ${path} returned HTTP ${response.status}`);
    const body = record(await response.json()) ?? {};
    const collectionValue = body[collection];
    const pageValues: JsonRecord[] = Array.isArray(collectionValue)
      ? collectionValue
          .map(record)
          .filter((value): value is JsonRecord => value !== null)
      : [];
    values.push(...pageValues);
    const pages = Number(body.pages ?? body.total_pages);
    if (
      pageValues.length === 0 ||
      shouldStop?.(pageValues) === true ||
      (Number.isFinite(pages) && pages > 0 && page >= pages) ||
      (!Number.isFinite(pages) && pageValues.length < SHIPSTATION_PAGE_SIZE)
    )
      break;
  }
  return values;
}

async function fetchShipStationShipmentReference(
  apiKey: string,
  shipmentId: string,
  fetcher: typeof fetch,
) {
  const response = await fetcher(
    `https://api.shipstation.com/v2/shipments/${encodeURIComponent(shipmentId)}`,
    { headers: { "API-Key": apiKey, Accept: "application/json" } },
  );
  if (!response.ok) return null;
  return (
    parseShipStationShipmentReferences({
      shipments: [await response.json()],
    }).get(shipmentId) ?? null
  );
}

export async function fetchShipStationCosts(
  encryptedApiKey: string,
  since: Date,
  fetcher: typeof fetch = fetch,
) {
  const apiKey = decryptSecret(encryptedApiKey);
  const shipments = await fetchShipStationPages(
    apiKey,
    "shipments",
    "shipments",
    {
      modified_at_start: since.toISOString(),
      sort_by: "modified_at",
      sort_dir: "asc",
    },
    fetcher,
  );
  const labels = await fetchShipStationPages(
    apiKey,
    "labels",
    "labels",
    {
      created_at_start: since.toISOString(),
      sort_by: "created_at",
      sort_dir: "asc",
    },
    fetcher,
  );

  // Created-at filters do not catch an old label voided today. Pull the newest
  // voids separately and retain only those inside the overlap window.
  const recentVoids = (
    await fetchShipStationPages(
      apiKey,
      "labels",
      "labels",
      {
        label_status: "voided",
        sort_by: "voided_at",
        sort_dir: "desc",
      },
      fetcher,
      (pageValues) =>
        pageValues.some((label) => {
          const voidedAt = text(label.voided_at);
          return (
            Boolean(voidedAt) &&
            date(voidedAt, new Date(0)).getTime() < since.getTime()
          );
        }),
    )
  ).filter((label) => {
    const voidedAt = text(label.voided_at);
    return voidedAt
      ? date(voidedAt, new Date(0)).getTime() >= since.getTime()
      : false;
  });

  const uniqueLabels = new Map<string, JsonRecord>();
  for (const label of [...labels, ...recentVoids]) {
    const labelId = text(label.label_id);
    if (labelId) uniqueLabels.set(labelId, label);
  }
  const references = parseShipStationShipmentReferences({ shipments });
  const missingShipmentIds = [
    ...new Set(
      [...uniqueLabels.values()].flatMap((label) => {
        const shipmentId = text(label.shipment_id);
        const explicit =
          text(label.external_shipment_id) ??
          text(label.shipment_number) ??
          text(label.external_order_id);
        return shipmentId && !explicit && !references.has(shipmentId)
          ? [shipmentId]
          : [];
      }),
    ),
  ];
  for (let offset = 0; offset < missingShipmentIds.length; offset += 10) {
    const ids = missingShipmentIds.slice(offset, offset + 10);
    const resolved = await Promise.all(
      ids.map((id) => fetchShipStationShipmentReference(apiKey, id, fetcher)),
    );
    ids.forEach((id, index) => {
      const reference = resolved[index];
      if (reference) references.set(id, reference);
    });
  }

  return parseShipStationLabels(
    { labels: [...uniqueLabels.values()] },
    new Date(),
    references,
  );
}

function sweepSince(connector: Connector, now: Date) {
  const anchor =
    connector.lastSyncedAt ?? new Date(now.getTime() - 30 * 86_400_000);
  return new Date(anchor.getTime() - 2 * 86_400_000);
}

type CarrierConnector = Connector & {
  shop: { domain: string; currency: string };
};

type CarrierReconciliationResult = Awaited<
  ReturnType<typeof reconcileShippingObservations>
>;

export const SHOPIFY_SHIPPING_PROTECTED_DATA_ERROR =
  "Shopify has not approved protected customer data for Shipping reports yet. In Partner Dashboard, request Level 2 access covering Name, Email, Phone, and Address, then retry this connection. ShopifyQL requires all four approvals; MyMeridian does not query or store shopper name, phone, or address.";

/**
 * Shopify's Admin client may attach the full HTTP response to a thrown error.
 * Never persist or log that object: response headers can contain short-lived
 * session material and add thousands of noisy characters to every sweep.
 */
export function isShopifyShippingProtectedDataError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("protected customer data") ||
      normalized.includes("protected customer fields") ||
      normalized.includes("level 2 protected")) &&
    (normalized.includes("not approved") ||
      normalized.includes("request access") ||
      normalized.includes("access denied") ||
      normalized.includes("requirements"))
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __meridianCarrierReconciliations:
    Map<string, Promise<CarrierReconciliationResult>> | undefined;
}

const carrierReconciliations = (globalThis.__meridianCarrierReconciliations ??=
  new Map());

async function performCarrierReconciliation(
  connector: CarrierConnector,
  now = new Date(),
) {
  const since = sweepSince(connector, now);
  const observations =
    connector.provider === ConnectorProvider.SHIPSTATION
      ? connector.accessTokenEnc
        ? await fetchShipStationCosts(connector.accessTokenEnc, since)
        : (() => {
            throw new Error("ShipStation connector has no encrypted API key");
          })()
      : connector.provider === ConnectorProvider.SHOPIFY_SHIPPING
        ? await fetchShopifyShippingCosts(
            connector.shop.domain,
            connector.shop.currency,
            since,
            now,
          )
        : (() => {
            throw new Error(`${connector.provider} is not a carrier connector`);
          })();
  const result = await reconcileShippingObservations(
    connector.shopId,
    observations,
  );
  await prisma.connector.update({
    where: { id: connector.id },
    data: { lastSyncedAt: now, lastError: null },
  });
  return result;
}

/** Collapse scheduler and webhook races to one provider read per connector. */
export async function reconcileCarrierConnector(
  connector: CarrierConnector,
  now = new Date(),
) {
  const existing = carrierReconciliations.get(connector.id);
  if (existing) return existing;
  const work = performCarrierReconciliation(connector, now);
  carrierReconciliations.set(connector.id, work);
  try {
    return await work;
  } finally {
    if (carrierReconciliations.get(connector.id) === work) {
      carrierReconciliations.delete(connector.id);
    }
  }
}

export async function reconcileConnectedCarriersForShop(
  shopId: string,
  now = new Date(),
) {
  const connectors = await prisma.connector.findMany({
    where: {
      shopId,
      status: ConnectorStatus.CONNECTED,
      provider: {
        in: [ConnectorProvider.SHIPSTATION, ConnectorProvider.SHOPIFY_SHIPPING],
      },
    },
    include: { shop: { select: { domain: true, currency: true } } },
  });
  await reconcileCarrierConnectors(connectors, now);
  return connectors.length;
}

async function reconcileCarrierConnectors(
  connectors: readonly CarrierConnector[],
  now: Date,
) {
  const results = await Promise.allSettled(
    connectors.map((connector) =>
      withConnectorWork(connector.id, "carrier-reconciliation", now, () =>
        reconcileCarrierConnector(connector, now),
      ),
    ),
  );
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    if (result.status === "fulfilled") continue;
    const connector = connectors[index]!;
    const protectedDataBlocked =
      connector.provider === ConnectorProvider.SHOPIFY_SHIPPING &&
      isShopifyShippingProtectedDataError(result.reason);
    const rawMessage =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    const message = protectedDataBlocked
      ? SHOPIFY_SHIPPING_PROTECTED_DATA_ERROR
      : rawMessage.slice(0, 1_000);
    await prisma.connector.update({
      where: { id: connector.id },
      data: {
        lastError: message,
        // Approval will not change the granted scope, so this connector must
        // stop sweeping until the merchant explicitly retries after approval.
        ...(protectedDataBlocked ? { status: ConnectorStatus.ERROR } : {}),
      },
    });
    const log = protectedDataBlocked ? console.warn : console.error;
    log(
      "[shipping:%s] %s: %s",
      connector.provider,
      connector.shop.domain,
      message,
    );
  }
}

/** Retry Shopify Shipping after the publisher's protected-data access changes. */
export async function retryShopifyShippingConnector(
  shopId: string,
  now = new Date(),
) {
  const connector = await prisma.connector.findUnique({
    where: {
      shopId_provider: { shopId, provider: ConnectorProvider.SHOPIFY_SHIPPING },
    },
    include: { shop: { select: { domain: true, currency: true } } },
  });
  if (!connector) {
    return {
      ok: false as const,
      message: "Shopify Shipping is not configured for this store.",
    };
  }

  await prisma.connector.update({
    where: { id: connector.id },
    data: { status: ConnectorStatus.CONNECTED, lastError: null },
  });
  await reconcileCarrierConnectors(
    [{ ...connector, status: ConnectorStatus.CONNECTED, lastError: null }],
    now,
  );
  const refreshed = await prisma.connector.findUnique({
    where: { id: connector.id },
    select: { status: true, lastError: true },
  });
  return refreshed?.status === ConnectorStatus.CONNECTED
    ? {
        ok: true as const,
        message: "Shopify Shipping cost reconciliation is active.",
      }
    : {
        ok: false as const,
        message:
          refreshed?.lastError ?? "Shopify Shipping could not be reconnected.",
      };
}

export async function runCarrierReconciliationSweep(now = new Date()) {
  const connectors = await prisma.connector.findMany({
    where: {
      status: ConnectorStatus.CONNECTED,
      provider: {
        in: [ConnectorProvider.SHIPSTATION, ConnectorProvider.SHOPIFY_SHIPPING],
      },
    },
    include: { shop: { select: { domain: true, currency: true } } },
  });
  await reconcileCarrierConnectors(connectors, now);
  return connectors.length;
}

export async function ensureShipStationWebhook(
  connector: Pick<
    Connector,
    "id" | "provider" | "accessTokenEnc" | "webhookId" | "webhookSecretEnc"
  >,
  appUrl: string,
  fetcher: typeof fetch = fetch,
) {
  if (
    connector.provider !== ConnectorProvider.SHIPSTATION ||
    !connector.accessTokenEnc
  ) {
    throw new Error(
      "A connected ShipStation credential is required to register its webhook.",
    );
  }
  const base = new URL(appUrl);
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(base.hostname)
  ) {
    throw new Error(
      "ShipStation webhook registration requires a public HTTPS app URL.",
    );
  }
  const apiKey = decryptSecret(connector.accessTokenEnc);
  const secret = connector.webhookSecretEnc
    ? decryptSecret(connector.webhookSecretEnc)
    : randomBytes(32).toString("base64url");
  const target = new URL(
    `/webhooks/shipstation/${encodeURIComponent(connector.id)}`,
    base,
  ).toString();
  const commonBody = {
    name: "MyMeridian carrier cost reconciliation",
    url: target,
    headers: [{ key: "X-Meridian-Webhook-Secret", value: secret }],
  };
  let webhookId = connector.webhookId;
  if (!webhookId) {
    const listed = await fetcher(
      "https://api.shipstation.com/v2/environment/webhooks",
      {
        headers: { "API-Key": apiKey, Accept: "application/json" },
      },
    );
    if (listed.ok) {
      const values = await listed.json();
      const existing = Array.isArray(values)
        ? values
            .map(record)
            .find(
              (value) =>
                text(value?.url) === target &&
                text(value?.event) === "fulfillment_shipped_v2",
            )
        : null;
      webhookId = text(existing?.webhook_id);
    }
  }

  const send = (existingId: string | null) =>
    fetcher(
      existingId
        ? `https://api.shipstation.com/v2/environment/webhooks/${encodeURIComponent(existingId)}`
        : "https://api.shipstation.com/v2/environment/webhooks",
      {
        method: existingId ? "PUT" : "POST",
        headers: {
          "API-Key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(
          existingId
            ? commonBody
            : { ...commonBody, event: "fulfillment_shipped_v2" },
        ),
      },
    );
  let response = await send(webhookId);
  if (webhookId && response.status === 404) {
    webhookId = null;
    response = await send(null);
  }
  if (!response.ok)
    throw new Error(
      `ShipStation webhook registration returned HTTP ${response.status}`,
    );
  const responseBody =
    response.status === 204 ? {} : (record(await response.json()) ?? {});
  webhookId = webhookId ?? text(responseBody.webhook_id);
  if (!webhookId)
    throw new Error("ShipStation webhook registration omitted webhook_id.");
  await prisma.connector.update({
    where: { id: connector.id },
    data: {
      webhookId,
      webhookSecretEnc: connector.webhookSecretEnc ?? encryptSecret(secret),
      webhookRegisteredAt: new Date(),
    },
  });
  return { webhookId, target };
}
