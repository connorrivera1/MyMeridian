/**
 * Measures how well the elasticity model recovers each product's true price
 * elasticity from the seeded store.
 *
 * Only meaningful against the demo seed, where the true elasticity that
 * generated demand is known. It exists so changes to the pricing model can be
 * judged against ground truth instead of vibes.
 *
 *   npx tsx scripts/elasticity-accuracy.ts
 */
import { PrismaClient } from "@prisma/client";

import { loadPricingInputs } from "~/data/queries.server";
import { estimateElasticity } from "~/engine/pricing";

const prisma = new PrismaClient();

/**
 * Mirrors CATALOGUE in prisma/seed.ts.
 *
 * Read these as the *declared* parameter, not as the elasticity the data can
 * actually show. The seed picks basket items by normalised weighted sampling,
 * so a product whose weight doubles gains less than double the share — a
 * declared −2.1 surfaces as roughly −1.8 in observable share terms before
 * channel-mix drift touches it. Estimates landing below the declared figure are
 * expected; the estimator is verified exact against clean synthetic demand in
 * app/engine/pricing.test.ts. What matters here is the R² separation between
 * products that had a real price test and products that did not.
 */
const TRUE_ELASTICITY: Record<string, number> = {
  "Alpine Shell Jacket": -1.4,
  "Trail Runner GTX": -1.8,
  "Merino Base Layer": -2.1,
  "Summit Pack 32L": -1.5,
  "Thermal Beanie": -2.4,
  "Carbon Trekking Poles": -1.9,
  "Down Sleeping Bag −7°C": -1.3,
  "Ultralight Camp Stove": -1.7,
  "Trailhead Starter Kit": -2.8,
  "Clearance Water Bottle": -2.2,
  "Hydration Vest 12L": -1.6,
  "Merino Wool Socks (3-pack)": -2.0,
  "Headlamp Pro 800": -1.8,
  "Storm Rain Pants": -1.7,
};

/** Products the seed gives a deliberate list-price change. */
const HAS_REAL_PRICE_CHANGE = new Set([
  "Merino Base Layer",
  "Thermal Beanie",
  "Merino Wool Socks (3-pack)",
  "Headlamp Pro 800",
]);

const RANGE = { from: new Date("2026-02-01"), to: new Date("2026-08-04") };

/** Sweep bucket widths to find where attenuation bias is smallest. */
async function sweep(shopId: string) {
  console.log("bucket %   MAE   mean est   (true mean -2.08)");
  console.log("-".repeat(46));

  for (const pct of [0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1, 0.15]) {
    const inputs = await loadPricingInputs(shopId, RANGE, { priceBucketPct: pct });

    const errors: number[] = [];
    const estimates: number[] = [];

    for (const input of inputs) {
      if (!HAS_REAL_PRICE_CHANGE.has(input.productTitle)) continue;
      const estimate = estimateElasticity(input.observations);
      const truth = TRUE_ELASTICITY[input.productTitle];
      if (!estimate || truth === undefined) continue;
      errors.push(Math.abs(estimate.value - truth));
      estimates.push(estimate.value);
    }

    const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
    const meanEst = estimates.reduce((a, b) => a + b, 0) / estimates.length;

    console.log(
      `${(pct * 100).toFixed(0).padStart(6)}%   ${mae.toFixed(2)}   ${meanEst.toFixed(2).padStart(7)}`,
    );
  }
  console.log();
}

async function main() {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { domain: "meridian-demo.myshopify.com" },
  });

  if (process.argv.includes("--sweep")) {
    await sweep(shop.id);
  }

  const inputs = await loadPricingInputs(shop.id, RANGE);

  console.log(
    "product".padEnd(30),
    "true".padStart(6),
    "est".padStart(8),
    "R²".padStart(6),
    "pts".padStart(5),
    "  price test?",
  );
  console.log("-".repeat(78));

  const errors: number[] = [];

  for (const input of inputs) {
    const estimate = estimateElasticity(input.observations);
    const truth = TRUE_ELASTICITY[input.productTitle];
    const tested = HAS_REAL_PRICE_CHANGE.has(input.productTitle);

    if (tested && estimate && truth !== undefined) {
      errors.push(Math.abs(estimate.value - truth));
    }

    console.log(
      input.productTitle.padEnd(30),
      String(truth ?? "?").padStart(6),
      (estimate ? estimate.value.toFixed(2) : "—").padStart(8),
      (estimate ? estimate.rSquared.toFixed(2) : "—").padStart(6),
      String(estimate?.pricePoints ?? 0).padStart(5),
      tested ? "  <- deliberate" : "",
    );
  }

  if (errors.length > 0) {
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    console.log(
      `\nMean absolute error on products with a real price change: ${mean.toFixed(2)}`,
    );
  }
}

main().finally(() => prisma.$disconnect());
