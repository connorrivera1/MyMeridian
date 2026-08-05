import { ConnectorStatus, CostRuleKind } from "@prisma/client";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "~/db.server";
import { invalidateAnalyticsCache } from "~/data/analytics.server";
import { Badge, Banner, Card, Empty, Stat } from "~/design/components";
import { requireShopContext } from "~/lib/auth.server";
import {
  DATA_REQUEST_RETENTION_DAYS,
  listDataRequests,
  markDataRequestCollected,
} from "~/lib/data-request.server";
import { resolvePlan } from "~/lib/plan.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";
import { scopeReport } from "~/lib/scopes";
import { PLANS } from "~/lib/plans";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireShopContext(request);
  const { shop } = ctx;
  const plan = await resolvePlan(ctx);

  const [costRules, connectors, orderCount, productCount, dataRequests] =
    await Promise.all([
      prisma.costRule.findMany({ where: { shopId: shop.id }, orderBy: { kind: "asc" } }),
      prisma.connector.findMany({
        where: { shopId: shop.id },
        orderBy: { provider: "asc" },
      }),
      prisma.order.count({ where: { shopId: shop.id } }),
      prisma.product.count({ where: { shopId: shop.id } }),
      listDataRequests(shop.id),
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
      : scopeReport(shop.grantedScopes ?? process.env.SCOPES),
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
    })),
    connectors: connectors.map((connector) => ({
      provider: connector.provider,
      status: connector.status,
      displayName: connector.displayName,
      lastSyncedAt: connector.lastSyncedAt,
      lastError: connector.lastError,
    })),
    // The export travels with the page rather than sitting behind a download
    // URL: this loader is already the merchant's authenticated session, and a
    // separate endpoint serving personal data would be a second thing to get
    // right. The list is capped and expired exports are purged before it.
    dataRequests,
    retentionDays: DATA_REQUEST_RETENTION_DAYS,
    plan: plan.planId,
  };
}

