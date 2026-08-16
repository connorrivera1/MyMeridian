import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { CapacityChart } from "~/design/charts";
import {
  Alert,
  AnimatedInt,
  Badge,
  Card,
  Empty,
  IconChannels,
  IconFulfilment,
  IconOrders,
  IconOverview,
  Legend,
  Tile,
  UpgradeNotice,
} from "~/design/components";
import { formatPercent } from "~/engine/money";
import { loadCapacityDays } from "~/data/queries.server";
import { withShopContext, type ShopContext } from "~/lib/auth.server";
import { planAllows, planFor } from "~/lib/plan.server";
import { loadDashboardForContext } from "~/lib/route-data.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, (ctx) => loadFulfilment(request, ctx));
}

async function loadFulfilment(request: Request, ctx: ShopContext) {
  const { shop, analytics, plan } = await loadDashboardForContext(request, ctx);

  if (!planAllows(plan, "capacity")) {
    const required = planFor("capacity");
    return { locked: { name: required.name, price: required.price } };
  }

  const capacity = analytics.capacity;

  // The chart wants recent history regardless of the selected reporting range —
  // a 7-day window would not show enough to read a trend.
  const historyFrom = new Date(analytics.range.to.getTime() - 45 * 86_400_000);
  const days = await loadCapacityDays(shop.id, {
    from: historyFrom,
    to: analytics.range.to,
  });

  return {
    locked: null,
    slaDays: shop.fulfillmentSlaDays,
    hasData: capacity.hasData,
    metrics: {
      currentBacklog: capacity.currentBacklog,
      throughputPerDay: capacity.throughputPerDay,
      effectiveCapacityPerDay: capacity.effectiveCapacityPerDay,
      utilisationPct: capacity.utilisationPct,
      daysToClearBacklog: capacity.daysToClearBacklog,
      demandTrendPct: capacity.demandTrendPct,
      throughputStdDev: capacity.throughputStdDev,
    },
    alerts: capacity.alerts,
    backlogSpark: days.map((d) => d.backlogEnd),
    shippedSpark: days.map((d) => d.ordersFulfilled),
    receivedSpark: days.map((d) => d.ordersReceived),
    history: days.map((day) => ({
      date: day.date,
      received: day.ordersReceived,
      fulfilled: day.ordersFulfilled,
      backlog: day.backlogEnd,
    })),
    forecast: capacity.forecast.map((day) => ({
      date: day.date,
      inbound: day.projectedInbound,
      backlog: day.projectedBacklog,
      overCapacity: day.overCapacity,
      shipDelay: Number.isFinite(day.projectedShipDelayDays)
        ? day.projectedShipDelayDays
        : null,
    })),
  };
}

export default function Fulfilment() {
  const data = useLoaderData<typeof loader>();

  return <FulfilmentView data={data} />;
}

type FulfilmentData = Awaited<ReturnType<typeof loader>>;

