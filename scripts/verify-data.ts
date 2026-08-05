import { PrismaClient } from "@prisma/client";
import {
  loadAdSpend,
  loadCostRules,
  loadEngineOrders,
  loadCapacityDays,
  loadProductMeta,
} from "~/data/queries.server";
import { computeProfitForPeriod } from "~/engine/profit";
import { computeProductProfitability } from "~/engine/products";
import { computeChannelPerformance } from "~/engine/acquisition";
import { analyseCapacity } from "~/engine/capacity";
import { formatMoney } from "~/engine/money";

const prisma = new PrismaClient();

async function main() {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: "meridian-demo.myshopify.com" },
  });

  const range = { from: new Date("2026-02-01"), to: new Date("2026-08-04") };
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
  console.log("COGS             ", formatMoney(period.cogsCents));
  console.log("Shipping         ", formatMoney(period.shippingCostCents));
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
}

main().finally(() => prisma.$disconnect());
