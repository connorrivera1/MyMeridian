import { formatMoney, ratio, type Cents, type Micros } from "./money";

/**
 * Price optimisation.
 *
 * This estimates a real price elasticity of demand from the store's own
 * observed price changes, then solves for the profit-maximising price. Where
 * the data cannot support that — most variants have never had a price change —
 * it says so and falls back to a margin-target rule instead of inventing an
 * elasticity. A confident-sounding wrong price is far more expensive than
 * "not enough data yet".
 */

export type PricingMethod =
  | "ELASTICITY_REGRESSION"
  | "MARGIN_TARGET"
  /** Deliberately holding price on a loss leader that is doing its job. */
  | "STRATEGIC_HOLD"
  /** Priced under cost — a business decision, not a pricing tweak. */
  | "BELOW_COST"
  | "INSUFFICIENT_DATA";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface PriceObservation {
  date: Date;
  priceCents: Cents;
  units: number;
  /**
   * Store-wide demand that day (total orders). Used to divide out the store's
   * own growth and seasonality before attributing anything to price.
   * Defaults to 1, which reduces to a raw units regression.
   */
  demandIndex?: number;
}

export interface PricingInput {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  currentPriceCents: Cents;
  unitCostMicros: Micros;
  observations: PriceObservation[];
  /**
   * Set when the profit engine has classified this product as a working loss
   * leader. Raising the price of a tripwire that is profitably buying customers
   * is the single most expensive "optimisation" this tool could suggest.
   */
  isStrategicLossLeader?: boolean;
}

export interface PricingRecommendation {
  variantId: string;
  productTitle: string;
  variantTitle: string;

  currentPriceCents: Cents;
  suggestedPriceCents: Cents;
  priceChangePct: number;

  elasticity: number | null;
  rSquared: number | null;
  distinctPricePoints: number;
  observationDays: number;

  currentMarginPct: number | null;
  projectedMarginPct: number | null;

  expectedUnitsDeltaPct: number;
  /** Projected monthly contribution profit change, in cents. */
  expectedProfitDeltaCents: Cents;

  method: PricingMethod;
  confidence: Confidence;
  rationale: string;
}

/** Never recommend a price that leaves less than this contribution margin. */
const MIN_MARGIN = 0.15;
/** Target margin used when elasticity cannot be estimated. */
const TARGET_MARGIN = 0.35;
/** Hard cap on any single recommended move, in either direction. */
const MAX_CHANGE = 0.25;
/** Horizon used to express the profit impact. */
const PROJECTION_DAYS = 30;

const MIN_OBSERVATIONS_MEDIUM = 30;
const MIN_OBSERVATIONS_HIGH = 60;

interface Elasticity {
  value: number;
  rSquared: number;
  pricePoints: number;
  observationDays: number;
  /** Scale factor A in Q = A·P^e */
  scale: number;
}

/**
 * Weighted log-log least squares: ln(Q/D) = ln(A) + e·ln(P).
 *
 * Each distinct price point contributes one observation, weighted by how many
 * days the store actually held that price — a price that ran for two months is
 * worth more evidence than one that ran for a weekend.
 *
 * The regressand is the product's *share* of store-wide demand, not its raw
 * units. This matters enormously: a growing store's volume rises over time, and
 * price changes are correlated with time, so a naive units-versus-price fit
 * hands the store's growth to whichever price happened to be in force later.
 * On a store that quadrupled in six months that turns a true elasticity of −2
 * into −6, or even flips its sign.
 */
