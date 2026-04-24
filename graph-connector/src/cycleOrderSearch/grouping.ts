// grouping.ts — pure logic for grouping NCResult objects by canonical pair set
// and analysing drawing-order patterns.
//
// CANONICAL PAIR SET KEY:
//   Each edge is represented as "topId->botId".
//   The n strings are sorted lexicographically and joined with "|".
//   This key is color- and order-independent, so all drawing orders for the
//   same structural edge set share one key and belong to one group card.
//
// WITHIN A GROUP — ORDER PATTERNS:
//   An order pattern is the structural draw sequence, i.e. which edge (by
//   canonical label e1..en) is drawn at each step, ignoring edge colors.
//   Multiple colorings that follow the same structural sequence are collapsed
//   under one pattern entry so the user can see how many color assignments
//   produce a given draw order.

import type { EdgeColor } from '../types/graph';
import type { NCEdge, NCResult } from './types';

// ── Canonical coloring ────────────────────────────────────────────────────────

/**
 * A canonical coloring: one specific color assignment to the n edges (e1..en),
 * with ALL valid drawing orders that work for those n colored edges.
 *
 * "Canonical" means color-indexed by the stable edge label order (e1, e2, ...),
 * not by the arbitrary draw order. Multiple (structurally different) drawing
 * orders may share the same canonical coloring.
 */
export interface CanonicalColoring {
  /** "blue,green,red,blue" in canonical e1..en order. */
  key: string;
  /** Human-readable label: "Coloring A", "Coloring B", … */
  label: string;
  /** colors[i] = color for canonical edge e_{i+1}. */
  colors: EdgeColor[];
  /**
   * All valid drawing orders for this coloring.
   * Each NCEdge[] is one valid draw sequence; all use the same canonical colors.
   */
  drawingOrders: NCEdge[][];
  /** Distinct structural draw sequences (label sequences), e.g. "e1 → e3 → e2". */
  drawPatterns: string[];
  /** Total count of valid drawing orders (= drawingOrders.length). */
  totalOrderCount: number;
  /** Any one valid drawing order — used for "Load into Graph." */
  sampleOrder: NCEdge[];
}

// ── Public types ───────────────────────────────────────────────────────────────

/** One valid color assignment for a particular order pattern. */
export interface OrderColoring {
  /** colors[i] = color of the i-th edge IN THE DRAW ORDER (not canonical order). */
  colors: EdgeColor[];
  /** The full original NCEdge array; needed for "Load into Graph." */
  fullOrder: NCEdge[];
}

/** All color assignments that share the same structural draw sequence. */
export interface OrderPattern {
  /** Key: canonical edge indices in draw order, e.g. "0,2,1,3". */
  key: string;
  /** edgeSequence[i] = canonical edge index (0-based) drawn at step i. */
  edgeSequence: number[];
  colorings: OrderColoring[];
}

/** A group of NCResult objects sharing the same unordered canonical edge set. */
export interface GroupedResult {
  /** Canonical key ("topId->botId|..." sorted, joined). */
  key: string;
  /**
   * The n pairs in CANONICAL ORDER (sorted by "topId->botId" string).
   * Edge label eK corresponds to pairs[K-1].
   */
  pairs: Array<{ topNodeId: string; bottomNodeId: string }>;
  /** Short labels aligned with `pairs`: ["e1","e2",...]. */
  edgeLabels: string[];
  /** Full cycle node sequence (from the first result that contributed). */
  cycleNodeIds: string[];
  /** Draw-order patterns, grouped by structural sequence. */
  patterns: OrderPattern[];
  /** Total (order × coloring) combinations across all patterns. */
  totalCombinations: number;
}

export interface TrendSummary {
  distinctPatternCount: number;
  /** Canonical edge indices (0-based) that appear most often as the first drawn edge. */
  mostCommonFirstEdges: number[];
  /** Canonical edge indices (0-based) that appear most often as the last drawn edge. */
  mostCommonLastEdges: number[];
}

// ── Key computation ────────────────────────────────────────────────────────────

export function canonicalKey(
  pairs: Array<{ topNodeId: string; bottomNodeId: string }>,
): string {
  return pairs
    .map(p => `${p.topNodeId}->${p.bottomNodeId}`)
    .sort()
    .join('|');
}

// ── Build a group from one NCResult ───────────────────────────────────────────

export function buildGroup(result: NCResult): GroupedResult {
  // Sort pairs lexicographically to get a stable canonical order for labels.
  const sorted = result.pairs
    .map((p, origIdx) => ({ p, origIdx, str: `${p.topNodeId}->${p.bottomNodeId}` }))
    .sort((a, b) => (a.str < b.str ? -1 : a.str > b.str ? 1 : 0));

  const pairs      = sorted.map(s => s.p);
  const edgeLabels = sorted.map((_, i) => `e${i + 1}`);

  // Map from original pair index → canonical (sorted) index.
  const toCanonical = new Map<number, number>(
    sorted.map(({ origIdx }, canonIdx) => [origIdx, canonIdx]),
  );

  // Map from "topId|botId" → original pair index (for fast lookup).
  const pairKey = (top: string, bot: string) => `${top}|${bot}`;
  const origIdxOf = new Map<string, number>(
    result.pairs.map((p, i) => [pairKey(p.topNodeId, p.bottomNodeId), i]),
  );

  // Group validOrders by structural sequence.
  const patternMap = new Map<string, OrderPattern>();

  for (const order of result.validOrders) {
    // Convert each NCEdge to its canonical edge index.
    const canonSeq = order.map(e => {
      const origIdx = origIdxOf.get(pairKey(e.topNodeId, e.bottomNodeId)) ?? -1;
      return toCanonical.get(origIdx) ?? origIdx;
    });
    const seqKey = canonSeq.join(',');

    const coloring: OrderColoring = {
      colors:    order.map(e => e.color),
      fullOrder: order,
    };

    if (!patternMap.has(seqKey)) {
      patternMap.set(seqKey, { key: seqKey, edgeSequence: canonSeq, colorings: [] });
    }
    patternMap.get(seqKey)!.colorings.push(coloring);
  }

  return {
    key:               canonicalKey(result.pairs),
    pairs,
    edgeLabels,
    cycleNodeIds:      result.cycleNodeIds,
    patterns:          Array.from(patternMap.values()),
    totalCombinations: result.validOrders.length,
  };
}

