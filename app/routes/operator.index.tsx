import { Form, Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import {
  loadOperatorOverview,
  loadOperatorStores,
} from "~/lib/operator-data.server";
import { requireOperator } from "~/lib/operator-auth.server";
import { formatOperatorProvider } from "~/lib/operator-display";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOperator(request, "metrics:read", {
    action: "OPERATOR_METRICS_VIEW",
    resource: "aggregate_business_and_system_metrics",
  });
  const search = new URL(request.url).searchParams.get("q") ?? "";
  const [overview, stores] = await Promise.all([
    loadOperatorOverview(),
    loadOperatorStores(search),
  ]);
  return { overview, stores, search };
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function dateTime(value: string | Date | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function OperatorOverview() {
  const { overview, stores, search } = useLoaderData<typeof loader>();
  const { revenue, lifecycle, failures, system } = overview;

  return (
    <main className="operator-main">
      <div className="operator-title-row">
        <div>
          <p className="operator-kicker">Internal control plane</p>
          <h1>Business and system health</h1>
          <p className="operator-muted">
            Aggregate operating data only. Customer identities, order details,
            tokens, payloads and merchant contact information are excluded.
          </p>
        </div>
        <div className={`operator-status operator-status-${system.status}`}>
          <span aria-hidden="true" /> System {system.status}
        </div>
      </div>

      <section aria-labelledby="revenue-heading">
        <h2 id="revenue-heading">Revenue</h2>
        <div className="operator-metric-grid">
          <Metric label="Active paying stores" value={revenue.activePayingStores} />
          <Metric label="Active trials" value={revenue.trials} />
          <Metric label="MRR" value={money(revenue.mrrCents)} />
          <Metric label="ARR" value={money(revenue.arrCents)} />
          <Metric label="Trial conversion" value={percent(revenue.trialConversionRate)} note={`${revenue.convertedTrials} of ${revenue.completedTrials} completed trials currently active`} />
          <Metric label="30-day churn" value={percent(lifecycle.churnRate30d)} note={`${lifecycle.churnedStores30d} cancelled stores`} />
        </div>
        <div className="operator-plan-row">
          {Object.entries(revenue.planDistribution).map(([plan, count]) => (
            <div key={plan}><span>{plan}</span><strong>{count}</strong></div>
          ))}
        </div>
      </section>

      <section aria-labelledby="lifecycle-heading">
        <h2 id="lifecycle-heading">Store lifecycle and reliability</h2>
        <div className="operator-metric-grid">
          <Metric label="All installs" value={lifecycle.installTotal} note={`${lifecycle.installs30d} in 30 days`} />
          <Metric label="All uninstalls" value={lifecycle.uninstallTotal} note={`${lifecycle.uninstalls30d} in 30 days`} />
          <Metric label="Failed imports" value={failures.failedImports} />
          <Metric label="Webhook failures" value={failures.webhookFailures} />
          <Metric label="Background-job failures" value={failures.recalcFailures + failures.notificationFailures + failures.adSyncFailures} note={`${failures.recalcFailures} recalc · ${failures.notificationFailures} notification · ${failures.adSyncFailures} ad sync`} />
          <Metric label="Database" value={system.database} note={`${system.databaseLatencyMs} ms probe`} />
          <Metric label="Ad-ingestion worker" value={system.adIngestion} note="Redis queue configuration" />
          <Metric label="Email delivery" value={system.emailDelivery} note="Transactional provider configuration" />
        </div>
        <div className="operator-backlog">
          <span>Webhook backlog <strong>{system.webhookBacklog}</strong></span>
          <span>Recalculation backlog <strong>{system.recalcBacklog}</strong></span>
          <span>Notification backlog <strong>{system.notificationBacklog}</strong></span>
          <span>Ad-sync backlog <strong>{system.adSyncBacklog}</strong></span>
        </div>
      </section>

      <section aria-labelledby="connectors-heading">
        <h2 id="connectors-heading">Connector adoption</h2>
        {overview.connectors.length ? (
          <div className="operator-table-wrap">
            <table>
              <thead><tr><th>Provider</th><th>Connected stores</th><th>Adoption</th></tr></thead>
              <tbody>
                {overview.connectors.map((connector) => (
                  <tr key={connector.provider}>
                    <td>{formatOperatorProvider(connector.provider)}</td>
                    <td>{connector.connectedStores}</td>
                    <td>{percent(connector.adoptionRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="operator-empty">No merchant connector is currently connected.</p>}
      </section>

      <section aria-labelledby="alerts-heading">
        <h2 id="alerts-heading">Recent operational alerts</h2>
        {overview.alerts.length ? (
          <div className="operator-alert-list">
            {overview.alerts.map((alert) => (
              <Link to={`/operator/stores/${alert.shopId}`} key={alert.id} className="operator-alert-row">
                <span className={`operator-severity operator-severity-${alert.severity}`}>{alert.severity}</span>
                <span><strong>{alert.summary}</strong><small>{alert.shopDomain}</small></span>
                <time>{dateTime(alert.occurredAt)}</time>
              </Link>
            ))}
          </div>
        ) : <p className="operator-empty">No active operational alerts.</p>}
      </section>

      <section aria-labelledby="stores-heading">
        <div className="operator-section-heading">
          <h2 id="stores-heading">Store support</h2>
          <Form method="get" className="operator-search">
            <label className="operator-sr-only" htmlFor="store-search">Search shop domain</label>
            <input id="store-search" name="q" defaultValue={search} placeholder="Search shop domain" maxLength={253} />
            <button type="submit">Search</button>
          </Form>
        </div>
        <div className="operator-table-wrap">
          <table>
            <thead><tr><th>Shop domain</th><th>Plan</th><th>Subscription</th><th>Sync</th><th>Last sync</th></tr></thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id}>
                  <td><Link to={`/operator/stores/${store.id}`}>{store.domain}</Link></td>
                  <td>{store.subscription?.plan ?? "none"}</td>
                  <td>{store.uninstalledAt ? "uninstalled" : (store.subscription?.status ?? "none")}</td>
                  <td>{store.syncStatus.toLowerCase()}</td>
                  <td>{dateTime(store.lastSyncedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="operator-generated">Generated {dateTime(overview.generatedAt)}</p>
    </main>
  );
}

function Metric({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <article className="operator-metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>;
}
