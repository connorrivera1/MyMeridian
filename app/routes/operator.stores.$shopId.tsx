import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import {
  recordAuthorizedOperatorRead,
  requireOperator,
} from "~/lib/operator-auth.server";
import { loadOperatorStore } from "~/lib/operator-data.server";
import { formatOperatorProvider } from "~/lib/operator-display";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shopId = String(params.shopId ?? "").slice(0, 100);
  const principal = await requireOperator(request, "stores:read", {
    action: "OPERATOR_STORE_ACCESS_CHECK",
    resource: "store_support_route",
  });
  const store = shopId ? await loadOperatorStore(shopId) : null;
  if (!store) throw new Response("Store not found", { status: 404 });
  await recordAuthorizedOperatorRead({
    request,
    principal,
    action: "OPERATOR_STORE_VIEW",
    resource: "pii_minimized_store_support",
    shopId: store.id,
  });
  return { store };
}

function dateTime(value: string | Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function OperatorStoreSupport() {
  const { store } = useLoaderData<typeof loader>();
  const scopes = store.grantedScopes?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? [];

  return (
    <main className="operator-main">
      <Link to="/operator" className="operator-back-link">← Business and health</Link>
      <div className="operator-title-row">
        <div><p className="operator-kicker">PII-minimized support view</p><h1>{store.domain}</h1></div>
        <div className={`operator-status operator-status-${store.dataCompleteness.status === "complete" ? "healthy" : "degraded"}`}>
          <span aria-hidden="true" /> Data {store.dataCompleteness.status}
        </div>
      </div>

      <div className="operator-readonly-notice">
        This view is read-only. Customer records, merchant email, order details,
        webhook payloads, connector credentials and raw failure messages are intentionally excluded.
      </div>

      <section><h2>Installation and subscription</h2><dl className="operator-detail-grid">
        <Detail label="Shop domain" value={store.domain} />
        <Detail label="Installed" value={dateTime(store.installedAt)} />
        <Detail label="Uninstalled" value={dateTime(store.uninstalledAt)} />
        <Detail label="Plan" value={store.subscription?.plan ?? "none"} />
        <Detail label="Interval" value={store.subscription?.interval ?? "—"} />
        <Detail label="Subscription state" value={store.subscription?.status ?? "none"} />
        <Detail label="Trial ends" value={dateTime(store.subscription?.trialEndsAt ?? null)} />
        <Detail label="Current period ends" value={dateTime(store.subscription?.currentPeriodEnd ?? null)} />
      </dl></section>

      <section><h2>Sync and scope status</h2><dl className="operator-detail-grid">
        <Detail label="Sync status" value={store.syncStatus.toLowerCase()} />
        <Detail label="Sync stage" value={store.syncStage ?? "—"} />
        <Detail label="Last sync" value={dateTime(store.lastSyncedAt)} />
        <Detail label="Last computation" value={dateTime(store.lastComputedAt)} />
        <Detail label="Imported orders" value={store.syncedOrders.toLocaleString()} />
        <Detail label="Imported products" value={store.syncedProducts.toLocaleString()} />
        <Detail label="History access" value={store.hasAllOrdersScope ? "All authorized order history" : "Shopify 60-day window"} />
        <Detail label="Earliest visible order" value={dateTime(store.earliestOrderAt)} />
      </dl>
      <div className="operator-scope-list" aria-label="Granted Shopify scopes">
        {scopes.length ? scopes.map((scope) => <code key={scope}>{scope}</code>) : <span>No granted scopes recorded</span>}
      </div></section>

      <section><h2>Connector status</h2>
        <div className="operator-table-wrap"><table><thead><tr><th>Provider</th><th>Connection</th><th>Health</th><th>Last sync</th><th>Failures</th></tr></thead><tbody>
          {store.connectors.map((connector) => <tr key={connector.provider}><td>{formatOperatorProvider(connector.provider)}</td><td>{connector.status.toLowerCase()}</td><td>{connector.healthStatus.toLowerCase()}</td><td>{dateTime(connector.lastSyncedAt)}</td><td>{connector.consecutiveFailures}</td></tr>)}
        </tbody></table></div>
      </section>

      <section><h2>Job health</h2><div className="operator-metric-grid">
        {Object.entries(store.jobHealth).map(([key, value]) => <Metric key={key} label={key.replace(/([A-Z])/g, " $1").toLowerCase()} value={value} />)}
      </div></section>

      <section><h2>Data completeness</h2><div className="operator-metric-grid">
        <Metric label="Total orders" value={store.dataCompleteness.totalOrders} />
        <Metric label="Computed orders" value={store.dataCompleteness.computedOrders} />
        <Metric label="Orders missing COGS" value={store.dataCompleteness.missingCogsOrders} />
        <Metric label="Total variants" value={store.dataCompleteness.totalVariants} />
        <Metric label="Variants missing cost" value={store.dataCompleteness.missingCostVariants} />
        <Metric label="History coverage" value={store.dataCompleteness.historyCoverage === "all_orders" ? "All authorized history" : "60-day limit"} />
      </div></section>
    </main>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
function Metric({ label, value }: { label: string; value: string | number }) {
  return <article className="operator-metric"><span>{label}</span><strong>{value}</strong></article>;
}
