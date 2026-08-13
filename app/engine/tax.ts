import { TaxJurisdictionType, TaxRegime } from "@prisma/client";

import { toCents, type MoneyInput } from "./money";

export interface TaxLineInput {
  title?: string | null;
  rate?: string | number | null;
  price?: MoneyInput;
  price_set?: { shop_money?: { amount?: MoneyInput } } | null;
  priceSet?: { shopMoney?: { amount?: MoneyInput } } | null;
  source?: string | null;
  channel_liable?: boolean | null;
  channelLiable?: boolean | null;
}

export interface TaxableLineInput {
  tax_lines?: readonly TaxLineInput[];
  taxLines?: readonly TaxLineInput[];
}

export interface OrderTaxInput {
  totalTax: MoneyInput;
  taxesIncluded?: boolean;
  countryCode?: string | null;
  regionCode?: string | null;
  lineItems?: readonly TaxableLineInput[];
  shippingLines?: readonly TaxableLineInput[];
  /** Aggregate Shopify lines are only used when item/shipping detail is absent. */
  taxLines?: readonly TaxLineInput[];
}

export interface OrderTaxComponentResult {
  sourceKey: string;
  regime: TaxRegime;
  jurisdictionType: TaxJurisdictionType;
  title: string;
  source: string | null;
  countryCode: string | null;
  regionCode: string | null;
  rate: string | null;
  taxableAmount: string;
  reportedTaxCents: number;
  taxAmountCents: number;
  lineItemTaxCents: number;
  shippingTaxCents: number;
  roundingAdjustmentCents: number;
  channelLiable: boolean | null;
  includedInPrice: boolean;
}

const EU_VAT_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
  "FR", "GR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL",
  "PT", "RO", "SE", "SI", "SK", "XI",
]);

function normalizedCode(value: string | null | undefined, max: number) {
  const code = String(value ?? "").trim().toUpperCase();
  return code ? code.slice(0, max) : null;
}

function parseRate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const scaled = `${whole}.${(fraction + "00000000").slice(0, 8)}`;
  return Number(scaled) > 0 ? scaled : null;
}