export function estimateElasticity(
  observations: readonly PriceObservation[],
): Elasticity | null {
  const byPrice = new Map<number, { units: number; demand: number; days: number }>();

  for (const obs of observations) {
    if (obs.priceCents <= 0) continue;
    const bucket = byPrice.get(obs.priceCents) ?? { units: 0, demand: 0, days: 0 };
    bucket.units += obs.units;
    bucket.demand += obs.demandIndex ?? 1;
    bucket.days += 1;
    byPrice.set(obs.priceCents, bucket);
  }

  const points = [...byPrice.entries()]
    .map(([priceCents, { units, demand, days }]) => ({
      lnPrice: Math.log(priceCents / 100),
      lnUnits: Math.log(units / (demand > 0 ? demand : days)),
      weight: days,
    }))
    // A price point that sold nothing yields -Infinity and drops out here.
    // Adding a smoothing constant instead would bias every low-volume variant's
    // elasticity toward zero, which is exactly where most of the catalogue sits.
    .filter((p) => Number.isFinite(p.lnPrice) && Number.isFinite(p.lnUnits));

  if (points.length < 2) return null;

  const totalWeight = points.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return null;

  const meanX = points.reduce((s, p) => s + p.weight * p.lnPrice, 0) / totalWeight;
  const meanY = points.reduce((s, p) => s + p.weight * p.lnUnits, 0) / totalWeight;

  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += p.weight * (p.lnPrice - meanX) * (p.lnUnits - meanY);
    sxx += p.weight * (p.lnPrice - meanX) ** 2;
  }

  // Every observation sat at the same price — no variation to learn from.
  if (sxx <= 1e-9) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const predicted = intercept + slope * p.lnPrice;
    ssRes += p.weight * (p.lnUnits - predicted) ** 2;
    ssTot += p.weight * (p.lnUnits - meanY) ** 2;
  }
  const rSquared = ssTot > 1e-9 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  return {
    value: slope,
    rSquared,
    pricePoints: points.length,
    observationDays: observations.length,
    scale: Math.exp(intercept),
  };
}

function confidenceFor(e: Elasticity): Confidence {
  if (
    e.pricePoints >= 3 &&
    e.observationDays >= MIN_OBSERVATIONS_HIGH &&
    e.rSquared >= 0.5
  ) {
    return "HIGH";
  }
  if (
    e.pricePoints >= 2 &&
    e.observationDays >= MIN_OBSERVATIONS_MEDIUM &&
    e.rSquared >= 0.25
  ) {
    return "MEDIUM";
  }
  return "LOW";
}

/**
 * Nudge to a psychologically conventional ending (.95 / .99) without ever
 * pushing the price back below the floor the caller established.
 */
function roundToCharmPrice(cents: Cents, floorCents: Cents): Cents {
  if (cents <= 0) return cents;

  const dollars = Math.floor(cents / 100);
  const candidates = [
    (dollars - 1) * 100 + 95,
    (dollars - 1) * 100 + 99,
    dollars * 100 + 95,
    dollars * 100 + 99,
  ];

  const viable = candidates.filter((c) => c >= floorCents);
  if (viable.length === 0) return Math.max(cents, floorCents);

  return viable.reduce((best, c) =>
    Math.abs(c - cents) < Math.abs(best - cents) ? c : best,
  );
}

function marginAt(priceCents: Cents, unitCostCents: Cents): number | null {
  return ratio(priceCents - unitCostCents, priceCents);
}

