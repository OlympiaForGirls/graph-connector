// naiveSolver.ts — brute-force reference solver for correctness auditing.
//
// INTENTIONALLY SIMPLE — this is the ground truth, not a fast solver.
//
// Strategy:
//   • Enumerate every perfect matching (bijection topFrontier → botFrontier × color).
//   • Only prune with Rule A (parentColor) during DFS — never prune fingerprints.
//   • At the base case: build the full graph and call findAllCycles, then apply
//     the exact same Rule B + Rule C checks as validateCompleteMatching (small branch).
//
// Result: a list of all valid solutions that a brute-force search would find.
// Comparing this against cpSolver's output reveals completeness bugs (naive finds
// something optimized misses) or safety bugs (optimized emits a false positive).
//
// Feasible for gen ≤ 2 (N=6 frontier pairs, ~525k leaf nodes before Rule A).

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';
import type { SolutionSnapshot, ConnectionSnapshot } from '../types/solution';
import { buildUnifiedAdjList, findAllCycles } from '../utils/cycleDetection';
import { dihedralCanonical, hasMirrorSymmetry } from '../validation/cycleAnalysis';

const COLORS: EdgeColor[] = ['red', 'green', 'blue'];

export interface NaiveSolverResult {
  solutions: SolutionSnapshot[];
  partialStatesExplored: number;
  completeMatchingsEvaluated: number;
}

export function runNaiveSolver(
  gen: number,
  topGraph: Graph,
  bottomGraph: Graph,
  maxSolutions = 200,
  shouldStop: () => boolean = () => false,
): NaiveSolverResult {
  const topFrontier = topGraph.nodes.filter(n => n.isFrontier);
  const botFrontier = bottomGraph.nodes.filter(n => n.isFrontier);
  const N = topFrontier.length;

  if (N !== botFrontier.length) {
    return { solutions: [], partialStatesExplored: 0, completeMatchingsEvaluated: 0 };
  }

  // Parent-edge colour for each frontier node (forbidden on cross-edges — Rule A).
  const parentColor = new Map<string, EdgeColor>();
  const frontierIds = new Set([...topFrontier, ...botFrontier].map(n => n.id));
  for (const e of topGraph.edges)    if (frontierIds.has(e.targetId)) parentColor.set(e.targetId, e.color);
  for (const e of bottomGraph.edges) if (frontierIds.has(e.targetId)) parentColor.set(e.targetId, e.color);

  const solutions: SolutionSnapshot[] = [];
  let partialStatesExplored      = 0;
  let completeMatchingsEvaluated = 0;

  const usedBotIds  = new Set<string>();
  const currentEdges: CrossEdge[] = [];

  // Exact base-case validator — mirrors validateCompleteMatching's small-graph branch.
  function validateFull(): boolean {
    const adj    = buildUnifiedAdjList(topGraph, bottomGraph, currentEdges);
    const cycles = findAllCycles(adj);
    const seen   = new Set<string>();
    for (const c of cycles) {
      const fp = dihedralCanonical(c.colors);
      if (seen.has(fp)) return false;
      seen.add(fp);
    }
    for (const c of cycles) {
      if (c.nodes.length % 2 === 0 && hasMirrorSymmetry(c.colors)) return false;
    }
    return true;
  }

  function dfs(depth: number): void {
    if (solutions.length >= maxSolutions || shouldStop()) return;

    if (depth === N) {
      completeMatchingsEvaluated++;
      if (validateFull()) {
        const connections: ConnectionSnapshot[] = currentEdges.map(e => ({
          from: e.topNodeId, to: e.bottomNodeId, color: e.color,
        }));
        solutions.push({
          id: `naive-${Date.now()}-${solutions.length}`,
          generation: gen,
          connections,
          timestamp: Date.now(),
        });
      }
      return;
    }

    const topId     = topFrontier[depth].id;
    const forbidTop = parentColor.get(topId);

    for (let bi = 0; bi < N; bi++) {
      if (solutions.length >= maxSolutions || shouldStop()) return;
      const botId = botFrontier[bi].id;
      if (usedBotIds.has(botId)) continue;

      const forbidBot = parentColor.get(botId);

      for (let ci = 0; ci < COLORS.length; ci++) {
        if (solutions.length >= maxSolutions || shouldStop()) return;
        const color = COLORS[ci];
        if (color === forbidTop || color === forbidBot) continue;  // Rule A only

        partialStatesExplored++;
        currentEdges.push({ id: `n-${depth}-${bi}-${ci}`, topNodeId: topId, bottomNodeId: botId, color });
        usedBotIds.add(botId);

        dfs(depth + 1);

        usedBotIds.delete(botId);
        currentEdges.pop();
      }
    }
  }

  dfs(0);

  return { solutions, partialStatesExplored, completeMatchingsEvaluated };
}
