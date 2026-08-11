import {
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
import { requireShopContext } from "~/lib/auth.server";
import { backfillIsStale } from "~/lib/backfill-claim.server";
import { requireActivePlan } from "~/lib/plan.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";
import { scopeReport } from "~/lib/scopes";
import { PLANS } from "~/lib/plans";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireShopContext(request);
  const { shop } = ctx;
  const plan = await requireActivePlan(ctx, request);
  const staleBackfill = backfillIsStale(shop);

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
      lastSyncedAt: connector.lastSyncedAt,
      lastError: connector.lastError,
    })),
    plan: plan.planId,
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
  const ctx = await requireShopContext(request);
  await requireActivePlan(ctx, request);
  const { shop, admin } = ctx;
  const form = await request.formData();

  if (form.get("intent") === "resync") {
    if (!admin) {
      return {
        ok: false,
        message:
          "Re-import needs a live Shopify session. The demo store has no store to read from.",
      };
    }

    const { startBackfill } = await import("~/lib/backfill.server");
    const started = await startBackfill(shop.id, admin);

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
    const result = await recomputeShopProfitability(shop.id);
    invalidateAnalyticsCache();
    return { ok: true, message: `Recomputed ${result.ordersUpdated} orders.` };
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
  const result = await recomputeShopProfitability(shop.id);
  invalidateAnalyticsCache();

  return {
    ok: true,
    message: `Saved. Reprofiled ${result.ordersUpdated.toLocaleString()} orders.`,
  };
}

const CONNECTOR_LABEL: Record<string, string> = {
  SHOPIFY: "Shopify",
  FACEBOOK_ADS: "Meta Ads",
  GOOGLE_ADS: "Google Ads",
  TIKTOK_ADS: "TikTok Ads",
  STRIPE: "Stripe",
  WAREHOUSE_3PL: "3PL / warehouse",
};

