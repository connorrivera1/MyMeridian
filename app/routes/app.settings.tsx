import {
  Channel,
  ConnectorProvider,
  ConnectorStatus,
  CostRuleKind,
  CostRuleOrigin,
  SyncStatus,
} from "@prisma/client";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { Badge, Banner, Card, Stat } from "~/design/components";
import { withShopContext, type ShopContext } from "~/lib/auth.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";
import { backfillIsStale } from "~/lib/backfill-claim.server";
import { mailConfiguration } from "~/lib/mail.server";
import { nextWeeklyOccurrence } from "~/lib/merchant-notifications.server";
import {
  connectorOAuthConfigured,
  disconnectConnector,
} from "~/lib/connector-oauth.server";
import { planAllows, requireActivePlan } from "~/lib/plan.server";
import { enqueueShopRecompute } from "~/lib/recompute-queue.server";
import { retryShopCampaignsConnector } from "~/lib/ad-ingestion.server";
import { scopeReport } from "~/lib/scopes";
import { PLANS } from "~/lib/plans";
import { publicAppOrigin } from "~/lib/public-origin.server";
import { storeConnectorCredentials } from "~/integrations/ad-health.server";
import {
  ensureShipStationWebhook,
  retryShopifyShippingConnector,
} from "~/integrations/shipping.server";

function adChannelForConnector(provider: ConnectorProvider): Channel | null {
  switch (provider) {
    case ConnectorProvider.FACEBOOK_ADS:
      return Channel.FACEBOOK;
    case ConnectorProvider.GOOGLE_ADS:
      return Channel.GOOGLE;
    case ConnectorProvider.TIKTOK_ADS:
      return Channel.TIKTOK;
    default:
      return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, (ctx) => loadSettings(request, ctx));
}

async function loadSettings(request: Request, ctx: ShopContext) {
  const { shop } = ctx;
  const plan = await requireActivePlan(ctx, request);
  const staleBackfill = backfillIsStale(shop);
  const url = new URL(request.url);

  const [costRules, connectors, orderCount, productCount] = await Promise.all([
    prisma.costRule.findMany({
      where: { shopId: shop.id },
      orderBy: { kind: "asc" },
    }),
    prisma.connector.findMany({
      where: { shopId: shop.id },
      orderBy: { provider: "asc" },
    }),
    prisma.order.count({ where: { shopId: shop.id } }),
    prisma.product.count({ where: { shopId: shop.id } }),
  ]);

  return {
    shopName: shop.name,
    shopDomain: shop.domain,
    currency: shop.currency,
    timezone: shop.timezone,
    slaDays: shop.fulfillmentSlaDays,
    lastComputedAt: shop.lastComputedAt,
    isDemo: shop.isDemo,
    scopes: shop.isDemo
      ? []
      : scopeReport(
          shop.grantedScopes ?? process.env.SCOPES,
          process.env.SCOPES,
        ),
    sync: {
      status: shop.syncStatus,
      stage: shop.syncStage,
      // What Meridian actually holds, not the import counter — the counter
      // reads zero on a seeded store and during a re-import, which would
      // contradict the dashboard sitting next to it.
      orders: orderCount,
      products: productCount,
      error: shop.syncError,
      completedAt: shop.syncCompletedAt,
      earliestOrderAt: shop.earliestOrderAt,
      hasAllOrdersScope: shop.hasAllOrdersScope,
      isStale: staleBackfill,
      hasResumeCursor: Boolean(shop.syncCursor),
    },
    costRules: costRules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      label: rule.label,
      percentRate: rule.percentRate ? Number(rule.percentRate) : null,
      fixedPerOrder: rule.fixedPerOrder ? Number(rule.fixedPerOrder) : null,
      fixedPerItem: rule.fixedPerItem ? Number(rule.fixedPerItem) : null,
      monthlyAmount: rule.monthlyAmount ? Number(rule.monthlyAmount) : null,
      active: rule.active,
      origin: rule.origin,
      confirmedAt: rule.confirmedAt,
    })),
    connectors: connectors.map((connector) => ({
      provider: connector.provider,
      status: connector.status,
      displayName: connector.displayName,
      externalAccountId: connector.externalAccountId,
      availableAccounts: Array.isArray(connector.availableAccounts)
        ? connector.availableAccounts.flatMap((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value))
              return [];
            const account = value as Record<string, unknown>;
            return typeof account.id === "string"
              ? [
                  {
                    id: account.id,
                    name:
                      typeof account.name === "string" ? account.name : null,
                    currency:
                      typeof account.currency === "string"
                        ? account.currency
                        : null,
                  },
                ]
              : [];
          })
        : [],
      lastSyncedAt: connector.lastSyncedAt,
      lastError: connector.lastError,
      selfServeConfigured:
        connector.provider === ConnectorProvider.FACEBOOK_ADS
          ? connectorOAuthConfigured("meta")
          : connector.provider === ConnectorProvider.GOOGLE_ADS
            ? connectorOAuthConfigured("google")
            : connector.provider === ConnectorProvider.TIKTOK_ADS
              ? connectorOAuthConfigured("tiktok")
              : true,
    })),
    plan: plan.planId,
    reporting: {
      anomalyAlertsEnabled: shop.anomalyAlertsEnabled,
      weeklySummaryEnabled: shop.weeklySummaryEnabled,
      weeklySummaryEmail: shop.weeklySummaryEmail ?? shop.email ?? "",
      weeklySummaryDay: shop.weeklySummaryDay,
      lastWeeklySummaryAt: shop.lastWeeklySummaryAt,
      lastWeeklySummaryError: shop.lastWeeklySummaryError,
      mailConfigured: mailConfiguration().configured,
      canUseAlerts: planAllows(plan, "anomalyAlerts"),
      canUseWeekly: planAllows(plan, "scheduledReports"),
      canExport: planAllows(plan, "exports"),
      canUseConnections: planAllows(plan, "adConnections"),
      canUseCarrierConnections: planAllows(plan, "carrierConnections"),
    },
    connectionFeedback: url.searchParams.get("connection_error")
      ? { ok: false, message: url.searchParams.get("connection_error")! }
      : url.searchParams.get("connected")
        ? {
            ok: true,
            message: `${url.searchParams.get("connected")} connected. Initial spend sync is queued.`,
          }
        : null,
  };
}