function rateUnits(rate: string | null): bigint {
  if (!rate) return 0n;
  const [whole = "0", fraction = ""] = rate.split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

function bigintCentsDecimal(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

/** Largest-remainder allocation using integer fractions, never binary floats. */
export function allocateTaxCents(
  total: number,
  weights: readonly number[],
): number[] {
  if (weights.length === 0) return [];
  const safeWeights = weights.map((weight) => Math.max(0, Math.trunc(weight)));
  let weightTotal = safeWeights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (weightTotal === 0n) {
    safeWeights.fill(1);
    weightTotal = BigInt(safeWeights.length);
  }

  const sign = total < 0 ? -1n : 1n;
  const absolute = BigInt(Math.abs(Math.trunc(total)));
  const shares = safeWeights.map((weight, index) => {
    const numerator = absolute * BigInt(weight);
    return {
      index,
      cents: numerator / weightTotal,
      remainder: numerator % weightTotal,
    };
  });
  let leftover = absolute - shares.reduce((sum, share) => sum + share.cents, 0n);
  const remainderOrder = [...shares].sort(
    (a, b) =>
      (a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1),
  );
  for (let index = 0; leftover > 0n; index++, leftover--) {
    remainderOrder[index % remainderOrder.length]!.cents += 1n;
  }
  return shares.map((share) => Number(share.cents * sign));
}

function classify(
  title: string,
  countryCode: string | null,
): { regime: TaxRegime; jurisdictionType: TaxJurisdictionType } {
  const lower = title.toLowerCase();
  if (EU_VAT_COUNTRIES.has(countryCode ?? "") || /\bvat\b/.test(lower)) {
    return { regime: TaxRegime.EU_VAT, jurisdictionType: TaxJurisdictionType.VAT };
  }
  if (/\b(gst|hst|qst|pst)\b/.test(lower)) {
    return { regime: TaxRegime.GST, jurisdictionType: TaxJurisdictionType.NATIONAL };
  }

  const us = countryCode === "US" || /sales tax|use tax/.test(lower);
  if (us) {
    if (/county/.test(lower)) return { regime: TaxRegime.US_SALES_TAX, jurisdictionType: TaxJurisdictionType.COUNTY };
    if (/city|municipal/.test(lower)) return { regime: TaxRegime.US_SALES_TAX, jurisdictionType: TaxJurisdictionType.CITY };
    if (/district|special|local/.test(lower)) return { regime: TaxRegime.US_SALES_TAX, jurisdictionType: TaxJurisdictionType.DISTRICT };
    return { regime: TaxRegime.US_SALES_TAX, jurisdictionType: TaxJurisdictionType.STATE };
  }
  return { regime: TaxRegime.OTHER, jurisdictionType: TaxJurisdictionType.OTHER };
}

function taxLineAmount(line: TaxLineInput): number {
  return toCents(
    line.price_set?.shop_money?.amount ??
      line.priceSet?.shopMoney?.amount ??
      line.price,
  );
}

function taxLines(line: TaxableLineInput): readonly TaxLineInput[] {
  return line.tax_lines ?? line.taxLines ?? [];
}

interface Group {
  key: string;
  title: string;
  source: string | null;
  rate: string | null;
  channelLiable: boolean | null;
  lineCents: number;
  shippingCents: number;
}

function addLines(
  groups: Map<string, Group>,
  lines: readonly TaxLineInput[],
  kind: "line" | "shipping",
) {
  for (const line of lines) {
    const title = String(line.title ?? "Tax").trim() || "Tax";
    const source = String(line.source ?? "").trim() || null;
    const rate = parseRate(line.rate);
    const liable = line.channel_liable ?? line.channelLiable ?? null;
    const key = [title.toLowerCase(), rate ?? "", source?.toLowerCase() ?? "", String(liable)].join("|");
    const group = groups.get(key) ?? {
      key,
      title,
      source,
      rate,
      channelLiable: liable,
      lineCents: 0,
      shippingCents: 0,
    };
    if (kind === "line") group.lineCents += taxLineAmount(line);
    else group.shippingCents += taxLineAmount(line);
    groups.set(key, group);
  }
}

/**
 * Split Shopify's authoritative order tax to exact cents by jurisdiction.
 * Component amounts always sum to `totalTax`, including awkward compound-tax
 * and inclusive-VAT rounding cases.
 */
export function splitOrderTax(input: OrderTaxInput): OrderTaxComponentResult[] {
  const totalTaxCents = toCents(input.totalTax);
  const countryCode = normalizedCode(input.countryCode, 2);
  const regionCode = normalizedCode(input.regionCode, 16);
  const groups = new Map<string, Group>();

  for (const item of input.lineItems ?? []) addLines(groups, taxLines(item), "line");
  for (const line of input.shippingLines ?? []) addLines(groups, taxLines(line), "shipping");
  if (groups.size === 0) addLines(groups, input.taxLines ?? [], "line");

  if (groups.size === 0) {
    if (totalTaxCents === 0) return [];
    return [{
      sourceKey: "unallocated",
      regime: TaxRegime.UNALLOCATED,
      jurisdictionType: TaxJurisdictionType.UNALLOCATED,
      title: "Unallocated Shopify Tax",
      source: null,
      countryCode,
      regionCode,
      rate: null,
      taxableAmount: "0.00",
      reportedTaxCents: 0,
      taxAmountCents: totalTaxCents,
      lineItemTaxCents: totalTaxCents,
      shippingTaxCents: 0,
      roundingAdjustmentCents: totalTaxCents,
      channelLiable: null,
      includedInPrice: Boolean(input.taxesIncluded),
    }];
  }

  const ordered = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  const reported = ordered.map((group) => group.lineCents + group.shippingCents);
  const allocated = allocateTaxCents(totalTaxCents, reported);

  return ordered.map((group, index) => {
    const reportedTaxCents = reported[index] ?? 0;
    const taxAmountCents = allocated[index] ?? 0;
    const [lineItemTaxCents = 0, shippingTaxCents = 0] = allocateTaxCents(
      taxAmountCents,
      [group.lineCents, group.shippingCents],
    );
    const units = rateUnits(group.rate);
    const taxableAmount = units > 0n
      ? bigintCentsDecimal(roundRatio(BigInt(taxAmountCents) * 100_000_000n, units))
      : "0.00";
    const classification = classify(group.title, countryCode);

    return {
      sourceKey: group.key,
      ...classification,
      title: group.title,
      source: group.source,
      countryCode,
      regionCode,
      rate: group.rate,
      taxableAmount,
      reportedTaxCents,
      taxAmountCents,
      lineItemTaxCents,
      shippingTaxCents,
      roundingAdjustmentCents: taxAmountCents - reportedTaxCents,
      channelLiable: group.channelLiable,
      includedInPrice: Boolean(input.taxesIncluded),
    };
  });
}
