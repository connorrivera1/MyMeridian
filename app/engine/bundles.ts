import {
  costEffectiveAt,
  normaliseCostTimeline,
  type CostVersion,
} from "./cost-history";
import type { Micros } from "./money";

/**
 * Deconstructing multi-pack SKUs into the components they actually contain.
 *
 * A 3-pack has no cost of its own. It costs three of something else, and a
 * store selling singles, 3-packs and a starter kit containing both has a small
 * dependency graph whose leaves are the only things anyone ever invoices. Left
 * to hand maintenance the graph is wrong within a quarter: the single's cost
 * moves, and every pack containing it silently keeps last quarter's number.
 *
 * The rollup therefore resolves a *timeline*, not a number. A bundle's cost
 * changes exactly when one of its components changes, and a merchant restating
 * March needs the pack's March cost — which no snapshot of today's components
 * can give them.
 *
 * Bounded on purpose: cycles, unpriced components and absurd nesting are all
 * reported rather than resolved to a plausible-looking number.
 */

export const MAX_BUNDLE_DEPTH = 8;

export interface BundleEdge {
  bundleVariantId: string;
  componentVariantId: string;
  /** Units of the component in one bundle. */
  quantity: number;
}

export type BundleProblemReason =
  | "CYCLE"
  | "TOO_DEEP"
  | "INVALID_QUANTITY"
  | "MISSING_COMPONENT_COST"
  | "UNRESOLVED_COMPONENT";

export interface BundleProblem {
  bundleVariantId: string;
  reason: BundleProblemReason;
  detail: string;
}

export interface BundleResolution {
  /** Derived cost timelines, keyed by bundle variant id. */
  timelines: Map<string, CostVersion[]>;
  problems: BundleProblem[];
}

interface AdjacencyEntry {
  componentVariantId: string;
  quantity: number;
}

function buildAdjacency(edges: readonly BundleEdge[]): {
  adjacency: Map<string, AdjacencyEntry[]>;
  problems: BundleProblem[];
} {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  const problems: BundleProblem[] = [];

  for (const edge of edges) {
    // A zero or negative quantity is not a cheaper bundle, it is a data error,
    // and letting it through would quietly reduce a pack's COGS.
    if (!Number.isFinite(edge.quantity) || edge.quantity <= 0) {
      problems.push({
        bundleVariantId: edge.bundleVariantId,
        reason: "INVALID_QUANTITY",
        detail: `Component ${edge.componentVariantId} has quantity ${edge.quantity}`,
      });
      continue;
    }

    const list = adjacency.get(edge.bundleVariantId);
    const entry = {
      componentVariantId: edge.componentVariantId,
      quantity: Math.trunc(edge.quantity),
    };
    if (list) list.push(entry);
    else adjacency.set(edge.bundleVariantId, [entry]);
  }

  return { adjacency, problems };
}

/**
 * Resolve every bundle's derived cost timeline from its components' timelines.
 *
 * `baseTimelines` are the costs Meridian was told directly — Shopify's own, or
 * the merchant's. A variant that is both a bundle and carries a direct cost
 * resolves to the derived one: the whole point of mapping a 3-pack is that its
 * own cost field was the thing that could not be trusted.
 *
 * Resolution is depth-first with an explicit in-progress set, so a mapping that
 * makes a bundle contain itself — directly or through four hops — is reported
 * as a cycle instead of overflowing the stack.
 */