const CostRuleUpdate = z
  .object({
    id: z.string().min(1),
    percentRate: z.coerce.number().min(0).max(1).optional(),
    fixedPerOrder: z.coerce.number().min(0).max(100_000).optional(),
    fixedPerItem: z.coerce.number().min(0).max(100_000).optional(),
    monthlyAmount: z.coerce.number().min(0).max(10_000_000).optional(),
  })
  .refine(
    (value) =>
      value.percentRate !== undefined ||
      value.fixedPerOrder !== undefined ||
      value.fixedPerItem !== undefined ||
      value.monthlyAmount !== undefined,
    { message: "A cost value is required." },
  );

function valuesForRuleKind(
  kind: CostRuleKind,
  input: z.infer<typeof CostRuleUpdate>,
): Record<string, string> | null {
  switch (kind) {
    case CostRuleKind.PAYMENT_FEE:
      return input.percentRate !== undefined &&
        input.fixedPerOrder !== undefined
        ? {
            percentRate: input.percentRate.toFixed(5),
            fixedPerOrder: input.fixedPerOrder.toFixed(4),
          }
        : null;
    case CostRuleKind.SHIPPING_DEFAULT:
      return input.fixedPerOrder !== undefined
        ? { fixedPerOrder: input.fixedPerOrder.toFixed(4) }
        : null;
    case CostRuleKind.PICK_PACK:
      return input.fixedPerOrder !== undefined &&
        input.fixedPerItem !== undefined
        ? {
            fixedPerOrder: input.fixedPerOrder.toFixed(4),
            fixedPerItem: input.fixedPerItem.toFixed(4),
          }
        : null;
    case CostRuleKind.OVERHEAD_MONTHLY:
      return input.monthlyAmount !== undefined
        ? { monthlyAmount: input.monthlyAmount.toFixed(2) }
        : null;
    case CostRuleKind.CUSTOM:
      return null;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  return withShopContext(request, (ctx) => updateSettings(request, ctx));
}

async function updateSettings(request: Request, ctx: ShopContext) {
  await requireRecentReauthentication(request, ctx.user);
  const plan = await requireActivePlan(ctx, request);
  const { shop, admin } = ctx;
  const form = await request.formData();

  if (form.get("intent") === "reporting") {
    const anomalyAlertsEnabled = form.get("anomalyAlertsEnabled") === "on";
    const weeklySummaryEnabled = form.get("weeklySummaryEnabled") === "on";
    const weeklySummaryEmail = String(
      form.get("weeklySummaryEmail") ?? "",
    ).trim();
    const weeklySummaryDay = Number(form.get("weeklySummaryDay") ?? 1);
    if (weeklySummaryEnabled && !planAllows(plan, "scheduledReports")) {
      return { ok: false, message: "Weekly summaries require the Scale plan." };
    }
    if (anomalyAlertsEnabled && !planAllows(plan, "anomalyAlerts")) {
      return {
        ok: false,
        message: "Profit anomaly alerts require Growth or Scale.",
      };
    }
    if (
      weeklySummaryEnabled &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(weeklySummaryEmail)
    ) {
      return { ok: false, message: "Enter a valid report email address." };
    }
    if (
      !Number.isInteger(weeklySummaryDay) ||
      weeklySummaryDay < 0 ||
      weeklySummaryDay > 6
    ) {
      return { ok: false, message: "Choose a valid summary day." };
    }
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        anomalyAlertsEnabled: planAllows(plan, "anomalyAlerts")
          ? anomalyAlertsEnabled
          : false,
        weeklySummaryEnabled: planAllows(plan, "scheduledReports")
          ? weeklySummaryEnabled
          : false,
        weeklySummaryEmail: weeklySummaryEmail || null,
        weeklySummaryDay,
        nextWeeklySummaryAt: weeklySummaryEnabled
          ? nextWeeklyOccurrence(weeklySummaryDay)
          : null,
        lastWeeklySummaryError: null,
      },
    });
    return { ok: true, message: "Reporting preferences saved." };
  }

  if (form.get("intent") === "shipstation-connect") {
    if (!planAllows(plan, "carrierConnections")) {
      return { ok: false, message: "ShipStation requires Growth or Scale." };
    }
    const apiKey = String(form.get("apiKey") ?? "").trim();
    if (apiKey.length < 10 || apiKey.length > 1_000) {
      return { ok: false, message: "Enter a valid ShipStation API key." };
    }
    try {
      const connector = await storeConnectorCredentials({
        shopId: shop.id,
        provider: ConnectorProvider.SHIPSTATION,
        accessToken: apiKey,
      });
      await ensureShipStationWebhook(connector, publicAppOrigin(request));
      return {
        ok: true,
        message: "ShipStation connected and its cost webhook is active.",
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ShipStation setup failed.";
      await prisma.connector.updateMany({
        where: { shopId: shop.id, provider: ConnectorProvider.SHIPSTATION },
        data: {
          status: ConnectorStatus.ERROR,
          lastError: message.slice(0, 1_000),
        },
      });
      return { ok: false, message };
    }
  }

  if (form.get("intent") === "select-connector-account") {
    const provider = String(form.get("provider") ?? "") as ConnectorProvider;
    const externalAccountId = String(form.get("externalAccountId") ?? "");
    const connector = await prisma.connector.findFirst({
      where: { shopId: shop.id, provider },
    });
    const accounts = Array.isArray(connector?.availableAccounts)
      ? connector.availableAccounts
      : [];
    const selected = accounts.find((value) => {
      return (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).id === externalAccountId
      );
    }) as Record<string, unknown> | undefined;
    if (!connector || !selected) {
      return {
        ok: false,
        message: "That ad account is not authorized for this connection.",
      };
    }
    if (connector.externalAccountId === externalAccountId) {
      return { ok: true, message: "That ad account is already selected." };
    }
    const channel = adChannelForConnector(connector.provider);
    if (!channel) {
      return { ok: false, message: "That connection does not support ad-account selection." };
    }
    // Spend is keyed to the store and channel, rather than the connector id.
    // Retaining it after the merchant selects another advertiser would blend
    // two accounts into one profitability result. Clear both the reporting
    // rows and their sync ledger atomically, then let the scheduler import the
    // newly chosen account from a clean horizon.
    await prisma.$transaction([
      prisma.adSpend.deleteMany({ where: { shopId: shop.id, channel } }),
      prisma.adSyncWindow.deleteMany({ where: { connectorId: connector.id } }),
      prisma.connector.update({
        where: { id: connector.id },
        data: {
          externalAccountId,
          displayName: typeof selected.name === "string" ? selected.name : null,
          accountCurrency:
            typeof selected.currency === "string" ? selected.currency : null,
          lastSyncedAt: null,
          lastDeepSyncAt: null,
          lastError: null,
        },
      }),
    ]);
    invalidateAnalyticsCache();
    await enqueueShopRecompute(shop.id, "ad_account_changed");
    return {
      ok: true,
      message: "Ad account changed. Previous-account spend was cleared and a fresh sync is queued.",
    };
  }

  if (form.get("intent") === "disconnect") {
    const provider = String(form.get("provider") ?? "") as ConnectorProvider;
    if (
      !new Set<ConnectorProvider>([
        ConnectorProvider.FACEBOOK_ADS,
        ConnectorProvider.GOOGLE_ADS,
        ConnectorProvider.TIKTOK_ADS,
        ConnectorProvider.SHIPSTATION,
      ]).has(provider)
    ) {
      return {
        ok: false,
        message: "That data source cannot be disconnected here.",
      };
    }
    try {
      const disconnected = await disconnectConnector({
        shopId: shop.id,
        provider,
      });
      return {
        ok: true,
        message: disconnected.remoteRevoked
          ? "Connection removed and provider access revoked."
          : "Local credentials removed. The provider did not confirm remote revocation; remove MyMeridian in that provider too.",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Disconnect failed.",
      };
    }
  }

  if (form.get("intent") === "resync") {
    if (!admin) {
      return {
        ok: false,
        message:
          "Re-import needs a live Shopify session. The demo store has no store to read from.",
      };
    }

    const { requestBackfill } = await import("~/lib/backfill-queue.server");
    const started = await requestBackfill(shop.id);

    if (!started.started) {
      return {
        ok: false,
        message:
          "An import is already active. This request did not start another one.",
      };
    }

    return {
      ok: true,
      message: started.resumed
        ? "Interrupted import resumed from its saved order-history checkpoint."
        : "Import started. Progress appears at the top of the page.",
    };
  }

  if (form.get("intent") === "recompute") {
    await enqueueShopRecompute(shop.id, "merchant_requested");
    return {
      ok: true,
      message:
        "Profit recomputation is queued and will continue in the background.",
    };
  }

  if (form.get("intent") === "retry-shopify-shipping") {
    return retryShopifyShippingConnector(shop.id);
  }

  if (form.get("intent") === "retry-shop-campaigns") {
    return retryShopCampaignsConnector(shop.id);
  }

  const parsed = CostRuleUpdate.safeParse({
    id: form.get("id"),
    percentRate: form.get("percentRate") || undefined,
    fixedPerOrder: form.get("fixedPerOrder") || undefined,
    fixedPerItem: form.get("fixedPerItem") || undefined,
    monthlyAmount: form.get("monthlyAmount") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, message: "Those figures don't look right." };
  }

  // Scoped to the shop so an id from elsewhere cannot be edited.
  const rule = await prisma.costRule.findFirst({
    where: { id: parsed.data.id, shopId: shop.id, active: true },
  });
  if (!rule) return { ok: false, message: "Cost rule not found." };

  const values = valuesForRuleKind(rule.kind, parsed.data);
  if (!values) {
    return {
      ok: false,
      message: "That cost rule is missing a required figure.",
    };
  }

  await prisma.costRule.update({
    where: { id: rule.id },
    data: {
      ...values,
      // A saved card is durable evidence that the merchant reviewed the
      // current assumption. Keep `origin` unchanged so an install default does
      // not lose its provenance merely because it has been confirmed.
      confirmedAt: new Date(),
    },
  });

  // A changed cost rule invalidates every materialised profit figure.
  await enqueueShopRecompute(shop.id, "cost_rule_changed");
  invalidateAnalyticsCache();

  return {
    ok: true,
    message: "Saved. Profit recomputation is queued in the background.",
  };
}

