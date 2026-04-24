// validateCycle.ts — validates that a cycleNodeIds sequence is a proper simple
// cycle through exactly n connection edges, and extracts highlight data for rendering.
//
// Rules checked:
//   1. No repeated vertex (|nodeSet| === cycleNodeIds.length)
//   2. No repeated edge (each consecutive pair appears at most once)
//   3. Every consecutive pair is a known edge (cross-edge OR tree edge)
//   4. Exactly n cross-edges appear in the cycle
//   5. Every pair in `pairs` maps to a cross-edge found in the cycle

import type { Graph, EdgeColor } from '../types/graph';
import type { NCEdge } from './types';

// ── Public types ──────────────────────────────────────────────────────────────

/** Highlight data consumed by GraphView for cycle preview rendering. */
export interface CycleHighlight {
  /** Every node that is part of the cycle. Passed to both GraphViews; each
   *  renders only the subset that belongs to its own graph. */
  nodeIds: ReadonlySet<string>;
  /** Canonical edge keys "A|B" (lexicographic) for TREE edges in the cycle.
   *  Cross-edges are excluded — they are rendered by CrossEdgeLayer already. */
  treeEdgeKeys: ReadonlySet<string>;
}

export type CycleValidationResult =
  | { valid: true;  highlight: CycleHighlight }
  | { valid: false; error: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function ek(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Validates `cycleNodeIds` and, if valid, builds the CycleHighlight needed
 * to render the cycle in the graph canvas.
 *
 * @param cycleNodeIds  Ordered node sequence (does NOT repeat start at end).
 * @param pairs         The n (top, bottom) connection pairs.
 * @param topGraph      Top tree graph.
 * @param bottomGraph   Bottom tree graph.
 */
export function validateCycleAndBuildHighlight(
  cycleNodeIds: string[],
  pairs: Array<{ topNodeId: string; bottomNodeId: string }>,
  topGraph:    Graph,
  bottomGraph: Graph,
): CycleValidationResult {
  const n   = pairs.length;
  const len = cycleNodeIds.length;

  if (len < 4) {
    return { valid: false, error: `Cycle too short (${len} nodes; minimum 4).` };
  }

  // ── Rule 1: no repeated vertex ────────────────────────────────────────────
  const nodeSet = new Set(cycleNodeIds);
  if (nodeSet.size !== len) {
    return { valid: false, error: 'Cycle repeats a vertex before closing the loop.' };
  }

  // ── Build fast-lookup sets ────────────────────────────────────────────────
  const crossEdgeKeys = new Set<string>(pairs.map(p => ek(p.topNodeId, p.bottomNodeId)));
  const topEdgeKeys   = new Set<string>(topGraph.edges.map(e => ek(e.sourceId, e.targetId)));
  const botEdgeKeys   = new Set<string>(bottomGraph.edges.map(e => ek(e.sourceId, e.targetId)));

  // ── Walk every consecutive pair (including wrap-around) ───────────────────
  let crossCount     = 0;
  const seenEdges    = new Set<string>();
  const treeEdgeKeys = new Set<string>();

  for (let i = 0; i < len; i++) {
    const u = cycleNodeIds[i];
    const v = cycleNodeIds[(i + 1) % len];
    const key = ek(u, v);

    // ── Rule 2: no repeated edge ──────────────────────────────────────────
    if (seenEdges.has(key)) {
      return { valid: false, error: `Edge ${u} — ${v} appears more than once in the cycle.` };
    }
    seenEdges.add(key);

    // ── Rule 3: edge must exist in some graph ─────────────────────────────
    if (crossEdgeKeys.has(key)) {
      crossCount++;
    } else if (topEdgeKeys.has(key) || botEdgeKeys.has(key)) {
      treeEdgeKeys.add(key);
    } else {
      return {
        valid: false,
        error: `Step ${i}: ${u} — ${v} is not a cross-edge or a tree edge in this graph.`,
      };
    }
  }

  // ── Rule 4: exactly n cross-edges ────────────────────────────────────────
  if (crossCount !== n) {
    return {
      valid: false,
      error: `Expected ${n} cross-edges in the cycle, found ${crossCount}.`,
    };
  }

  // ── Rule 5: every pair appears exactly once ───────────────────────────────
  for (const p of pairs) {
    if (!seenEdges.has(ek(p.topNodeId, p.bottomNodeId))) {
      return {
        valid: false,
        error: `Connection ${p.topNodeId} ↔ ${p.bottomNodeId} is missing from the cycle.`,
      };
    }
  }

  return { valid: true, highlight: { nodeIds: nodeSet, treeEdgeKeys } };
}

// ── Cycle color sequence ──────────────────────────────────────────────────────

/**
 * Builds the full edge-color sequence around the cycle, suitable for display.
 * Returns one entry per consecutive pair in `cycleNodeIds` (plus wrap-around).
 */
export function buildCycleColorSeq(
  cycleNodeIds: string[],
  pairs: Array<{ topNodeId: string; bottomNodeId: string }>,
  crossEdges: NCEdge[],          // the loaded coloring (drawing order is irrelevant here)
  topGraph:    Graph,
  bottomGraph: Graph,
): Array<{ key: string; color: EdgeColor; isCross: boolean }> {
  const len = cycleNodeIds.length;

  // Cross-edge color lookup by canonical key.
  const crossColorMap = new Map<string, EdgeColor>(
    crossEdges.map(e => [ek(e.topNodeId, e.bottomNodeId), e.color]),
  );

  // Tree edge color lookup.
  const treeColorMap = new Map<string, EdgeColor>();
  for (const e of topGraph.edges)    treeColorMap.set(ek(e.sourceId, e.targetId), e.color);
  for (const e of bottomGraph.edges) treeColorMap.set(ek(e.sourceId, e.targetId), e.color);

  const crossKeys = new Set<string>(pairs.map(p => ek(p.topNodeId, p.bottomNodeId)));

  const seq: Array<{ key: string; color: EdgeColor; isCross: boolean }> = [];
  for (let i = 0; i < len; i++) {
    const u   = cycleNodeIds[i];
    const v   = cycleNodeIds[(i + 1) % len];
    const key = ek(u, v);
    const isCross = crossKeys.has(key);
    const color: EdgeColor = isCross
      ? (crossColorMap.get(key) ?? 'blue')
      : (treeColorMap.get(key) ?? 'blue');
    seq.push({ key, color, isCross });
  }
  return seq;
}
