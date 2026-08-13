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
  const { revenue, lifecycle, failures, system, waitlist } = overview;

  return (
    <main className="operator-main">
      <div className="operator-title-row">
        <div>
          <p className="operator-kicker">Internal Control Plane</p>
          <h1>Business And System Health</h1>
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
          <Metric label="Active Paying Stores" value={revenue.activePayingStores} />
          <Metric label="Active Trials" value={revenue.trials} />
          <Metric label="MRR" value={money(revenue.mrrCents)} />
          <Metric label="ARR" value={money(revenue.arrCents)} />
          <Metric label="Trial Conversion" value={percent(revenue.trialConversionRate)} note={`${revenue.convertedTrials} Of ${revenue.completedTrials} Completed Trials Currently Active`} />
          <Metric label="30-Day Churn" value={percent(lifecycle.churnRate30d)} note={`${lifecycle.churnedStores30d} Cancelled Stores`} />
        </div>
        <div className="operator-plan-row">
          {Object.entries(revenue.planDistribution).map(([plan, count]) => (
            <div key={plan}><span>{plan}</span><strong>{count}</strong></div>
          ))}
        </div>
      </section>

      <section aria-labelledby="lifecycle-heading">
        <h2 id="lifecycle-heading">Store Lifecycle And Reliability</h2>
        <div className="operator-metric-grid">
          <Metric label="All Installs" value={lifecycle.installTotal} note={`${lifecycle.installs30d} In 30 Days`} />
          <Metric label="All Uninstalls" value={lifecycle.uninstallTotal} note={`${lifecycle.uninstalls30d} In 30 Days`} />
          <Metric label="Failed Imports" value={failures.failedImports} />
          <Metric label="Webhook Failures" value={failures.webhookFailures} />
          <Metric label="Background-Job Failures" value={failures.recalcFailures + failures.notificationFailures + failures.adSyncFailures} note={`${failures.recalcFailures} Recalc · ${failures.notificationFailures} Notification · ${failures.adSyncFailures} Ad Sync`} />
          <Metric label="Database" value={system.database} note={`${system.databaseLatencyMs} ms probe`} />
          <Metric label="Ad-ingestion worker" value={system.adIngestion} note="Redis queue configuration" />
          <Metric label="Email delivery" value={system.emailDelivery} note="Transactional provider configuration" />
        </div>
        <div className="operator-backlog">
          <span>Webhook Backlog <strong>{system.webhookBacklog}</strong></span>
          <span>Recalculation Backlog <strong>{system.recalcBacklog}</strong></span>
          <span>Notification Backlog <strong>{system.notificationBacklog}</strong></span>
          <span>Ad-Sync Backlog <strong>{system.adSyncBacklog}</strong></span>
        </div>
      </section>

      <section aria-labelledby="waitlist-heading">
        <h2 id="waitlist-heading">Pre-Launch Waitlist</h2>
        <p className="operator-muted">
          Publisher-level aggregate acquisition data. Email addresses and store
          URLs are intentionally not displayed here.
        </p>
        <div className="operator-metric-grid">
          <Metric label="Total Signups" value={waitlist.total} />
          <Metric label="Signups In 30 Days" value={waitlist.signups30d} />
          <Metric label="Store URL Coverage" value={percent(waitlist.storeUrlCoverage)} />
          <Metric label="Founding Merchant Eligible" value={waitlist.foundingEligible} />
        </div>
        <div className="grid cols-2">
          <div className="operator-table-wrap">
            <table>
              <thead><tr><th colSpan={2}>Signup Activity</th></tr></thead>
              <tbody>
                {waitlist.daily.length ? waitlist.daily.map((point) => (
                  <tr key={point.day}><td>{point.day}</td><td>{point.signups}</td></tr>
                )) : <tr><td colSpan={2}>No signups in the last 30 days.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="operator-table-wrap">
            <table>
              <thead><tr><th>Attributed Source</th><th>Signups</th></tr></thead>
              <tbody>
                {waitlist.sources.length ? waitlist.sources.map((source) => (
                  <tr key={source.source}><td>{source.source}</td><td>{source.signups}</td></tr>
                )) : <tr><td colSpan={2}>No attributed source yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="connectors-heading">
        <h2 id="connectors-heading">Connector Adoption</h2>
        {overview.connectors.length ? (
          <div className="operator-table-wrap">
            <table>
              <thead><tr><th>Provider</th><th>Connected Stores</th><th>Adoption</th></tr></thead>
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
        <h2 id="alerts-heading">Recent Operational Alerts</h2>
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
          <h2 id="stores-heading">Store Support</h2>
          <Form method="get" className="operator-search">
            <label className="operator-sr-only" htmlFor="store-search">Search Shop Domain</label>
            <input id="store-search" name="q" defaultValue={search} placeholder="Search Shop Domain" maxLength={253} />
            <button type="submit">Search</button>
          </Form>
        </div>
        <div className="operator-table-wrap">
          <table>
            <thead><tr><th>Shop Domain</th><th>Plan</th><th>Subscription</th><th>Sync</th><th>Last Sync</th></tr></thead>
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