const CostRuleUpdate = z.object({
  id: z.string().min(1),
  percentRate: z.coerce.number().min(0).max(1).optional(),
  fixedPerOrder: z.coerce.number().min(0).max(100_000).optional(),
  fixedPerItem: z.coerce.number().min(0).max(100_000).optional(),
  monthlyAmount: z.coerce.number().min(0).max(10_000_000).optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  const { shop, admin } = await requireShopContext(request);
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
    startBackfill(shop.id, admin);

    return {
      ok: true,
      message: "Import started. Progress appears at the top of the page.",
    };
  }

  if (form.get("intent") === "data-request-collected") {
    const id = String(form.get("id") ?? "");
    // Not an error if it was already collected — the merchant may download the
    // same export twice, and only the first time is what the audit trail claims.
    await markDataRequestCollected(shop.id, id);
    return { ok: true, message: "Export downloaded and marked as collected." };
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
    where: { id: parsed.data.id, shopId: shop.id },
  });
  if (!rule) return { ok: false, message: "Cost rule not found." };

  await prisma.costRule.update({
    where: { id: rule.id },
    data: {
      percentRate:
        parsed.data.percentRate !== undefined
          ? parsed.data.percentRate.toFixed(5)
          : undefined,
      fixedPerOrder:
        parsed.data.fixedPerOrder !== undefined
          ? parsed.data.fixedPerOrder.toFixed(4)
          : undefined,
      fixedPerItem:
        parsed.data.fixedPerItem !== undefined
          ? parsed.data.fixedPerItem.toFixed(4)
          : undefined,
      monthlyAmount:
        parsed.data.monthlyAmount !== undefined
          ? parsed.data.monthlyAmount.toFixed(2)
          : undefined,
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
  STRIPE: "Actual processing fees, replacing the estimate",
  WAREHOUSE_3PL: "Real per-shipment carrier and pick/pack cost",
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const rule = (kind: CostRuleKind) =>
    data.costRules.find((candidate) => candidate.kind === kind);

  const payment = rule(CostRuleKind.PAYMENT_FEE);
  const shipping = rule(CostRuleKind.SHIPPING_DEFAULT);
  const pickPack = rule(CostRuleKind.PICK_PACK);
  const overhead = rule(CostRuleKind.OVERHEAD_MONTHLY);

  return (
    <>
      {result?.message && (
        <Banner tone={result.ok ? "neutral" : "warn"}>{result.message}</Banner>
      )}

      <Banner>
        Every profit figure in Meridian is only as good as these inputs. Anything
        left at a default is marked with an amber dot in the order table so you
        can tell a measured cost from an assumed one.
      </Banner>

      <div className="grid cols-2">
        <Card
          title="Payment processing"
          hint="Charged on the full captured amount including tax and shipping. Processors do not refund their fee when you refund an order, and Meridian models it that way."
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
          hint="Used when a shipment has no measured carrier cost. Connect a 3PL to replace this estimate with the real figure per order."
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

        <Card title="Pick, pack and materials">
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
              <button
                className="btn sm"
                name="intent"
                value="resync"
                disabled={busy || data.sync.status === "RUNNING"}
              >
                {data.sync.status === "RUNNING" ? "Importing…" : "Re-import"}
              </button>
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
                {data.sync.status === "COMPLETE"
                  ? "Up to date"
                  : data.sync.status === "RUNNING"
                    ? "Importing"
                    : data.sync.status === "FAILED"
                      ? "Stopped early"
                      : data.isDemo
                        ? "Seeded"
                        : "Not started"}
              </span>
            }
            meta={<span>{data.sync.stage ?? ""}</span>}
          />
          <Stat
            small
            label="Orders held"
            value={<span className="num">{data.sync.orders.toLocaleString()}</span>}
          />
          <Stat
            small
            label="Products held"
            value={<span className="num">{data.sync.products.toLocaleString()}</span>}
          />
          <Stat
            small
            label="History reaches"
            value={
              <span className="secondary">
                {data.sync.earliestOrderAt
                  ? new Date(data.sync.earliestOrderAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
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
              To change these, edit <code>[access_scopes]</code> in{" "}
              <code>shopify.app.toml</code>, run <code>npm run shopify:dev</code>,
              and reinstall the app so the merchant re-approves.{" "}
              {data.scopes.some((s) => !s.granted && s.protectedData) && (
                <>
                  <code>read_customers</code> additionally needs a Protected
                  Customer Data request approved in the Partner Dashboard under{" "}
                  <em>App → API access</em>.
                </>
              )}
            </p>
          )}
        </Card>
      )}

      <Card
        title="Customer data requests"
        hint={`When a shopper asks what your store holds on them, Shopify sends the request here and Meridian assembles the export for you to hand over. You are the controller and reply to the shopper; Meridian never contacts them. Exports are deleted ${data.retentionDays} days after the request.`}
        flush
      >
        {data.dataRequests.length === 0 ? (
          <div style={{ padding: "14px 16px" }}>
            <Empty>
              No requests. One appears here within seconds of a shopper asking
              through Shopify.
            </Empty>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Requested</th>
                  <th>Contents</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.dataRequests.map((request) => (
                  <DataRequestRow key={request.id} request={request} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Connections"
        hint="Meridian reads from these. Where a connection is missing, the matching cost falls back to the rule above."
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
                      ? new Date(connector.lastSyncedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })
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
          <Stat small label="Domain" value={<span className="tiny">{data.shopDomain}</span>} />
          <Stat small label="Currency" value={data.currency} />
          <Stat small label="Timezone" value={<span className="tiny">{data.timezone}</span>} />
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

type LoadedDataRequest = Awaited<ReturnType<typeof loader>>["dataRequests"][number];

/**
 * One request, with the export attached.
 *
 * The download is built in the browser from data the loader already sent, so
 * collecting an export is not a second authenticated endpoint serving personal
 * data. Marking it collected is a separate, deliberate write: the audit trail
 * should record that the merchant took it, not that they looked at the page.
 */
function DataRequestRow({ request }: { request: LoadedDataRequest }) {
  const fetcher = useFetcher();
  const requestedAt = new Date(request.requestedAt);
  const expiresAt = new Date(request.expiresAt);

  const download = () => {
    const blob = new Blob([JSON.stringify(request.report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `data-request-${request.shopifyCustomerId.replace(
      /[^\w.-]+/g,
      "-",
    )}-${requestedAt.toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    fetcher.submit(
      { intent: "data-request-collected", id: request.id },
      { method: "post" },
    );
  };

  return (
    <tr>
      <td className="primary-cell">
        {request.customerEmail ?? "Email not held"}
        <div className="cell-sub">
          <code>{request.shopifyCustomerId}</code>
        </div>
      </td>
      <td className="tiny muted">
        {requestedAt.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
        <div className="cell-sub">
          deleted {expiresAt.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </div>
      </td>
      <td className="secondary tiny">
        {request.ordersIncluded > 0
          ? `${request.ordersIncluded} order${request.ordersIncluded === 1 ? "" : "s"}, with line items`
          : "Nothing held on this shopper"}
      </td>
      <td>
        {request.collectedAt ? (
          <Badge tone="good">Collected</Badge>
        ) : (
          <Badge tone="warning">Awaiting collection</Badge>
        )}
      </td>
      <td>
        <button className="btn sm" type="button" onClick={download}>
          Download JSON
        </button>
      </td>
    </tr>
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