export function FulfilmentView({ data }: { data: FulfilmentData }) {
  if (data.locked) {
    return (
      <UpgradeNotice
        feature="Fulfilment capacity"
        planName={data.locked.name}
        price={data.locked.price}
      >
        MyMeridian measures the throughput your team has actually demonstrated,
        projects the next fortnight of demand against it, and tells you which
        days will miss your shipping promise before the backlog forms.
      </UpgradeNotice>
    );
  }

  if (!data.hasData) {
    return (
      <Card title="Fulfilment Capacity">
        <Empty>
          No Fulfilment History Yet. Once orders start shipping, MyMeridian
          learns your warehouse&rsquo;s real throughput and warns you before it
          falls behind.
        </Empty>
      </Card>
    );
  }

  const m = data.metrics;
  const breached =
    m.daysToClearBacklog !== null && m.daysToClearBacklog > data.slaDays;

  return (
    <>
      <div className="grid cols-4">
        <Tile
          tone="var(--viz-rose)"
          valueTone={breached && m.currentBacklog > 0 ? "negative" : "neutral"}
          icon={<IconFulfilment />}
          label="Orders Waiting"
          value={<AnimatedInt value={m.currentBacklog} />}
          spark={data.backlogSpark}
          meta={
            <span>
              {m.daysToClearBacklog === null
                ? "—"
                : `${m.daysToClearBacklog.toFixed(1)} Days to Clear`}
            </span>
          }
        />
        <Tile
          tone="var(--viz-blue)"
          icon={<IconOrders />}
          label="Shipping Now"
          value={<AnimatedInt value={Math.round(m.throughputPerDay)} />}
          spark={data.shippedSpark}
          meta={<span>Orders A Day, 14-Day Average</span>}
        />
        <Tile
          tone="var(--viz-amber)"
          icon={<IconOverview />}
          label="Capacity Used"
          value={
            m.utilisationPct === null ? "—" : formatPercent(m.utilisationPct, 0)
          }
          meta={
            <span>
              Ceiling {Math.round(m.effectiveCapacityPerDay).toLocaleString()}
              /day
            </span>
          }
        />
        <Tile
          tone="var(--viz-teal)"
          icon={<IconChannels />}
          label="Demand Trend"
          value={
            m.demandTrendPct === null ? "—" : formatPercent(m.demandTrendPct, 0)
          }
          spark={data.receivedSpark}
          meta={<span>Last 28 Days Vs. The 28 Before</span>}
        />
      </div>

      {data.alerts.length > 0 && (
        <Card
          title={breached ? "You Are Behind" : "Watch List"}
          hint={`Measured against your ${data.slaDays}-day shipping promise, using the throughput your team has actually demonstrated rather than a configured number.`}
          flush
        >
          {data.alerts.map((alert) => (
            <Alert
              key={alert.id}
              severity={alert.severity}
              title={alert.title}
              daysUntil={alert.daysUntil}
            >
              {alert.detail}
            </Alert>
          ))}
        </Card>
      )}

      <Card
        title="Demand Against Capacity"
        hint="Solid region is history; shaded region is the next 14 days, projected from trailing demand with your weekday pattern applied."
        flush
      >
        <div className="chart-legend-inset">
          <Legend
            items={[
              { label: "Orders Received", color: "var(--mark-structure)" },
              { label: "Backlog", color: "var(--delta-down)" },
              { label: "Capacity Ceiling", color: "var(--status-warning)" },
            ]}
          />
        </div>
        <div style={{ padding: "4px 16px 14px" }}>
          <CapacityChart
            history={data.history.map((day) => ({
              date: new Date(day.date),
              received: day.received,
              fulfilled: day.fulfilled,
              backlog: day.backlog,
            }))}
            forecast={data.forecast.map((day) => ({
              date: new Date(day.date),
              inbound: day.inbound,
              backlog: day.backlog,
            }))}
            capacity={m.effectiveCapacityPerDay}
          />
        </div>
      </Card>

      <Card
        title="Next 14 Days"
        hint="Overflow rolls into the following day rather than disappearing, which is why a single busy week can put shipping times out for a fortnight."
        flush
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Day</th>
                <th className="right">Orders Expected</th>
                <th className="right">Backlog At Close</th>
                <th className="right">Ship Delay</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.forecast.map((day) => {
                const late =
                  day.shipDelay !== null && day.shipDelay > data.slaDays;
                return (
                  <tr key={String(day.date)}>
                    <td className="primary-cell">
                      {new Date(day.date).toLocaleDateString("en-US", {
                        // Forecast dates are merchant-calendar keys stored at
                        // UTC midnight, not instants to shift into this laptop.
                        timeZone: "UTC",
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="right num">
                      {day.inbound.toLocaleString()}
                    </td>
                    <td className="right num">
                      {day.backlog.toLocaleString()}
                    </td>
                    <td className="right num">
                      {day.shipDelay === null
                        ? "—"
                        : `${day.shipDelay.toFixed(1)} days`}
                    </td>
                    <td>
                      {/* The Badge component, not a hand-rolled span: these
                          three were the only badges in the app bypassing it,
                          and they were also the only ones in lower case. */}
                      {late ? (
                        <Badge tone="critical">Past Promise</Badge>
                      ) : day.overCapacity ? (
                        <Badge tone="warning">Over Capacity</Badge>
                      ) : (
                        <Badge tone="neutral">On Track</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
