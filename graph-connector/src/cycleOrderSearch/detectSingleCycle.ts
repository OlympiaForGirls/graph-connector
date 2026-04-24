// detectSingleCycle.ts
//
// Given n pairs of (topNodeId, bottomNodeId) from the two tree graphs, determines
// whether there exists a cyclic ordering of those pairs that yields a single simple
// cycle using all n cross-edges alternating with tree paths.
//
// Cycle structure for cyclic order σ = (σ0, σ1, ..., σ_{n-1}), n even:
//
//   t_{σ0} →[cross]→ b_{σ0} →[bot path]→ b_{σ1} →[cross]→ t_{σ1} →[top path]→
//   t_{σ2} →[cross]→ b_{σ2} →[bot path]→ b_{σ3} →[cross]→ t_{σ3} →[top path]→
//   ... → t_{σ0}  (closed)
//
// For the cycle to be simple (no repeated nodes):
//   - The n/2 top-tree paths must be vertex-disjoint (sharing no internal nodes).
//   - The n/2 bottom-tree paths must be vertex-disjoint.
//
// Returns the full cycle node sequence (including tree-internal nodes) for the first
// valid cyclic ordering found, or null if no valid ordering exists.

import type { Graph } from '../types/graph';
import { getTreePath, checkPathsVertexDisjoint } from './treeUtils';
import { indexPermutations } from './combinatorics';

export interface SingleCycleResult {
  cycleNodeIds: string[];
}

export function detectSingleCycle(
  topGraph: Graph,
  bottomGraph: Graph,
  pairs: Array<{ topNodeId: string; bottomNodeId: string }>,
): SingleCycleResult | null {
  const n = pairs.length;
  if (n < 2 || n % 2 !== 0) return null;

  // Fix pair 0 at position 0 to eliminate rotation equivalence.
  // Enumerate all (n-1)! orderings of the remaining pair indices.
  const restLen = n - 1;
  const restPerms = indexPermutations(restLen); // permutations of [0..n-2]

  for (const restPerm of restPerms) {
    // Full cyclic ordering: [0, restPerm[0]+1, restPerm[1]+1, ...]
    const order: number[] = [0, ...restPerm.map(i => i + 1)];

    // Build n/2 bottom-tree paths: each connects b_{order[2k]} to b_{order[2k+1]}.
    const botPaths: string[][] = [];
    let botOk = true;
    for (let k = 0; k < n / 2; k++) {
      const b0 = pairs[order[2 * k]].bottomNodeId;
      const b1 = pairs[order[2 * k + 1]].bottomNodeId;
      const path = getTreePath(bottomGraph, b0, b1);
      if (!path) { botOk = false; break; }
      botPaths.push(path);
    }
    if (!botOk) continue;

    // Build n/2 top-tree paths: each connects t_{order[2k+1]} to t_{order[(2k+2)%n]}.
    const topPaths: string[][] = [];
    let topOk = true;
    for (let k = 0; k < n / 2; k++) {
      const t0 = pairs[order[2 * k + 1]].topNodeId;
      const t1 = pairs[order[(2 * k + 2) % n]].topNodeId;
      const path = getTreePath(topGraph, t0, t1);
      if (!path) { topOk = false; break; }
      topPaths.push(path);
    }
    if (!topOk) continue;

    if (!checkPathsVertexDisjoint(botPaths)) continue;
    if (!checkPathsVertexDisjoint(topPaths)) continue;

    // Valid ordering found — build cycle node sequence.
    return { cycleNodeIds: buildCycleNodeIds(pairs, order, topPaths, botPaths) };
  }

  return null;
}

function buildCycleNodeIds(
  pairs: Array<{ topNodeId: string; bottomNodeId: string }>,
  order: number[],
  topPaths: string[][],  // topPaths[k]: t_{order[2k+1]} → t_{order[(2k+2)%n]}
  botPaths: string[][],  // botPaths[k]: b_{order[2k]} → b_{order[2k+1]}
): string[] {
  const n = pairs.length;
  const nodes: string[] = [];

  // Start at t_{order[0]}.
  nodes.push(pairs[order[0]].topNodeId);

  for (let k = 0; k < n / 2; k++) {
    const evenPos = 2 * k;
    const oddPos  = 2 * k + 1;

    // Cross-edge from t_{order[evenPos]} to b_{order[evenPos]} (top→bottom).
    // Then bottom-tree path from b_{order[evenPos]} to b_{order[oddPos]}.
    const botPath = botPaths[k];
    // botPath[0] = b_{order[evenPos]} (cross-edge destination)
    // botPath[-1] = b_{order[oddPos]} (next cross-edge source)
    nodes.push(...botPath);  // includes both b_{order[evenPos]} and b_{order[oddPos]}

    // Cross-edge from b_{order[oddPos]} to t_{order[oddPos]} (bottom→top).
    nodes.push(pairs[order[oddPos]].topNodeId);

    // Top-tree path from t_{order[oddPos]} to t_{order[(oddPos+1)%n]}.
    const topPath = topPaths[k];
    // topPath[0] = t_{order[oddPos]} (just added above — skip it)
    // topPath[-1] = t_{order[(oddPos+1)%n]}
    const nextEvenPos = (2 * k + 2) % n;
    if (nextEvenPos === 0) {
      // Last segment: destination is the start node — include internals only.
      nodes.push(...topPath.slice(1, -1));
    } else {
      nodes.push(...topPath.slice(1)); // includes t_{order[nextEvenPos]}
    }
  }

  return nodes;
}