const CONNECTOR_LABEL: Record<string, string> = {
  SHOPIFY: "Shopify",
  FACEBOOK_ADS: "Meta Ads",
  GOOGLE_ADS: "Google Ads",
  TIKTOK_ADS: "TikTok Ads",
  SHOPIFY_SHOP_CAMPAIGNS: "Shop Campaigns",
  STRIPE: "Stripe",
  WAREHOUSE_3PL: "3PL / warehouse",
  SHIPSTATION: "ShipStation",
  SHOPIFY_SHIPPING: "Shopify Shipping",
};

const CONNECTOR_SLUG: Partial<Record<ConnectorProvider, string>> = {
  [ConnectorProvider.FACEBOOK_ADS]: "meta",
  [ConnectorProvider.GOOGLE_ADS]: "google",
  [ConnectorProvider.TIKTOK_ADS]: "tiktok",
};

const CONNECTOR_PURPOSE: Record<string, string> = {
  SHOPIFY: "Orders, products and fulfilments",
  FACEBOOK_ADS: "Ad spend and campaign attribution",
  GOOGLE_ADS: "Ad spend and campaign attribution",
  TIKTOK_ADS: "Ad spend and campaign attribution",
  SHOPIFY_SHOP_CAMPAIGNS:
    "Shopify-reported Shop Campaign spend and campaign metrics",
  STRIPE:
    "Unavailable in this release; processing uses the configured fee model",
  WAREHOUSE_3PL:
    "Unavailable in this release; fulfilment uses recorded costs or configured fallbacks",
  SHIPSTATION: "Carrier label costs reconciled to Shopify orders",
  SHOPIFY_SHIPPING:
    "Shopify Shipping label costs reconciled through the reports API",
};