export function resolveBundleCostTimelines(
  edges: readonly BundleEdge[],
  baseTimelines: ReadonlyMap<string, readonly CostVersion[]>,
): BundleResolution {
  const { adjacency, problems } = buildAdjacency(edges);
  const timelines = new Map<string, CostVersion[]>();

  const resolved = new Map<string, CostVersion[] | null>();
  const inProgress = new Set<string>();

  const fail = (
    bundleVariantId: string,
    reason: BundleProblemReason,
    detail: string,
  ): null => {
    // A cycle surfaces twice on the way back up the stack — once as the cycle
    // itself, then again as the caller's unresolvable component. Report the
    // first, specific diagnosis and drop the echo.
    if (!resolved.has(bundleVariantId)) {
      problems.push({ bundleVariantId, reason, detail });
    }
    resolved.set(bundleVariantId, null);
    return null;
  };

  /** The timeline for a variant: derived if it is a bundle, direct otherwise. */
  const resolve = (
    variantId: string,
    depth: number,
  ): readonly CostVersion[] | null => {
    const components = adjacency.get(variantId);
    if (!components || components.length === 0) {
      const base = baseTimelines.get(variantId);
      return base && base.length > 0 ? normaliseCostTimeline(base) : null;
    }

    if (resolved.has(variantId)) return resolved.get(variantId) ?? null;

    if (inProgress.has(variantId)) {
      return fail(
        variantId,
        "CYCLE",
        `Bundle ${variantId} contains itself through its components`,
      );
    }
    if (depth > MAX_BUNDLE_DEPTH) {
      return fail(
        variantId,
        "TOO_DEEP",
        `Bundle nesting exceeds ${MAX_BUNDLE_DEPTH} levels at ${variantId}`,
      );
    }

    inProgress.add(variantId);
    try {
      const parts: { timeline: readonly CostVersion[]; quantity: number }[] = [];

      for (const component of components) {
        const timeline = resolve(component.componentVariantId, depth + 1);
        if (!timeline || timeline.length === 0) {
          // Treating an unpriced component as free would understate the pack's
          // COGS, which is the one direction of error a profit tool must not
          // make quietly.
          return fail(
            variantId,
            adjacency.has(component.componentVariantId)
              ? "UNRESOLVED_COMPONENT"
              : "MISSING_COMPONENT_COST",
            `Component ${component.componentVariantId} has no resolvable cost`,
          );
        }
        parts.push({ timeline, quantity: component.quantity });
      }

      const derived = combineComponentTimelines(parts);
      if (derived.length === 0) {
        return fail(
          variantId,
          "MISSING_COMPONENT_COST",
          `No instant at which every component of ${variantId} has a known cost`,
        );
      }

      resolved.set(variantId, derived);
      timelines.set(variantId, derived);
      return derived;
    } finally {
      inProgress.delete(variantId);
    }
  };

  for (const bundleVariantId of adjacency.keys()) {
    resolve(bundleVariantId, 0);
  }

  return { timelines, problems };
}

/**
 * Sum component timelines into one derived timeline.
 *
 * The derived cost can only change where a component changes, so the union of
 * the components' instants is the complete set of candidate breakpoints — no
 * sampling and no interpolation.
 *
 * It starts where the last component's timeline starts. A pack whose second
 * component was only priced in April has no honest cost for March, and
 * inventing one from the components that happened to be known is worse than
 * saying so.
 */
