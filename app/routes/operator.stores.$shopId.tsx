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

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export default function OperatorStoreSupport() {
  const { store } = useLoaderData<typeof loader>();
  const scopes = store.grantedScopes?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? [];

  return (
    <main className="operator-main">
      <Link to="/operator" className="operator-back-link">← Business And Health</Link>
      <div className="operator-title-row">
        <div><p className="operator-kicker">PII-Minimized Support View</p><h1>{store.domain}</h1></div>
        <div className={`operator-status operator-status-${store.dataCompleteness.status === "complete" ? "healthy" : "degraded"}`}>
          <span aria-hidden="true" /> Data {titleCase(store.dataCompleteness.status)}
        </div>
      </div>

      <div className="operator-readonly-notice">
        This view is read-only. Customer records, merchant email, order details,
        webhook payloads, connector credentials and raw failure messages are intentionally excluded.
      </div>

      <section><h2>Installation And Subscription</h2><dl className="operator-detail-grid">
        <Detail label="Shop Domain" value={store.domain} />
        <Detail label="Installed" value={dateTime(store.installedAt)} />
        <Detail label="Uninstalled" value={dateTime(store.uninstalledAt)} />
        <Detail label="Plan" value={titleCase(store.subscription?.plan ?? "none")} />
        <Detail label="Interval" value={store.subscription?.interval ? titleCase(store.subscription.interval) : "—"} />
        <Detail label="Subscription State" value={titleCase(store.subscription?.status ?? "none")} />
        <Detail label="Trial Ends" value={dateTime(store.subscription?.trialEndsAt ?? null)} />
        <Detail label="Current Period Ends" value={dateTime(store.subscription?.currentPeriodEnd ?? null)} />
      </dl></section>

      <section><h2>Sync And Scope Status</h2><dl className="operator-detail-grid">
        <Detail label="Sync Status" value={titleCase(store.syncStatus)} />
        <Detail label="Sync Stage" value={store.syncStage ? titleCase(store.syncStage) : "—"} />
        <Detail label="Last Sync" value={dateTime(store.lastSyncedAt)} />
        <Detail label="Last Computation" value={dateTime(store.lastComputedAt)} />
        <Detail label="Imported Orders" value={store.syncedOrders.toLocaleString()} />
        <Detail label="Imported Products" value={store.syncedProducts.toLocaleString()} />
        <Detail label="History Access" value={store.hasAllOrdersScope ? "All Authorized Order History" : "Shopify 60-Day Window"} />
        <Detail label="Earliest Visible Order" value={dateTime(store.earliestOrderAt)} />
      </dl>
      <div className="operator-scope-list" aria-label="Granted Shopify Scopes">
        {scopes.length ? scopes.map((scope) => <code key={scope}>{scope}</code>) : <span>No Granted Scopes Recorded</span>}
      </div></section>

      <section><h2>Connector Status</h2>
        <div className="operator-table-wrap"><table><thead><tr><th>Provider</th><th>Connection</th><th>Health</th><th>Last Sync</th><th>Failures</th></tr></thead><tbody>
          {store.connectors.map((connector) => <tr key={connector.provider}><td>{formatOperatorProvider(connector.provider)}</td><td>{titleCase(connector.status)}</td><td>{titleCase(connector.healthStatus)}</td><td>{dateTime(connector.lastSyncedAt)}</td><td>{connector.consecutiveFailures}</td></tr>)}
        </tbody></table></div>
      </section>

      <section><h2>Job Health</h2><div className="operator-metric-grid">
        {Object.entries(store.jobHealth).map(([key, value]) => <Metric key={key} label={titleCase(key)} value={value} />)}
      </div></section>

      <section><h2>Data Completeness</h2><div className="operator-metric-grid">
        <Metric label="Total Orders" value={store.dataCompleteness.totalOrders} />
        <Metric label="Computed Orders" value={store.dataCompleteness.computedOrders} />
        <Metric label="Orders Missing COGS" value={store.dataCompleteness.missingCogsOrders} />
        <Metric label="Total Variants" value={store.dataCompleteness.totalVariants} />
        <Metric label="Variants Missing Cost" value={store.dataCompleteness.missingCostVariants} />
        <Metric label="History Coverage" value={store.dataCompleteness.historyCoverage === "all_orders" ? "All Authorized History" : "60-Day Limit"} />
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