export function recommendPrice(input: PricingInput): PricingRecommendation {
  const unitCostCents = Math.round(input.unitCostMicros / 100);
  const currentMarginPct = marginAt(input.currentPriceCents, unitCostCents);

  const totalUnits = input.observations.reduce((s, o) => s + o.units, 0);
  const dailyUnits =
    input.observations.length > 0 ? totalUnits / input.observations.length : 0;

  const floorCents = Math.ceil(unitCostCents / (1 - MIN_MARGIN));
  const minCents = Math.max(
    floorCents,
    Math.round(input.currentPriceCents * (1 - MAX_CHANGE)),
  );
  const maxCents = Math.round(input.currentPriceCents * (1 + MAX_CHANGE));

  const base = {
    variantId: input.variantId,
    productTitle: input.productTitle,
    variantTitle: input.variantTitle,
    currentPriceCents: input.currentPriceCents,
    currentMarginPct,
    distinctPricePoints: new Set(input.observations.map((o) => o.priceCents)).size,
    observationDays: input.observations.length,
  };

  const elasticity = estimateElasticity(input.observations);
  const confidence = elasticity ? confidenceFor(elasticity) : "LOW";

  const hold = (method: PricingMethod, rationale: string): PricingRecommendation => ({
    ...base,
    suggestedPriceCents: input.currentPriceCents,
    priceChangePct: 0,
    elasticity: elasticity?.value ?? null,
    rSquared: elasticity?.rSquared ?? null,
    projectedMarginPct: currentMarginPct,
    expectedUnitsDeltaPct: 0,
    expectedProfitDeltaCents: 0,
    method,
    confidence: "LOW",
    rationale,
  });

  // --- Guard: a loss leader that is working is not a pricing problem -------
  if (input.isStrategicLossLeader) {
    return hold(
      "STRATEGIC_HOLD",
      `This product loses money on the order it appears in, but the customers ` +
        `it brings in earn that back and more on later orders. Repricing it to ` +
        `hit a margin target would break the funnel it is feeding. Hold the ` +
        `price and watch the cohort instead.`,
    );
  }

  // --- Guard: below cost is a strategy question, not a percentage tweak ----
  if (input.currentPriceCents <= unitCostCents) {
    return hold(
      "BELOW_COST",
      `Every unit sells for ${formatMoney(input.currentPriceCents)} against a ` +
        `${formatMoney(unitCostCents)} unit cost, so each sale loses ` +
        `${formatMoney(unitCostCents - input.currentPriceCents)} before any ` +
        `shipping or ad spend. Reaching a viable margin needs a ` +
        `${formatPct((floorCents - input.currentPriceCents) / input.currentPriceCents)} ` +
        `increase, well beyond a routine adjustment — this is a decision about ` +
        `whether to keep selling it, not a price to nudge.`,
    );
  }

  // --- Path 1: we have a usable demand curve ------------------------------
  if (elasticity && confidence !== "LOW" && elasticity.value < -1) {
    // Π = (P − c)·A·P^e is maximised at P* = c·e / (1 + e) for elastic demand.
    const optimal = (unitCostCents * elasticity.value) / (1 + elasticity.value);
    const bounded = Math.min(maxCents, Math.max(minCents, Math.round(optimal)));
    // Charm rounding is bounded by the margin floor, not by the change cap —
    // the cap is a guard rail against large moves, and landing a cent either
    // side of it is not worth showing the merchant $15.00 instead of $14.99.
    const suggested = roundToCharmPrice(bounded, floorCents);

    const priceRatio = suggested / input.currentPriceCents;
    const unitsDelta = priceRatio ** elasticity.value - 1;

    const projectedDailyUnits = dailyUnits * (1 + unitsDelta);
    const profitDeltaCents = Math.round(
      PROJECTION_DAYS *
        (projectedDailyUnits * (suggested - unitCostCents) -
          dailyUnits * (input.currentPriceCents - unitCostCents)),
    );

    return {
      ...base,
      suggestedPriceCents: suggested,
      priceChangePct: priceRatio - 1,
      elasticity: elasticity.value,
      rSquared: elasticity.rSquared,
      projectedMarginPct: marginAt(suggested, unitCostCents),
      expectedUnitsDeltaPct: unitsDelta,
      expectedProfitDeltaCents: profitDeltaCents,
      method: "ELASTICITY_REGRESSION",
      confidence,
      rationale: buildElasticityRationale({
        elasticity: elasticity.value,
        rSquared: elasticity.rSquared,
        pricePoints: elasticity.pricePoints,
        currentPriceCents: input.currentPriceCents,
        suggestedCents: suggested,
        unitsDelta,
        profitDeltaCents,
      }),
    };
  }

  // --- Path 2: no demand curve, but the margin is clearly too thin ---------
  if (currentMarginPct !== null && currentMarginPct < TARGET_MARGIN) {
    const targetPrice = Math.ceil(unitCostCents / (1 - TARGET_MARGIN));
    const bounded = Math.min(maxCents, Math.max(minCents, targetPrice));
    const suggested = roundToCharmPrice(bounded, floorCents);

    if (suggested > input.currentPriceCents) {
      return {
        ...base,
        suggestedPriceCents: suggested,
        priceChangePct: suggested / input.currentPriceCents - 1,
        elasticity: elasticity?.value ?? null,
        rSquared: elasticity?.rSquared ?? null,
        projectedMarginPct: marginAt(suggested, unitCostCents),
        // Deliberately not projecting a unit change: without an elasticity
        // estimate any number here would be fabricated.
        expectedUnitsDeltaPct: 0,
        expectedProfitDeltaCents: Math.round(
          PROJECTION_DAYS * dailyUnits * (suggested - input.currentPriceCents),
        ),
        method: "MARGIN_TARGET",
        confidence: "LOW",
        rationale:
          `Contribution margin is ${formatPct(currentMarginPct)}, below the ` +
          `${formatPct(TARGET_MARGIN)} target. Moving to ` +
          `${formatMoney(suggested)} restores it. This variant has never ` +
          `changed price, so there is no demand curve to estimate — treat the ` +
          `volume impact as unknown and watch units for two weeks after the change.`,
      };
    }
  }

  // --- Path 3: say nothing rather than guess ------------------------------
  return {
    ...base,
    suggestedPriceCents: input.currentPriceCents,
    priceChangePct: 0,
    elasticity: elasticity?.value ?? null,
    rSquared: elasticity?.rSquared ?? null,
    projectedMarginPct: currentMarginPct,
    expectedUnitsDeltaPct: 0,
    expectedProfitDeltaCents: 0,
    method: "INSUFFICIENT_DATA",
    confidence: "LOW",
    rationale: !elasticity
      ? `This variant has held one price for its whole history, so there is no ` +
        `demand response to learn from. A two-week test at ±10% would produce ` +
        `enough variation to estimate elasticity.`
      : elasticity.value >= 0
        ? // A positive elasticity says units rose as price rose. That is almost
          // never real demand behaviour — it means something other than price
          // (a promotion, a season, a campaign) drove the volume, and the fit
          // has picked that up instead. Saying "price-insensitive, consider
          // raising" here would be actively dangerous advice.
          `The fitted relationship came out backwards — units rose as price rose ` +
          `(elasticity ${elasticity.value.toFixed(2)}, R² ${elasticity.rSquared.toFixed(2)}). ` +
          `That means something other than price moved demand over this window, ` +
          `so no price conclusion can be drawn from it. A controlled test, holding ` +
          `promotions steady, is the only way to isolate the price effect.`
        : `Demand looks price-insensitive here (elasticity ${elasticity.value.toFixed(2)}), ` +
          `which often means there is room to raise the price — but the fit is too ` +
          `weak (R² ${elasticity.rSquared.toFixed(2)}) to name a number. Run a ` +
          `deliberate price test to generate the variation this needs.`,
  };
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function buildElasticityRationale(args: {
  elasticity: number;
  rSquared: number;
  pricePoints: number;
  currentPriceCents: Cents;
  suggestedCents: Cents;
  unitsDelta: number;
  profitDeltaCents: Cents;
}): string {
  const direction = args.suggestedCents > args.currentPriceCents ? "increase" : "decrease";
  const unitsWord = args.unitsDelta >= 0 ? "rise" : "fall";

  return (
    `Across ${args.pricePoints} observed price points, demand elasticity is ` +
    `${args.elasticity.toFixed(2)} (R² ${args.rSquared.toFixed(2)}) — a 1% price ` +
    `move shifts units by about ${Math.abs(args.elasticity).toFixed(2)}%. ` +
    `Profit peaks at ${formatMoney(args.suggestedCents)}, a ` +
    `${formatPct(Math.abs(args.suggestedCents / args.currentPriceCents - 1))} ${direction}. ` +
    `Units should ${unitsWord} roughly ${formatPct(Math.abs(args.unitsDelta))}, ` +
    `with contribution profit changing by about ` +
    `${formatMoney(args.profitDeltaCents)} over 30 days.`
  );
}

export function recommendPrices(
  inputs: readonly PricingInput[],
): PricingRecommendation[] {
  return inputs
    .map(recommendPrice)
    .filter((rec) => rec.method !== "INSUFFICIENT_DATA" || rec.elasticity !== null)
    .sort((a, b) => b.expectedProfitDeltaCents - a.expectedProfitDeltaCents);
}
