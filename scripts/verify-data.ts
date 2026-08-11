import { PrismaClient } from "@prisma/client";
import {
  loadAdSpend,
  loadCostRules,
  loadEngineOrders,
  loadCapacityDays,
  loadProductMeta,
} from "~/data/queries.server";
import { recomputeShopProfitability } from "~/lib/recompute.server";
import { computeProfitForPeriod } from "~/engine/profit";
import { computeProductProfitability } from "~/engine/products";
import { computeChannelPerformance } from "~/engine/acquisition";
import { analyseCapacity } from "~/engine/capacity";
import { formatMoney } from "~/engine/money";

const prisma = new PrismaClient();

async function main() {
  const domain = process.argv[2] ?? "meridian-demo.myshopify.com";
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain },
  });

  const span = await prisma.order.aggregate({
    where: { shopId: shop.id },
    _min: { processedAt: true },
    _max: { processedAt: true },
  });
  const range = {
    from: span._min.processedAt ?? new Date("2026-02-01"),
    to: span._max.processedAt ?? new Date("2026-08-04"),
  };
  const [orders, spend, rules, products, capacity] = await Promise.all([
    loadEngineOrders(shop.id, range),
    loadAdSpend(shop.id, range),
    loadCostRules(shop.id),
    loadProductMeta(shop.id),
    loadCapacityDays(shop.id, range),
  ]);

  const period = computeProfitForPeriod(orders, spend, rules, shop.timezone);

  console.log("=== P&L ===");
  console.log("Net revenue      ", formatMoney(period.netRevenueCents));
  console.log("  incl. return fees kept", formatMoney(period.returnFeesRetainedCents));
  console.log("COGS             ", formatMoney(period.cogsCents));
  console.log("Shipping         ", formatMoney(period.shippingCostCents));
  console.log("Return shipping  ", formatMoney(period.returnShippingCostCents));
  console.log("Payment fees     ", formatMoney(period.paymentFeeCents));
  console.log("Pick/pack        ", formatMoney(period.pickPackCents));
  console.log("Ad spend         ", formatMoney(period.totalAdCostCents));
  console.log("Overhead         ", formatMoney(period.overheadCents));
  console.log("NET PROFIT       ", formatMoney(period.netProfitCents));
  console.log("Net margin       ", ((period.netMarginPct ?? 0) * 100).toFixed(1) + "%");
  console.log("Profit / order   ", formatMoney(period.profitPerOrderCents));

  console.log("\n=== PRODUCTS ===");
  const productPerf = computeProductProfitability(orders, period.orders, products);
  for (const p of productPerf) {
    console.log(
      p.classification.padEnd(23),
      p.title.padEnd(30),
      formatMoney(p.contributionProfitCents).padStart(12),
      `margin ${((p.marginPct ?? 0) * 100).toFixed(0)}%`.padStart(12),
      `acq ${p.acquiredCustomers}`.padStart(9),
      `downstream ${formatMoney(p.downstreamProfitCents)}`,
    );
  }

  console.log("\n=== CHANNELS ===");
  const channels = computeChannelPerformance(orders, period.orders, spend, {
    periodStart: range.from,
    periodEnd: range.to,
  });
  for (const c of channels) {
    console.log(
      c.channel.padEnd(16),
      c.verdict.padEnd(13),
      `spend ${formatMoney(c.spendCents)}`.padStart(20),
      `CAC ${c.cacCents !== null ? formatMoney(c.cacCents) : "—"}`.padStart(14),
      `LTV90 ${formatMoney(c.ltv90Cents)}`.padStart(16),
      `LTV:CAC ${c.ltvToCacRatio?.toFixed(2) ?? "—"}`.padStart(14),
      `ROAS ${c.measuredRoas?.toFixed(2) ?? "—"} vs plat ${c.platformRoas?.toFixed(2) ?? "—"}`,
      `payback ${c.paybackDays ?? "never"}d`,
    );
  }

  console.log("\n=== CAPACITY ===");
  const cap = analyseCapacity(capacity, { slaDays: shop.fulfillmentSlaDays });
  console.log("Backlog          ", cap.currentBacklog);
  console.log("Throughput/day   ", cap.throughputPerDay.toFixed(1));
  console.log("Capacity/day     ", cap.effectiveCapacityPerDay.toFixed(1));
  console.log("Utilisation      ", ((cap.utilisationPct ?? 0) * 100).toFixed(0) + "%");
  console.log("Days to clear    ", cap.daysToClearBacklog?.toFixed(1));
  console.log("Demand trend     ", ((cap.demandTrendPct ?? 0) * 100).toFixed(0) + "%");
  console.log("Alerts:");
  for (const a of cap.alerts) console.log("  -", a.severity, "|", a.title);

  console.log("\n=== PRICING RECS ===");
  const recs = await prisma.pricingRecommendation.findMany({
    where: { shopId: shop.id },
    include: { variant: { include: { product: true } } },
  });
  for (const r of recs) {
    console.log(
      r.variant.product.title.padEnd(30),
      `$${r.currentPrice} -> $${r.suggestedPrice}`.padEnd(22),
      r.method.padEnd(24),
      r.confidence.padEnd(8),
      `e=${r.elasticity ?? "—"}`,
    );
  }

  // -------------------------------------------------------------------------
  // Reconciliation: the materialised ledger against a fresh engine run.
  //
  // recomputeShopProfitability writes per-order profit and reports the engine
  // total. Unattributed ad spend is subtracted in that period total but never
  // lands on any order row, so the invariant is:
  //
  //   Σ Order.netProfit  ==  engine net profit + unattributed ad spend
  //
  // to the cent, over the whole history. Any drift means a writer bypassed the
  // engine or a conversion rounded twice — either is a bug, and this script's
  // exit code says so.
  // -------------------------------------------------------------------------
  console.log("\n=== RECONCILIATION (whole history) ===");
  const recompute = await recomputeShopProfitability(shop.id);
  const [materialised] = await prisma.$queryRaw<
    Array<{
      net: string | null;
      contribution: string | null;
      returnFees: string | null;
      multicurrencyOrders: bigint;
      labelAdjustments: string | null;
    }>
  >`
    SELECT
      SUM(o."netProfit")::text AS net,
      SUM(o."contributionProfit")::text AS contribution,
      SUM(o."returnFeesRetained")::text AS "returnFees",
      COUNT(*) FILTER (WHERE o."presentmentCurrency" IS NOT NULL) AS "multicurrencyOrders",
      (SELECT SUM(a.amount)::text FROM "ShippingLabelAdjustment" a
        WHERE a."shopId" = ${shop.id}) AS "labelAdjustments"
    FROM "Order" o
    WHERE o."shopId" = ${shop.id}
  `;

  const materialisedNetCents = Math.round(Number(materialised?.net ?? 0) * 100);
  const engineNetLandedCents =
    recompute.netProfitCents + recompute.unattributedAdSpendCents;
  const drift = materialisedNetCents - engineNetLandedCents;

  console.log("Orders recomputed         ", recompute.ordersUpdated);
  console.log("Engine net profit         ", formatMoney(recompute.netProfitCents));
  console.log(
    "  of which unattributed ads",
    formatMoney(recompute.unattributedAdSpendCents),
  );
  console.log("Σ materialised net profit ", formatMoney(materialisedNetCents));
  console.log(
    "Multi-currency orders     ",
    Number(materialised?.multicurrencyOrders ?? 0),
  );
  console.log(
    "Return fees retained      ",
    formatMoney(Math.round(Number(materialised?.returnFees ?? 0) * 100)),
  );
  console.log(
    "Label adjustments (net)   ",
    formatMoney(Math.round(Number(materialised?.labelAdjustments ?? 0) * 100)),
  );

  if (drift === 0) {
    console.log("RECONCILIATION            OK — ledger matches engine to the cent");
  } else {
    console.error(
      `RECONCILIATION            DRIFT of ${formatMoney(drift)} — ` +
        "materialised orders disagree with the engine",
    );
    process.exitCode = 1;
  }
}

main().finally(() => prisma.$disconnect());