export interface DisplayCostRule {
  percentRate: number | null;
  fixedPerOrder: number | null;
  fixedPerItem: number | null;
  monthlyAmount: number | null;
  active: boolean;
  origin: CostRuleOrigin;
  confirmedAt: Date | string | null;
}

export function ruleHasNonZeroValue(
  rule: DisplayCostRule | undefined,
): boolean {
  if (!rule?.active) return false;
  return [
    rule.percentRate,
    rule.fixedPerOrder,
    rule.fixedPerItem,
    rule.monthlyAmount,
  ].some((value) => value !== null && value !== 0);
}

export function ruleNeedsConfirmation(
  rule: DisplayCostRule | undefined,
): boolean {
  return ruleHasNonZeroValue(rule) && rule?.confirmedAt == null;
}

function CostRuleState({ rule }: { rule: DisplayCostRule | undefined }) {
  if (!rule?.active) return <Badge tone="critical">Missing</Badge>;
  if (!ruleHasNonZeroValue(rule))
    return <Badge tone="neutral">No Cost Applied</Badge>;
  if (rule.confirmedAt) return <Badge tone="good">Merchant-Confirmed Estimate</Badge>;

  return (
    <Badge tone="warning" dot>
      {rule.origin === CostRuleOrigin.INSTALL_DEFAULT
        ? "Unconfirmed Install Default"
        : "Configured Estimate"}
    </Badge>
  );
}

