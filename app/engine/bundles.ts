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