function combineComponentTimelines(
  parts: readonly { timeline: readonly CostVersion[]; quantity: number }[],
): CostVersion[] {
  if (parts.length === 0) return [];

  const start = Math.max(
    ...parts.map((part) => part.timeline[0]!.effectiveAt.getTime()),
  );

  const instants = [
    ...new Set(
      parts.flatMap((part) =>
        part.timeline.map((version) => version.effectiveAt.getTime()),
      ),
    ),
  ]
    .filter((instant) => instant >= start)
    .sort((a, b) => a - b);

  // The first breakpoint is `start` itself: it is one of the union's members
  // by construction, and every component is priced there.
  const derived: CostVersion[] = [];

  for (const instant of instants) {
    const at = new Date(instant);
    let unitCostMicros: Micros = 0;

    for (const part of parts) {
      const version = costEffectiveAt(part.timeline, at);
      if (!version) return [];
      // Micros are integers and quantity is an integer, so the product and the
      // sum are both exact. Nothing here needs rounding, and rounding it would
      // introduce drift a 12-component kit would accumulate twelve times over.
      unitCostMicros += version.unitCostMicros * part.quantity;
    }

    const previous = derived[derived.length - 1];
    if (previous && previous.unitCostMicros === unitCostMicros) continue;

    derived.push({
      unitCostMicros,
      effectiveAt: at,
      source: "BUNDLE_ROLLUP",
    });
  }

  return derived;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface CatalogVariant {
  variantId: string;
  productId: string;
  sku: string | null;
  title: string;
}

export interface BundleCandidate {
  bundleVariantId: string;
  componentVariantId: string;
  quantity: number;
  source: "SKU_PATTERN" | "TITLE_PATTERN";
  /** The fragment that matched, so a merchant can see why this was proposed. */
  evidence: string;
}

/** Sane bounds for an inferred multiplier — beyond this it is a coincidence. */
const MIN_DETECTED_QUANTITY = 2;
const MAX_DETECTED_QUANTITY = 1_000;

/**
 * Multi-pack conventions, in the order they are tried.
 *
 * Anchored at the end of the SKU and required to sit behind a separator, so
 * "SHIRT-3PK" matches and "SHIRT3" does not. A bare trailing number is the one
 * pattern deliberately missing: it is far more often a size, a colourway or a
 * revision than a pack count, and a wrong bundle mapping triples a product's
 * COGS.
 */
const SKU_PACK_PATTERNS: { pattern: RegExp; group: number }[] = [
  { pattern: /[-_ ]PACK[-_ ]?OF[-_ ]?(\d+)$/i, group: 1 },
  { pattern: /[-_ ](\d+)[-_ ]?(?:PK|PACK|PCS|PC|CT|COUNT)$/i, group: 1 },
  { pattern: /[-_ ]X[-_ ]?(\d+)$/i, group: 1 },
  { pattern: /[-_ ](\d+)X$/i, group: 1 },
];

/** Title conventions, used only between variants of one product. */
const TITLE_PACK_PATTERNS: { pattern: RegExp; quantity?: number }[] = [
  { pattern: /\bpack\s+of\s+(\d+)\b/i },
  { pattern: /\b(\d+)\s*[-–]?\s*(?:pack|pk|count|ct)\b/i },
  { pattern: /\bbundle\s+of\s+(\d+)\b/i },
  { pattern: /\btwin[-\s]?pack\b/i, quantity: 2 },
  { pattern: /\btriple[-\s]?pack\b/i, quantity: 3 },
];

interface PackMatch {
  quantity: number;
  evidence: string;
  /** What remains once the pack marker is removed. */
  remainder: string;
}

function matchSkuPack(sku: string): PackMatch | null {
  for (const { pattern, group } of SKU_PACK_PATTERNS) {
    const found = pattern.exec(sku);
    if (!found) continue;

    const quantity = Number(found[group]);
    if (
      !Number.isInteger(quantity) ||
      quantity < MIN_DETECTED_QUANTITY ||
      quantity > MAX_DETECTED_QUANTITY
    ) {
      continue;
    }

    return {
      quantity,
      evidence: found[0]!,
      remainder: sku.slice(0, found.index),
    };
  }
  return null;
}

function matchTitlePack(title: string): { quantity: number; evidence: string } | null {
  for (const { pattern, quantity } of TITLE_PACK_PATTERNS) {
    const found = pattern.exec(title);
    if (!found) continue;

    const resolved = quantity ?? Number(found[1]);
    if (
      !Number.isInteger(resolved) ||
      resolved < MIN_DETECTED_QUANTITY ||
      resolved > MAX_DETECTED_QUANTITY
    ) {
      continue;
    }
    return { quantity: resolved, evidence: found[0]! };
  }
  return null;
}

function normaliseSku(sku: string): string {
  return sku.trim().toUpperCase();
}

/**
 * Propose bundle mappings from the catalog's own naming.
 *
 * Two independent signals, in priority order. A SKU convention
 * ("WIDGET-BLU-3PK" beside "WIDGET-BLU") is strong: the merchant built the
 * relationship into their own identifiers. A title convention is weaker and is
 * therefore only trusted *within one product*, where "3-Pack" and "Single" are
 * two variants of the same thing and the relationship is unambiguous.
 *
 * Everything returned is a proposal. Nothing here decides a cost — an inferred
 * mapping that silently tripled a product's COGS would be worse than no
 * detection at all.
 */
export function detectBundleCandidates(
  variants: readonly CatalogVariant[],
): BundleCandidate[] {
  // Null marks a SKU carried by more than one variant. An ambiguous SKU cannot
  // anchor a mapping, and picking whichever variant was read first would make
  // the proposal depend on row order.
  const bySku = new Map<string, CatalogVariant | null>();
  for (const variant of variants) {
    if (!variant.sku) continue;
    const key = normaliseSku(variant.sku);
    if (!key) continue;
    bySku.set(key, bySku.has(key) ? null : variant);
  }

  const byProduct = new Map<string, CatalogVariant[]>();
  for (const variant of variants) {
    const list = byProduct.get(variant.productId);
    if (list) list.push(variant);
    else byProduct.set(variant.productId, [variant]);
  }

  const candidates: BundleCandidate[] = [];
  const seen = new Set<string>();

  const propose = (candidate: BundleCandidate) => {
    if (candidate.bundleVariantId === candidate.componentVariantId) return;
    const key = `${candidate.bundleVariantId}|${candidate.componentVariantId}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const variant of variants) {
    if (!variant.sku) continue;

    const sku = normaliseSku(variant.sku);
    const pack = matchSkuPack(sku);
    if (!pack) continue;

    // "WIDGET-BLU-3PK" -> "WIDGET-BLU". Trailing separators are stripped so a
    // store writing "WIDGET-BLU--3PK" still resolves.
    const baseSku = pack.remainder.replace(/[-_ ]+$/, "");
    if (!baseSku) continue;

    const base = bySku.get(baseSku);
    if (!base) continue;

    propose({
      bundleVariantId: variant.variantId,
      componentVariantId: base.variantId,
      quantity: pack.quantity,
      source: "SKU_PATTERN",
      evidence: `SKU "${variant.sku}" matches "${baseSku}" ×${pack.quantity}`,
    });
  }

  const proposedBundles = new Set(
    candidates.map((candidate) => candidate.bundleVariantId),
  );

  for (const siblings of byProduct.values()) {
    if (siblings.length < 2) continue;

    const packs = siblings
      .map((variant) => ({ variant, pack: matchTitlePack(variant.title) }))
      .filter((entry) => entry.pack !== null);
    if (packs.length === 0) continue;

    // The base is the sibling with no pack marker. Exactly one keeps this
    // unambiguous; a product listing "3-Pack", "6-Pack", "Single" and "Refill"
    // gives no principled answer and is left for the merchant.
    const singles = siblings.filter((variant) => !matchTitlePack(variant.title));
    if (singles.length !== 1) continue;
    const base = singles[0]!;

    for (const { variant, pack } of packs) {
      if (proposedBundles.has(variant.variantId)) continue;
      propose({
        bundleVariantId: variant.variantId,
        componentVariantId: base.variantId,
        quantity: pack!.quantity,
        source: "TITLE_PATTERN",
        evidence: `Variant "${variant.title}" reads as ×${pack!.quantity} of "${base.title}"`,
      });
    }
  }

  return candidates;
}

/**
 * Every bundle that has to be re-derived when these variants' costs change.
 *
 * Walks the graph upward from a component to its packs, and to the packs
 * containing those packs. Used to keep a cost edit's blast radius exact instead
 * of re-rolling a whole catalog.
 */
export function bundlesAffectedBy(
  edges: readonly BundleEdge[],
  changedVariantIds: readonly string[],
): string[] {
  const parentsOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = parentsOf.get(edge.componentVariantId);
    if (list) list.push(edge.bundleVariantId);
    else parentsOf.set(edge.componentVariantId, [edge.bundleVariantId]);
  }

  const affected = new Set<string>();
  const queue = [...changedVariantIds];
  // `affected` doubles as the visited set, so a diamond — two packs both
  // containing the same single, both inside one kit — cannot loop, and neither
  // can a cyclic mapping that slipped past confirmation.
  while (queue.length > 0) {
    const variantId = queue.shift()!;
    for (const parent of parentsOf.get(variantId) ?? []) {
      if (affected.has(parent)) continue;
      affected.add(parent);
      queue.push(parent);
    }
  }

  return [...affected];
}