const CONNECTOR_PURPOSE: Record<string, string> = {
  SHOPIFY: "Orders, products and fulfilments",
  FACEBOOK_ADS: "Ad spend and campaign attribution",
  GOOGLE_ADS: "Ad spend and campaign attribution",
  TIKTOK_ADS: "Ad spend and campaign attribution",
  STRIPE:
    "Unavailable in this release; processing uses the configured fee model",
  WAREHOUSE_3PL:
    "Unavailable in this release; fulfilment uses recorded costs or configured fallbacks",
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
    return <Badge tone="neutral">No cost applied</Badge>;
  if (rule.confirmedAt) return <Badge tone="good">Reviewed assumption</Badge>;

  return (
    <Badge tone="warning" dot>
      {rule.origin === CostRuleOrigin.INSTALL_DEFAULT
        ? "Unconfirmed install default"
        : "Unconfirmed assumption"}
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
      buttonLabel: sync.hasResumeCursor ? "Resume import" : "Restart import",
      statusLabel: "Interrupted",
      disabled: false,
      recoveryCopy: sync.hasResumeCursor
        ? "The previous import's server claim expired. Resume from its saved order-history checkpoint."
        : "The previous import's server claim expired before it saved an order-history checkpoint. Restart it safely.",
    };
  }

  if (sync.status === SyncStatus.FAILED) {
    return {
      buttonLabel: sync.hasResumeCursor ? "Resume import" : "Retry import",
      statusLabel: "Stopped early",
      disabled: false,
      recoveryCopy: sync.hasResumeCursor
        ? "A saved order-history checkpoint is ready. Resume without re-reading completed pages."
        : null,
    };
  }

  if (sync.status === SyncStatus.COMPLETE) {
    return {
      buttonLabel: "Re-import",
      statusLabel: "Up to date",
      disabled: false,
      recoveryCopy: null,
    };
  }

  return {
    buttonLabel: "Start import",
    statusLabel: "Not started",
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
          title="Payment processing"
          hint="Charged on the full captured amount including tax and shipping. Processors do not refund their fee when you refund an order, and Meridian models it that way."
          actions={<CostRuleState rule={payment} />}
        >
          <Form method="post" className="stack">
            <input type="hidden" name="id" value={payment?.id} />
            <Field
              label="Percentage rate"
              name="percentRate"
              defaultValue={payment?.percentRate ?? 0.029}
              step="0.00001"
              suffix={`= ${((payment?.percentRate ?? 0) * 100).toFixed(2)}%`}
            />
            <Field
              label="Fixed per order"
              name="fixedPerOrder"
              defaultValue={payment?.fixedPerOrder ?? 0.3}
              step="0.01"
              prefix="$"
            />
            <button className="btn primary" disabled={busy}>
              Save and reprofile
            </button>
          </Form>
        </Card>

        <Card
          title="Shipping"
          hint="Used when a shipment has no measured carrier cost. This release has no 3PL connector, so review the fallback as an assumption; affected orders remain amber."
          actions={<CostRuleState rule={shipping} />}
        >
          <Form method="post" className="stack">
            <input type="hidden" name="id" value={shipping?.id} />
            <Field
              label="Estimated cost per order"
              name="fixedPerOrder"
              defaultValue={shipping?.fixedPerOrder ?? 8.5}
              step="0.01"
              prefix="$"
            />
            <button className="btn primary" disabled={busy}>
              Save and reprofile
            </button>
          </Form>
        </Card>

        <Card
          title="Pick, pack and materials"
          actions={<CostRuleState rule={pickPack} />}
        >
          <Form method="post" className="stack">
            <input type="hidden" name="id" value={pickPack?.id} />
            <Field
              label="Per order"
              name="fixedPerOrder"
              defaultValue={pickPack?.fixedPerOrder ?? 1.75}
              step="0.01"
              prefix="$"
            />
            <Field
              label="Per item"
              name="fixedPerItem"
              defaultValue={pickPack?.fixedPerItem ?? 0.35}
              step="0.01"
              prefix="$"
            />
            <button className="btn primary" disabled={busy}>
              Save and reprofile
            </button>
          </Form>
        </Card>

        <Card
          title="Fixed monthly overhead"
          hint="Rent, salaries, software — anything you pay whether or not you sell. Amortised evenly across each month's orders, to the cent."
          actions={<CostRuleState rule={overhead} />}
        >
          <Form method="post" className="stack">
            <input type="hidden" name="id" value={overhead?.id} />
            <Field
              label="Monthly amount"
              name="monthlyAmount"
              defaultValue={overhead?.monthlyAmount ?? 0}
              step="0.01"
              prefix="$"
            />
            <button className="btn primary" disabled={busy}>
              Save and reprofile
            </button>
          </Form>
        </Card>
      </div>

      <Card
        title="Shopify data"
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
            label="Import status"
            value={
              <span className="secondary">
                {data.isDemo ? "Seeded" : backfillControl.statusLabel}
              </span>
            }
            meta={<span>{data.sync.stage ?? ""}</span>}
          />
          <Stat
            small
            label="Orders held"
            value={
              <span className="num">{data.sync.orders.toLocaleString()}</span>
            }
          />
          <Stat
            small
            label="Products held"
            value={
              <span className="num">{data.sync.products.toLocaleString()}</span>
            }
          />
          <Stat
            small
            label="History reaches"
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
                <span>capped at 60 days without read_all_orders</span>
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
          title="Data access"
          hint="What this store authorised at install. Meridian only requests fields it is allowed to read — a missing permission removes a feature, it does not produce a wrong number."
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Permission</th>
                  <th>What it provides</th>
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
                        <Badge tone="warning">Not granted</Badge>
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
              <a href="/support">support</a>; Shopify will ask you to
              re-authorise only when an approved app update adds the required
              access. Protected customer-data permissions, including order
              access, also require approval obtained by the app publisher.
            </p>
          )}
        </Card>
      )}

      <Card
        title="Connections"
        hint="Configured data sources appear here. This release has no setup flow for ad platforms, Stripe or 3PL sources; unavailable sources remain Not connected, and their costs are never inferred."
        actions={
          <Form method="post">
            <button
              className="btn sm"
              name="intent"
              value="recompute"
              disabled={busy}
            >
              {busy ? "Recomputing…" : "Recompute all"}
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
                <th>What it provides</th>
                <th>Status</th>
                <th>Last sync</th>
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
                    ) : connector.status === ConnectorStatus.ERROR ? (
                      <Badge tone="critical">Needs attention</Badge>
                    ) : (
                      <Badge tone="neutral">Not connected</Badge>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Plan"
        hint="Billed by Shopify and shown on your Shopify invoice. Meridian never sees a card number."
        actions={
          <a className="btn sm" href="/app/plan">
            {data.plan ? "Change plan" : "Choose a plan"}
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
            label="Last computed"
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
