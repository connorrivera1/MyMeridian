import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { Card, Empty } from "~/design/components";
import prisma from "~/db.server";
import { resolveRange } from "~/data/analytics.server";
import { withShopContext, type ShopContext } from "~/lib/auth.server";
import { requireActivePlan } from "~/lib/plan.server";
import { parseRangePreset, RANGE_PRESETS } from "~/lib/ranges";

export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, (ctx) => loadReports(request, ctx));
}

async function loadReports(request: Request, ctx: ShopContext) {
  // The export page needs a date window and a count, not a fully hydrated
  // analytical model. Avoiding the dashboard loader prevents an unnecessary
  // full-period profit build before the merchant has even requested a file.
  await requireActivePlan(ctx, request);
  const preset = parseRangePreset(
    new URL(request.url).searchParams.get("range"),
  );
  const range = resolveRange(ctx.shop, preset, { anchorToData: ctx.isDemo });
  const orderCount = await prisma.order.count({
    where: {
      shopId: ctx.shop.id,
      processedAt: { gte: range.from, lte: range.to },
    },
  });

  return {
    rangeLabel: RANGE_PRESETS[preset].label,
    orderCount,
    exportHref: `/app/export/profit.csv?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`,
  };
}

type ReportsData = Awaited<ReturnType<typeof loader>>;

export function ReportsView({ data }: { data: ReportsData }) {

  return (
    <div className="stack">
      <Card
        title="Order Profitability Export"
        hint={`Download the exact order-level figures behind this ${data.rangeLabel.toLowerCase()} view. The file is delivered privately without browser caching and contains no shopper contact details.`}
        actions={
          <a className="btn sm" href={data.exportHref}>
            Download CSV
          </a>
        }
      >
        {data.orderCount === 0 ? (
          <Empty>
            There are no orders in this period yet, so there is nothing to
            export.
          </Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <p className="card-hint" style={{ margin: 0 }}>
              Includes revenue, refunds, COGS, shipping, processing fees,
              attributed ad spend, overhead, contribution profit, and profit
              for {data.orderCount.toLocaleString()} order
              {data.orderCount === 1 ? "" : "s"}.
            </p>
            <p className="card-hint" style={{ margin: 0 }}>
              Missing COGS and configured costs remain marked in the export.
              Unconnected paid marketing is not silently added as zero.
            </p>
          </div>
        )}
      </Card>

      <Card
        title="Scheduled Reports"
        hint="Scale includes a weekly profitability summary. It stays off until email delivery is configured for this deployment."
      >
        <p className="card-hint" style={{ margin: 0 }}>
          Manage report preferences and delivery status in Costs &amp;
          Connections.
        </p>
      </Card>
    </div>
  );
}

export default function Reports() {
  return <ReportsView data={useLoaderData<typeof loader>()} />;
}