export function backfillControlFor(sync: {
  status: SyncStatus;
  isStale: boolean;
  hasResumeCursor: boolean;
}) {
  if (sync.status === SyncStatus.RUNNING && !sync.isStale) {
    return {
      buttonLabel: "Importing…",
      statusLabel: "Importing",
      disabled: true,
      recoveryCopy: null,
    };
  }

  if (sync.status === SyncStatus.RUNNING && sync.isStale) {
    return {
      buttonLabel: sync.hasResumeCursor ? "Resume Import" : "Restart Import",
      statusLabel: "Interrupted",
      disabled: false,
      recoveryCopy: sync.hasResumeCursor
        ? "The previous import's server claim expired. Resume from its saved order-history checkpoint."
        : "The previous import's server claim expired before it saved an order-history checkpoint. Restart it safely.",
    };
  }

  if (sync.status === SyncStatus.FAILED) {
    return {
      buttonLabel: sync.hasResumeCursor ? "Resume Import" : "Retry Import",
      statusLabel: "Stopped Early",
      disabled: false,
      recoveryCopy: sync.hasResumeCursor
        ? "A saved order-history checkpoint is ready. Resume without re-reading completed pages."
        : null,
    };
  }

  if (sync.status === SyncStatus.COMPLETE) {
    return {
      buttonLabel: "Re-Import",
      statusLabel: "Up to Date",
      disabled: false,
      recoveryCopy: null,
    };
  }

  return {
    buttonLabel: "Start Import",
    statusLabel: "Not Started",
    disabled: false,
    recoveryCopy: null,
  };
}