// ── Merge an incoming NCResult into an existing group ─────────────────────────
// Used when two NCResult objects (rare in current search, future-proof) share
// the same canonical key.

export function mergeIntoGroup(existing: GroupedResult, incoming: NCResult): GroupedResult {
  const extra = buildGroup(incoming);
  const patternMap = new Map<string, OrderPattern>(
    existing.patterns.map(p => [p.key, { ...p, colorings: [...p.colorings] }]),
  );
  for (const ep of extra.patterns) {
    if (patternMap.has(ep.key)) {
      patternMap.get(ep.key)!.colorings.push(...ep.colorings);
    } else {
      patternMap.set(ep.key, ep);
    }
  }
  return {
    ...existing,
    patterns:          Array.from(patternMap.values()),
    totalCombinations: existing.totalCombinations + incoming.validOrders.length,
  };
}

// ── Group by canonical coloring ───────────────────────────────────────────────

const COLORING_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Re-groups a GroupedResult by COLORING (what colors e1..en are assigned)
 * rather than by draw sequence.
 *
 * Hierarchy produced:
 *   CanonicalColoring A  (e1=blue, e2=green, …)
 *     drawingOrders:  [e1→e3→e2→e4, e2→e1→e4→e3, …]
 *   CanonicalColoring B  (e1=green, e2=blue, …)
 *     drawingOrders:  [e1→e2→e3→e4]
 *   …
 */
export function groupByColoring(group: GroupedResult): CanonicalColoring[] {
  const n = group.pairs.length;

  // Build a fast lookup from "topId|botId" → canonical edge index.
  const pairToCanon = new Map<string, number>(
    group.pairs.map((p, i) => [`${p.topNodeId}|${p.bottomNodeId}`, i]),
  );

  // Map canonical coloring key → accumulated data.
  interface AccumulatedColoring {
    colors: EdgeColor[];
    orders: NCEdge[][];
    patternKeys: Set<string>;
  }
  const acc = new Map<string, AccumulatedColoring>();

  for (const pattern of group.patterns) {
    for (const coloring of pattern.colorings) {
      // Rebuild canonical-order colors from draw-order colors.
      const canonColors = new Array<EdgeColor>(n);
      pattern.edgeSequence.forEach((canonIdx, drawStep) => {
        canonColors[canonIdx] = coloring.colors[drawStep];
      });
      const key = canonColors.join(',');

      if (!acc.has(key)) {
        acc.set(key, { colors: canonColors, orders: [], patternKeys: new Set() });
      }
      const entry = acc.get(key)!;
      entry.orders.push(coloring.fullOrder);
      entry.patternKeys.add(pattern.key);
    }
  }

  // Convert to CanonicalColoring[].
  return Array.from(acc.entries()).map(([key, { colors, orders, patternKeys }], i) => {
    // Compute distinct draw-pattern label strings from the orders.
    const seenPatterns = new Set<string>();
    const drawPatterns: string[] = [];
    for (const order of orders) {
      const seqLabels = order.map(e => {
        const ci = pairToCanon.get(`${e.topNodeId}|${e.bottomNodeId}`) ?? -1;
        return group.edgeLabels[ci] ?? `e?`;
      });
      const patStr = seqLabels.join(' → ');
      if (!seenPatterns.has(patStr)) {
        seenPatterns.add(patStr);
        drawPatterns.push(patStr);
      }
    }

    void patternKeys; // retained in data for future use

    return {
      key,
      label: `Coloring ${i < COLORING_LABELS.length ? COLORING_LABELS[i] : i + 1}`,
      colors,
      drawingOrders: orders,
      drawPatterns,
      totalOrderCount: orders.length,
      sampleOrder: orders[0],
    } satisfies CanonicalColoring;
  });
}

// ── Trend analysis ────────────────────────────────────────────────────────────

export function computeTrends(group: GroupedResult): TrendSummary {
  const n = group.pairs.length;
  const firstCount = new Array<number>(n).fill(0);
  const lastCount  = new Array<number>(n).fill(0);

  for (const p of group.patterns) {
    if (p.edgeSequence.length > 0) {
      firstCount[p.edgeSequence[0]]++;
      lastCount[p.edgeSequence[p.edgeSequence.length - 1]]++;
    }
  }

  const maxFirst = Math.max(...firstCount);
  const maxLast  = Math.max(...lastCount);

  return {
    distinctPatternCount: group.patterns.length,
    mostCommonFirstEdges: firstCount
      .map((c, i) => [i, c] as [number, number])
      .filter(([, c]) => c === maxFirst && c > 0)
      .map(([i]) => i),
    mostCommonLastEdges: lastCount
      .map((c, i) => [i, c] as [number, number])
      .filter(([, c]) => c === maxLast && c > 0)
      .map(([i]) => i),
  };
}
