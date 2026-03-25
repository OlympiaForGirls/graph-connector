// validateGraph.ts — fast incremental graph validation (no full cycle enumeration).
//
// Uses the same incremental replay the CP solver uses: add cross-edges one at a
// time and for each new edge find only the cycles that pass through it (DFS from
// one endpoint back to the other).  This is polynomial in the path cap rather
// than exponential like findAllCycles.
//
// Path cap: 10,000 per edge — same constant as VALIDATE_MAX_PATHS in cpSolver.ts.

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';
import { canonicalRotation, dihedralCanonical, hasMirrorSymmetry } from './cycleAnalysis';

const MAX_PATHS = 10_000;

// ── Minimal incremental adjacency list ───────────────────────────────────────
type AdjEntry = { neighbor: string; color: EdgeColor };
type Adj = Map<string, AdjEntry[]>;

function adjAddEdge(adj: Adj, a: string, b: string, color: EdgeColor) {
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a)!.push({ neighbor: b, color });
  adj.get(b)!.push({ neighbor: a, color });
}

// Find all simple paths from edgeTo back to edgeFrom (up to maxPaths),
// prepend edgeColor to form the full cycle color sequence.
function newCycleColors(
  adj: Adj, edgeFrom: string, edgeTo: string,
  edgeColor: EdgeColor, maxPaths: number,
): EdgeColor[][] {
  const results: EdgeColor[][] = [];
  const pathColors: EdgeColor[] = [];
  const visited = new Set<string>([edgeTo]);
  function dfs(cur: string) {
    for (const { neighbor, color } of adj.get(cur) ?? []) {
      if (results.length >= maxPaths) return;
      if (neighbor === edgeFrom) { results.push([edgeColor, ...pathColors, color]); continue; }
      if (!visited.has(neighbor)) {
        visited.add(neighbor); pathColors.push(color);
        dfs(neighbor);
        pathColors.pop(); visited.delete(neighbor);
      }
    }
  }
  dfs(edgeTo);
  return results;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface GraphValidationResult {
  valid: boolean;
  /** Index into crossEdges[] of the first edge that caused a violation, or null. */
  violatingEdgeIndex: number | null;
  violationReason: 'rotation' | 'mirror' | null;
  /** The exact color sequence of the cycle that triggered the violation. */
  violatingCycleSeq?: EdgeColor[];
  /** Canonical rotation of violatingCycleSeq (forward-only, for display). */
  violatingCanonical?: EdgeColor[];
  /** Reversed color sequence of violatingCycleSeq. */
  violatingReversed?: EdgeColor[];
  /** Canonical rotation of the reversed sequence. */
  violatingRevCanonical?: EdgeColor[];
  /**
   * For Rule B (rotation): the dihedral fingerprint shared by two cycles,
   * and the color sequence of the earlier cycle that first registered it.
   */
  duplicateFingerprint?: string;
  earlierCycleSeq?: EdgeColor[];
  /** Number of cross-edges that were checked before stopping. */
  checkedEdges: number;
  totalEdges: number;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function validateGraph(
  topGraph:   Graph,
  bottomGraph: Graph,
  crossEdges: CrossEdge[],
): GraphValidationResult {
  // Build adjacency from tree edges only.
  const adj: Adj = new Map();
  for (const n of topGraph.nodes)    adj.set(n.id, []);
  for (const n of bottomGraph.nodes) adj.set(n.id, []);
  for (const e of topGraph.edges)    adjAddEdge(adj, e.sourceId, e.targetId, e.color);
  for (const e of bottomGraph.edges) adjAddEdge(adj, e.sourceId, e.targetId, e.color);

  // fingerprint → first color sequence that registered it (for rotation dup reporting)
  const seenFps = new Map<string, EdgeColor[]>();

  for (let i = 0; i < crossEdges.length; i++) {
    const edge = crossEdges[i];
    const seqs = newCycleColors(adj, edge.topNodeId, edge.bottomNodeId, edge.color, MAX_PATHS);

    for (const seq of seqs) {
      const fp  = dihedralCanonical(seq);
      const rev = [...seq].reverse();

      if (seenFps.has(fp)) {
        return {
          valid: false,
          violatingEdgeIndex: i,
          violationReason: 'rotation',
          violatingCycleSeq:    seq,
          violatingCanonical:   canonicalRotation(seq),
          violatingReversed:    rev,
          violatingRevCanonical: canonicalRotation(rev),
          duplicateFingerprint: fp,
          earlierCycleSeq:      seenFps.get(fp),
          checkedEdges: i + 1,
          totalEdges: crossEdges.length,
        };
      }

      if (seq.length % 2 === 0 && hasMirrorSymmetry(seq)) {
        return {
          valid: false,
          violatingEdgeIndex: i,
          violationReason: 'mirror',
          violatingCycleSeq:    seq,
          violatingCanonical:   canonicalRotation(seq),
          violatingReversed:    rev,
          violatingRevCanonical: canonicalRotation(rev),
          checkedEdges: i + 1,
          totalEdges: crossEdges.length,
        };
      }

      seenFps.set(fp, seq);
    }

    // Add the edge to the graph only after checking it (newCycleColors needs the
    // edge absent so the DFS finds paths through the rest of the graph).
    adjAddEdge(adj, edge.topNodeId, edge.bottomNodeId, edge.color);
  }

  return {
    valid: true,
    violatingEdgeIndex: null,
    violationReason: null,
    checkedEdges: crossEdges.length,
    totalEdges: crossEdges.length,
  };
}
