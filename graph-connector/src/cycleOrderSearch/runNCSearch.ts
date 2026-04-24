// runNCSearch.ts — top-level N-Cycle Search logic.
//
// For each n-pair matching of top×bottom frontier nodes:
//   1. Structure check (detectSingleCycle): does this matching form a single simple cycle?
//   2. Drawing-order search (backtracking + validateMove): find every (permutation + color)
//      sequence that draws the n edges one-by-one legally.
//
// Runs synchronously — call from a Web Worker to avoid blocking the UI.

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';
import type { NCResult, NCProgress, NCDrawingOrder, NCEdge } from './types';
import { combinations, indexPermutations } from './combinatorics';
import { detectSingleCycle } from './detectSingleCycle';
import { validateCycleAndBuildHighlight } from './validateCycle';
import { validateMove } from '../validation/validateMove';

const ALL_COLORS: EdgeColor[] = ['blue', 'green', 'red'];

// ── Drawing-order search ──────────────────────────────────────────────────────

/**
 * Backtracking search over all permutations of `pairs` AND all color assignments,
 * pruned at each step by `validateMove`. Collects up to `maxOrders` valid orders.
 */
function findValidDrawingOrders(
  topGraph: Graph,
  bottomGraph: Graph,
  pairs: Array<{ topNodeId: string; bottomNodeId: string }>,
  maxOrders: number,
): NCDrawingOrder[] {
  const results: NCDrawingOrder[] = [];
  const drawnEdges: NCEdge[] = [];
  const remaining = [...pairs];

  function backtrack() {
    if (results.length >= maxOrders) return;

    if (remaining.length === 0) {
      results.push([...drawnEdges]);
      return;
    }

    const crossEdgesSoFar: CrossEdge[] = drawnEdges.map((e, i) => ({
      id: `nc-${i}`,
      topNodeId:    e.topNodeId,
      bottomNodeId: e.bottomNodeId,
      color:        e.color,
    }));

    for (let i = 0; i < remaining.length; i++) {
      const pair = remaining[i];
      remaining.splice(i, 1);

      for (const color of ALL_COLORS) {
        const result = validateMove(topGraph, bottomGraph, crossEdgesSoFar, {
          topNodeId:    pair.topNodeId,
          bottomNodeId: pair.bottomNodeId,
          color,
        });

        if (result.allowed) {
          drawnEdges.push({ topNodeId: pair.topNodeId, bottomNodeId: pair.bottomNodeId, color });
          backtrack();
          drawnEdges.pop();
        }
      }

      remaining.splice(i, 0, pair);
    }
  }

  backtrack();
  return results;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function runNCSearch(
  n: number,
  topGraph: Graph,
  bottomGraph: Graph,
  onResult:   (r: NCResult) => void,
  onProgress: (p: NCProgress) => void,
  shouldStop: () => boolean,
  maxOrdersPerResult = 50,
  timeLimitMs        = 30_000,
): NCProgress {
  const topFrontier = topGraph.nodes.filter(nd => nd.isFrontier);
  const botFrontier = bottomGraph.nodes.filter(nd => nd.isFrontier);

  let matchingsChecked   = 0;
  let candidateCyclesFound = 0;
  let validOrdersFound   = 0;
  const startTime = Date.now();
  let resultId = 0;

  function progress(stopped: boolean, done: boolean, timedOut?: boolean): NCProgress {
    return { matchingsChecked, candidateCyclesFound, validOrdersFound, stopped, done, timedOut };
  }

  function emit() {
    onProgress(progress(false, false));
  }

  // Enumerate all n-subsets of top frontier × n-subsets of bottom frontier × bijections.
  for (const topSubset of combinations(topFrontier, n)) {
    for (const botSubset of combinations(botFrontier, n)) {
      // All bijections: permutations of the n bottom-subset indices.
      for (const botPerm of indexPermutations(n)) {
        if (shouldStop()) return progress(true, false);
        if (Date.now() - startTime > timeLimitMs) return progress(false, false, true);

        const pairs = topSubset.map((t, i) => ({
          topNodeId:    t.id,
          bottomNodeId: botSubset[botPerm[i]].id,
        }));

        matchingsChecked++;

        // Structure check.
        const cycleCheck = detectSingleCycle(topGraph, bottomGraph, pairs);
        if (!cycleCheck) {
          if (matchingsChecked % 500 === 0) emit();
          continue;
        }

        // Audit: verify the returned cycle satisfies all correctness rules.
        const audit = validateCycleAndBuildHighlight(
          cycleCheck.cycleNodeIds, pairs, topGraph, bottomGraph,
        );
        if (!audit.valid) {
          console.warn('[NCSearch] detectSingleCycle produced an invalid cycle:', audit.error, pairs);
          continue;
        }

        candidateCyclesFound++;

        // Drawing-order search.
        const validOrders = findValidDrawingOrders(
          topGraph, bottomGraph, pairs, maxOrdersPerResult,
        );

        if (validOrders.length > 0) {
          validOrdersFound += validOrders.length;
          const result: NCResult = {
            id:              `nc-${++resultId}`,
            pairs,
            cycleNodeIds:    cycleCheck.cycleNodeIds,
            validOrders,
            validOrderCount: validOrders.length,
          };
          onResult(result);
        }

        if (matchingsChecked % 100 === 0) emit();
      }
    }
  }

  emit();
  return progress(false, true);
}