export function BackfillButton({
  control,
  busy,
}: {
  control: ReturnType<typeof backfillControlFor>;
  busy: boolean;
}) {
  return (
    <button
      className="btn sm"
      name="intent"
      value="resync"
      disabled={busy || control.disabled}
    >
      {control.buttonLabel}
    </button>
  );
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const rule = (kind: CostRuleKind) =>
    data.costRules.find(
      (candidate) => candidate.kind === kind && candidate.active,
    );

  const payment = rule(CostRuleKind.PAYMENT_FEE);
  const shipping = rule(CostRuleKind.SHIPPING_DEFAULT);
  const pickPack = rule(CostRuleKind.PICK_PACK);
  const overhead = rule(CostRuleKind.OVERHEAD_MONTHLY);
  const unconfirmedAppliedRules = [
    payment,
    shipping,
    pickPack,
    overhead,
  ].filter(ruleNeedsConfirmation);
  const backfillControl = backfillControlFor(data.sync);

  return (
    <>
      {data.connectionFeedback?.message && (
        <Banner tone={data.connectionFeedback.ok ? "neutral" : "warn"}>
          {data.connectionFeedback.message}
        </Banner>
      )}
      {result?.message && (
        <Banner tone={result.ok ? "neutral" : "warn"}>{result.message}</Banner>
      )}

      <Banner tone={unconfirmedAppliedRules.length > 0 ? "warn" : "neutral"}>
        {unconfirmedAppliedRules.length > 0 ? (
          <>
            {unconfirmedAppliedRules.length} active cost{" "}
            {unconfirmedAppliedRules.length === 1
              ? "assumption is"
              : "assumptions are"}{" "}
            still unconfirmed. Review and save each corresponding card so the
            audit trail records your acknowledgement; affected orders remain
            amber while they use an assumption rather than measured cost data.
          </>
        ) : (
          <>
            All active, non-zero cost assumptions have been reviewed. A reviewed
            fallback is still an assumption. This release has no Stripe or 3PL
            connector to replace fee and fulfilment models automatically;
            affected orders remain amber.
          </>
        )}
      </Banner>

      <div className="grid cols-2">
        <Card
          title="Payment Processing"
          hint="Charged on the full captured amount including tax and shipping. Processors do not refund their fee when you refund an order, and Meridian models it that way."
          actions={<CostRuleState rule={payment} />}
        >
          <Form method="post" className="stack">
            <input type="hidden" name="id" value={payment?.id} />
            <Field
              label="Percentage Rate"
              name="percentRate"
              defaultValue={payment?.percentRate ?? 0.029}
              step="0.00001"
              suffix={`= ${((payment?.percentRate ?? 0) * 100).toFixed(2)}%`}
            />
            <Field
              label="Fixed Per Order"
              name="fixedPerOrder"
              defaultValue={payment?.fixedPerOrder ?? 0.3}
              step="0.01"
              prefix="$"
            />
            <button className="btn primary" disabled={busy}>
              Save and Reprofile
            </button>
          </Form>
        </Card>

        <Card
          title="Shipping"
          hint="Used when a shipment has no measured Shopify Shipping or ShipStation label cost. Review the fallback as an assumption; affected orders remain amber."
          actions={<CostRuleState rule={shipping} />}
        >
          <Form method="post" className="stack">
            <input type="hidden" name="id" value={shipping?.id} />
            <Field
              label="Estimated Cost Per Order"
              name="fixedPerOrder"
              defaultValue={shipping?.fixedPerOrder ?? 8.5}
              step="0.01"
              prefix="$"
            />
            <button className="btn primary" disabled={busy}>
              Save and Reprofile
            </button>
          </Form>
        </Card>

        <Card
          title="Pick, Pack And Materials"
          actions={<CostRuleState rule={pickPack} />}
        >
          <Form method="post" className="stack">
            <input type="hidden" name="id" value={pickPack?.id} />
            <Field
              label="Per Order"
              name="fixedPerOrder"
              defaultValue={pickPack?.fixedPerOrder ?? 1.75}
              step="0.01"
              prefix="$"
            />
            <Field
              label="Per Item"
              name="fixedPerItem"
              defaultValue={pickPack?.fixedPerItem ?? 0.35}
              step="0.01"
              prefix="$"
            />
            <button className="btn primary" disabled={busy}>
              Save and Reprofile
            </button>
          </Form>
        </Card>

        <Card
          title="Fixed Monthly Overhead"
          hint="Rent, salaries, software — anything you pay whether or not you sell. Amortised evenly across each month's orders, to the cent."
          actions={<CostRuleState rule={overhead} />}
        >
          <Form method="post" className="stack">
            <input type="hidden" name="id" value={overhead?.id} />
            <Field
              label="Monthly Amount"
              name="monthlyAmount"
              defaultValue={overhead?.monthlyAmount ?? 0}
              step="0.01"
              prefix="$"
            />
            <button className="btn primary" disabled={busy}>
              Save and Reprofile
            </button>
          </Form>
        </Card>
      </div>

      <Card
        title="Shopify Data"
        hint={
          data.isDemo
            ? "This is the seeded demo store. Install Meridian on a real store to import live data."
            : "Order and product history imported from the Admin API. Webhooks keep it current from here; re-import to backfill again."
        }
        actions={
          !data.isDemo && (
            <Form method="post">
              <BackfillButton control={backfillControl} busy={busy} />
            </Form>
          )
        }
      >
        <div className="grid cols-4">
          <Stat
            small
            label="Import Status"
            value={
              <span className="secondary">
                {data.isDemo ? "Seeded" : backfillControl.statusLabel}
              </span>
            }
            meta={<span>{data.sync.stage ?? ""}</span>}
          />
          <Stat
            small
            label="Orders Held"
            value={
              <span className="num">{data.sync.orders.toLocaleString()}</span>
            }
          />
          <Stat
            small
            label="Products Held"
            value={
              <span className="num">{data.sync.products.toLocaleString()}</span>
            }
          />
          <Stat
            small
            label="History Reaches"
            value={
              <span className="secondary">
                {data.sync.earliestOrderAt
                  ? new Date(data.sync.earliestOrderAt).toLocaleDateString(
                      "en-US",
                      {
                        timeZone: data.timezone,
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      },
                    )
                  : "—"}
              </span>
            }
            meta={
              !data.isDemo && !data.sync.hasAllOrdersScope ? (
                <span>Capped at 60 Days Without read_all_orders</span>
              ) : undefined
            }
          />
        </div>
        {data.sync.error && (
          <p className="card-hint" style={{ marginTop: 10 }}>
            Last error: {data.sync.error}
          </p>
        )}
        {backfillControl.recoveryCopy && (
          <p className="card-hint" style={{ marginTop: 10 }}>
            {backfillControl.recoveryCopy}
          </p>
        )}
      </Card>

      {data.scopes.length > 0 && (
        <Card
        title="Data Access"
          hint="What this store authorised at install. Meridian only requests fields it is allowed to read — a missing permission removes a feature, it does not produce a wrong number."
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Permission</th>
                  <th>What It Provides</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.scopes.map((entry) => (
                  <tr key={entry.scope}>
                    <td className="primary-cell">
                      {entry.label}
                      <div className="cell-sub">
                        <code>{entry.scope}</code>
                        {entry.protectedData && " · protected customer data"}
                      </div>
                    </td>
                    <td className="secondary tiny" style={{ maxWidth: 460 }}>
                      {entry.unlocks}
                    </td>
                    <td>
                      {entry.granted ? (
                        <Badge tone="good">Granted</Badge>
                      ) : entry.essential ? (
                        <Badge tone="critical">Missing</Badge>
                      ) : (
                        <Badge tone="warning">Not Granted</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.scopes.some((s) => !s.granted) && (
            <p className="card-hint" style={{ padding: "12px 16px 14px" }}>
              A missing permission cannot be enabled from this screen. Contact{" "}
              <a href="/support">Support</a>; Shopify will ask you to
              re-authorise only when an approved app update adds the required
              access. Protected customer-data permissions, including order
              access, also require approval obtained by the app publisher.
            </p>
          )}
        </Card>
      )}

      <Card
        title="Connections"
        hint="Connect measured ad spend and carrier label costs without sending credentials to support. Shop Campaigns uses Shopify reports when the app has the required approval. Tokens are encrypted at rest and removed on disconnect; Stripe and 3PL sources remain unavailable."
        actions={
          <Form method="post">
            <button
              className="btn sm"
              name="intent"
              value="recompute"
              disabled={busy}
            >
              {busy ? "Recomputing…" : "Recompute All"}
            </button>
          </Form>
        }
        flush
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Source</th>
                <th>What It Provides</th>
                <th>Status</th>
                <th>Last Sync</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.connectors.map((connector) => (
                <tr key={connector.provider}>
                  <td className="primary-cell">
                    {CONNECTOR_LABEL[connector.provider] ?? connector.provider}
                    {connector.displayName && (
                      <div className="cell-sub">{connector.displayName}</div>
                    )}
                  </td>
                  <td className="secondary tiny">
                    {CONNECTOR_PURPOSE[connector.provider]}
                  </td>
                  <td>
                    {connector.status === ConnectorStatus.CONNECTED ? (
                      <Badge tone="good">Connected</Badge>
                    ) : connector.status === ConnectorStatus.DISCONNECTED ? (
                      <Badge tone="critical">Disconnected</Badge>
                    ) : connector.status === ConnectorStatus.ERROR ? (
                      <Badge tone="critical">Needs Attention</Badge>
                    ) : (
                      <Badge tone="neutral">Not Connected</Badge>
                    )}
                    {connector.lastError && (
                      <div className="cell-sub">{connector.lastError}</div>
                    )}
                  </td>
                  <td className="tiny muted">
                    {connector.lastSyncedAt
                      ? new Date(connector.lastSyncedAt).toLocaleDateString(
                          "en-US",
                          {
                            timeZone: data.timezone,
                            month: "short",
                            day: "numeric",
                          },
                        )
                      : "—"}
                  </td>
                  <td>
                    {connector.status === ConnectorStatus.CONNECTED &&
                    new Set<ConnectorProvider>([
                      ConnectorProvider.FACEBOOK_ADS,
                      ConnectorProvider.GOOGLE_ADS,
                      ConnectorProvider.TIKTOK_ADS,
                      ConnectorProvider.SHIPSTATION,
                    ]).has(connector.provider as ConnectorProvider) ? (
                      <div className="stack" style={{ gap: 6 }}>
                        {connector.availableAccounts.length > 1 && (
                          <Form
                            method="post"
                            className="row"
                            style={{ gap: 6 }}
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="select-connector-account"
                            />
                            <input
                              type="hidden"
                              name="provider"
                              value={connector.provider}
                            />
                            <select
                              className="field-input"
                              name="externalAccountId"
                              defaultValue={connector.externalAccountId ?? ""}
                            >
                              {connector.availableAccounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.name ?? account.id}
                                </option>
                              ))}
                            </select>
                            <button className="btn sm" disabled={busy}>
                              Use
                            </button>
                          </Form>
                        )}
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="disconnect"
                          />
                          <input
                            type="hidden"
                            name="provider"
                            value={connector.provider}
                          />
                          <button className="btn sm" disabled={busy}>
                            Disconnect
                          </button>
                        </Form>
                      </div>
                    ) : connector.provider === ConnectorProvider.FACEBOOK_ADS ||
                      connector.provider === ConnectorProvider.GOOGLE_ADS ||
                      connector.provider === ConnectorProvider.TIKTOK_ADS ? (
                      connector.selfServeConfigured ? (
                        <Form
                          method="post"
                          action={`/app/connections/${CONNECTOR_SLUG[connector.provider]}/start`}
                        >
                          <button
                            className="btn sm"
                            disabled={busy || !data.reporting.canUseConnections}
                          >
                            {connector.status === ConnectorStatus.ERROR ||
                            connector.status === ConnectorStatus.DISCONNECTED
                              ? "Reconnect"
                              : "Connect"}
                          </button>
                        </Form>
                      ) : (
                        <span className="tiny muted">
                          Awaiting Provider App Approval
                        </span>
                      )
                    ) : connector.provider ===
                        ConnectorProvider.SHOPIFY_SHIPPING &&
                      connector.status === ConnectorStatus.ERROR ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="retry-shopify-shipping"
                        />
                        <button className="btn sm" disabled={busy}>
                          Retry
                        </button>
                      </Form>
                    ) : connector.provider ===
                        ConnectorProvider.SHOPIFY_SHOP_CAMPAIGNS &&
                      connector.status === ConnectorStatus.ERROR ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="retry-shop-campaigns"
                        />
                        <button className="btn sm" disabled={busy}>
                          Retry After Shopify Approval
                        </button>
                      </Form>
                    ) : connector.provider === ConnectorProvider.SHIPSTATION ? (
                      <span className="tiny muted">
                        Use the Secure Key Form Below
                      </span>
                    ) : (
                      <span className="tiny muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <Form
            method="post"
            className="row"
            style={{ gap: 10, flexWrap: "wrap" }}
          >
            <input type="hidden" name="intent" value="shipstation-connect" />
            <label className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
              <span className="tiny muted">ShipStation API Key</span>
              <input
                className="field-input"
                type="password"
                name="apiKey"
                autoComplete="off"
                placeholder="Not Stored in the Browser"
                disabled={!data.reporting.canUseCarrierConnections}
              />
            </label>
            <button
              className="btn sm"
              disabled={busy || !data.reporting.canUseCarrierConnections}
            >
              Connect ShipStation
            </button>
          </Form>
        </div>
      </Card>

      <Card
        title="Reports And Alerts"
        hint="MyMeridian monitors qualified profit inputs daily. Scale can also send a weekly summary and export order-level figures for an accountant."
        actions={
          data.reporting.canExport ? (
            <a className="btn sm" href="/app/export/profit.csv">
              Export Profit CSV
            </a>
          ) : (
            <a className="btn sm" href="/app/plan">
              Scale Features
            </a>
          )
        }
      >
        {!data.reporting.mailConfigured && (
          <Banner tone="warn">
            Email delivery is not active on this deployment yet. Preferences are
            saved, but the operator must configure the verified sending domain
            before any message can leave MyMeridian.
          </Banner>
        )}
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="reporting" />
          <label className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              name="anomalyAlertsEnabled"
              defaultChecked={data.reporting.anomalyAlertsEnabled}
              disabled={!data.reporting.canUseAlerts}
            />
            <span>
              <strong>Profit Anomaly Alerts</strong>
              <span className="cell-sub">
                Margin drops, refund spikes, carrier-cost drift, missing COGS
                and unhealthy data sources. Growth or Scale.
              </span>
            </span>
          </label>
          <label className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              name="weeklySummaryEnabled"
              defaultChecked={data.reporting.weeklySummaryEnabled}
              disabled={!data.reporting.canUseWeekly}
            />
            <span>
              <strong>Weekly Profit Summary</strong>
              <span className="cell-sub">
                Current week, prior-week change and missing-cost disclosure.
                Scale.
              </span>
            </span>
          </label>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <label className="stack" style={{ gap: 4, flex: "1 1 240px" }}>
              <span className="tiny muted">Report Email</span>
              <input
                className="field-input"
                type="email"
                name="weeklySummaryEmail"
                defaultValue={data.reporting.weeklySummaryEmail}
                disabled={!data.reporting.canUseWeekly}
              />
            </label>
            <label className="stack" style={{ gap: 4 }}>
              <span className="tiny muted">Send Day</span>
              <select
                className="field-input"
                name="weeklySummaryDay"
                defaultValue={data.reporting.weeklySummaryDay}
                disabled={!data.reporting.canUseWeekly}
              >
                {[
                  [1, "Monday"],
                  [2, "Tuesday"],
                  [3, "Wednesday"],
                  [4, "Thursday"],
                  [5, "Friday"],
                  [6, "Saturday"],
                  [0, "Sunday"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {data.reporting.lastWeeklySummaryAt && (
            <p className="tiny muted">
              Last sent{" "}
              {new Date(data.reporting.lastWeeklySummaryAt).toLocaleString()}.
            </p>
          )}
          {data.reporting.lastWeeklySummaryError && (
            <p className="tiny negative">
              Last delivery failed: {data.reporting.lastWeeklySummaryError}
            </p>
          )}
          <button className="btn primary" disabled={busy}>
            Save Reporting Preferences
          </button>
        </Form>
      </Card>

      <Card
        title="Plan"
        hint="Billed by Shopify and shown on your Shopify invoice. Meridian never sees a card number."
        actions={
          <a className="btn sm" href="/app/plan">
            {data.plan ? "Change Plan" : "Choose a Plan"}
          </a>
        }
      >
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          {data.plan ? (
            <>
              <Badge tone="good">{PLANS[data.plan].name}</Badge>
              <span className="tiny muted">
                ${PLANS[data.plan].price}/month · {PLANS[data.plan].blurb}
              </span>
            </>
          ) : (
            <span className="tiny muted">
              No active plan. Every feature is unavailable until one is chosen.
            </span>
          )}
        </div>
      </Card>

      <Card title="Store">
        <div className="grid cols-4">
          <Stat
            small
            label="Domain"
            value={<span className="tiny">{data.shopDomain}</span>}
          />
          <Stat small label="Currency" value={data.currency} />
          <Stat
            small
            label="Timezone"
            value={<span className="tiny">{data.timezone}</span>}
          />
          <Stat
            small
            label="Last Computed"
            value={
              <span className="tiny">
                {data.lastComputedAt
                  ? new Date(data.lastComputedAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : "never"}
              </span>
            }
          />
        </div>
      </Card>
    </>
  );
}

function Field({
  label,
  name,
  defaultValue,
  step,
  prefix,
  suffix,
}: {
  label: string;
  name: string;
  defaultValue: number;
  step: string;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="tiny muted">{label}</span>
      <span className="row">
        {prefix && <span className="muted">{prefix}</span>}
        <input
          className="field-input"
          type="number"
          name={name}
          defaultValue={defaultValue}
          step={step}
          min="0"
          style={{ width: 130 }}
        />
        {suffix && <span className="tiny muted">{suffix}</span>}
      </span>
    </label>
  );
}
