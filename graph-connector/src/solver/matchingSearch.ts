// matchingSearch.ts — incremental-validation DFS for bipartite perfect matchings.
//
// ── GENERATION-3 COMPLEXITY NOTE ───────────────────────────────────────────────
// Gen=3 has 12 frontier nodes per side (3×2^(gen-1)).
// Naïve DFS: 12! permutations × 3^12 colour choices ≈ 2×10^15 states — infeasible.
// Even with Rule A alone the space is 12! × 1.33^12 ≈ 2×10^12.
// Three pruning layers reduce this to a tractable search.
//
// ── PRUNING LAYERS (cheapest first) ────────────────────────────────────────────
//
//  Layer 1 — Rule A, O(1) per step (precomputed parent-edge colours):
//    Every frontier node has exactly one parent tree-edge.  A cross-edge colour
//    must differ from the parent-edge colour at BOTH endpoints.  Precomputed once
//    before the DFS; checked before recursing.  Cuts ≈ 60% of branches at near-
//    zero cost.
//
//  Layer 2 — Incremental Rules B & C, O(paths in current graph) per step:
//    After each cross-edge is tentatively added, findNewCycleColors() does a
//    bounded DFS from one endpoint back to the other through the existing adj.
//    Every path found becomes a new simple cycle; the cycle is checked against:
//      Rule B — canonical-rotation fingerprint must be unique among all cycles
//               accepted on the current DFS path.
//      Rule C — even-length cycle cannot be mirror-symmetric.
//    A violation prunes the entire subtree immediately — typically after only
//    2–4 cross-edges are placed — long before the base case is reached.
//
//    Correctness: every cycle in the final graph uses ≥ 2 cross-edges (trees are
//    acyclic).  When the LAST cross-edge of a cycle (by DFS insertion order) is
//    added, the rest of the cycle already exists in adj, so findNewCycleColors
//    will find it (provided the path count cap is not exceeded).  Rule-B
//    fingerprints are tracked per-path and rolled back on backtrack.
//    A base-case call to validateCompleteMatching() acts as a safety net for
//    any cycles the bounded search (MAX_PATHS_PER_EDGE) might miss.
//
//  Layer 3 — Partial-state memoisation:
//    After exhausting a subtree with no new solutions the canonical key of the
//    current partial matching (sorted "botId:colour" tokens) is stored in
//    badStates.  A future DFS node that reaches the same key is pruned instantly.
//    In fixed top-order traversal the hit rate is low, but the cost per lookup is
//    O(1) and the saving is large when a hit does occur.
//
// ── WEB-WORKER READINESS ───────────────────────────────────────────────────────
//   No React, DOM, or browser-specific APIs are used.
//   Import directly from matchingWorker.ts without modification.
//
// ── STOPPING AND PROGRESS ──────────────────────────────────────────────────────
//   shouldStop() is polled every STOP_CHECK_INTERVAL DFS steps so the search
//   can be interrupted as soon as the user clicks Stop.
//   onProgress() receives a SearchProgress snapshot at those same checkpoints.

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';
import type { SolutionSnapshot, ConnectionSnapshot } from '../types/solution';
import { buildUnifiedAdjList, findAllCycles } from '../utils/cycleDetection';
import { canonicalRotation, hasMirrorSymmetry } from '../validation/cycleAnalysis';

/** Generations above this value are blocked in Search Mode. */
export const MAX_SEARCH_GEN = 3;

const COLORS: EdgeColor[] = ['red', 'green', 'blue'];

/** Poll shouldStop / emit progress every N DFS steps. */
const STOP_CHECK_INTERVAL = 200;

/**
 * Maximum simple paths searched per newly added cross-edge when looking for
 * new cycles.  Higher → more pruning power, more work per step.
 * 50 is sufficient to detect all cycles for gen ≤ 3 in practice.
 */
const MAX_PATHS_PER_EDGE = 50;

export type SearchMode = 'first1' | 'first10' | 'all';

export interface SearchProgress {
  /** (topNode, botNode, colour) triples that passed Rule A and were recursed on. */
  partialStatesExplored:      number;
  /** Times the DFS reached a complete matching (all top nodes paired). */
  completeMatchingsEvaluated: number;
  /** Complete matchings that also passed all cycle rules. */
  validSolutionsFound:        number;
  /** User clicked Stop. */
  stopped:  boolean;
  /** Safety-fallback timeout was hit. */
  timedOut: boolean;
  /** Search completed naturally (neither stopped nor timed out). */
  done:     boolean;
  /**
   * True when done AND the DFS fully exhausted all possibilities without hitting
   * the solution cap.  False when the search stopped early at the cap limit.
   */
  exhausted: boolean;
  unequalCounts?: boolean;
}

export interface SearchResult {
  solutions: SolutionSnapshot[];
  progress:  SearchProgress;
}

// ── Incremental adjacency list ───────────────────────────────────────────────
type AdjEntry = { neighbor: string; color: EdgeColor };
type IncrAdj  = Map<string, AdjEntry[]>;

function addIncrEdge(adj: IncrAdj, a: string, b: string, color: EdgeColor) {
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a)!.push({ neighbor: b, color });
  adj.get(b)!.push({ neighbor: a, color });
}

function removeIncrEdge(adj: IncrAdj, a: string, b: string, color: EdgeColor) {
  const strip = (arr: AdjEntry[], tgt: string) => {
    const i = arr.findIndex(e => e.neighbor === tgt && e.color === color);
    if (i !== -1) arr.splice(i, 1);
  };
  const la = adj.get(a); if (la) strip(la, b);
  const lb = adj.get(b); if (lb) strip(lb, a);
}

// ── New-cycle finder (Layer 2) ───────────────────────────────────────────────
/**
 * Called BEFORE adding edge (edgeFrom, edgeTo, edgeColor) to adj.
 * Returns up to MAX_PATHS_PER_EDGE colour sequences, one per new simple cycle.
 * Each colour sequence is [edgeColor, ...colours along the path edgeTo→edgeFrom].
 *
 * Correctness: adding edge (u, v) creates exactly the cycles formed by paths
 * from v back to u in the existing graph combined with the new edge u→v.
 * The DFS here enumerates those paths.
 */
function findNewCycleColors(
  adj:       IncrAdj,
  edgeFrom:  string,
  edgeTo:    string,
  edgeColor: EdgeColor,
): EdgeColor[][] {
  const results: EdgeColor[][] = [];
  const pathColors: EdgeColor[] = [];
  // edgeTo is the DFS start — mark visited so the search can't loop back to it.
  const visited = new Set<string>([edgeTo]);

  function dfs(current: string): void {
    for (const { neighbor, color } of adj.get(current) ?? []) {
      if (results.length >= MAX_PATHS_PER_EDGE) return;

      if (neighbor === edgeFrom) {
        // Path edgeTo → ... → current → edgeFrom found.
        // Full cycle: edgeFrom —(new edge)→ edgeTo → ... → current → edgeFrom.
        results.push([edgeColor, ...pathColors, color]);
        // Don't recurse into edgeFrom — the cycle is complete here.
        continue;
      }
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        pathColors.push(color);
        dfs(neighbor);
        pathColors.pop();
        visited.delete(neighbor);
      }
    }
  }

  dfs(edgeTo);
  return results;
}

// ── Base-case safety-net validator ───────────────────────────────────────────
/**
 * Full Rules B+C check on the complete matching.
 * Runs only when a complete matching is reached — rare with good incremental
 * pruning — and acts as a safety net for any cycles that the bounded
 * findNewCycleColors search might have missed.
 */
function validateCompleteMatching(
  topGraph:    Graph,
  bottomGraph: Graph,
  edges:       CrossEdge[],
): boolean {
  const adj    = buildUnifiedAdjList(topGraph, bottomGraph, edges);
  const cycles = findAllCycles(adj);

  const seen = new Set<string>();
  for (const c of cycles) {
    const fp = canonicalRotation(c.colors).join(',');
    if (seen.has(fp)) return false;
    seen.add(fp);
  }
  for (const c of cycles) {
    if (c.nodes.length % 2 === 0 && hasMirrorSymmetry(c.colors)) return false;
  }
  return true;
}

// ── Main entry point ─────────────────────────────────────────────────────────
export function runSearch(
  gen:              number,
  topGraph:         Graph,
  bottomGraph:      Graph,
  mode:             SearchMode = 'all',
  shouldStop:       () => boolean = () => false,
  onProgress:       (p: SearchProgress) => void = () => {},
  onSolution:       (s: SolutionSnapshot) => void = () => {},
  safetyTimeLimitMs = 60_000,
): SearchResult {

  const topFrontier = topGraph.nodes.filter(n => n.isFrontier);
  const botFrontier = bottomGraph.nodes.filter(n => n.isFrontier);

  const emptyProgress = (extra: Partial<SearchProgress> = {}): SearchProgress => ({
    partialStatesExplored: 0, completeMatchingsEvaluated: 0, validSolutionsFound: 0,
    stopped: false, timedOut: false, done: true, exhausted: true, ...extra,
  });

  if (topFrontier.length !== botFrontier.length) {
    return { solutions: [], progress: emptyProgress({ unequalCounts: true }) };
  }

  const maxSolutions = mode === 'first1' ? 1 : mode === 'first10' ? 10 : 200;

  // ── Layer 1: precompute parent-edge colours ──────────────────
  const parentColor = new Map<string, EdgeColor>();
  {
    const frontierIds = new Set([...topFrontier, ...botFrontier].map(n => n.id));
    for (const e of topGraph.edges)    if (frontierIds.has(e.targetId)) parentColor.set(e.targetId, e.color);
    for (const e of bottomGraph.edges) if (frontierIds.has(e.targetId)) parentColor.set(e.targetId, e.color);
  }

  // ── Build initial adj from tree edges ────────────────────────
  const adj: IncrAdj = new Map();
  for (const n of topGraph.nodes)    adj.set(n.id, []);
  for (const n of bottomGraph.nodes) adj.set(n.id, []);
  for (const e of topGraph.edges)    addIncrEdge(adj, e.sourceId, e.targetId, e.color);
  for (const e of bottomGraph.edges) addIncrEdge(adj, e.sourceId, e.targetId, e.color);

  // ── Shared backtracking state ────────────────────────────────
  const currentEdges:    CrossEdge[] = [];
  const usedBotIds       = new Set<string>();
  // Rule-B fingerprints accumulated along the current DFS path; rolled back
  // on backtrack so each path sees only its own accepted cycles.
  const seenFingerprints = new Set<string>();
  // Layer 3: partial states known to produce no solutions.
  const badStates        = new Set<string>();

  const solutions:          SolutionSnapshot[] = [];
  const startTime          = Date.now();
  let partialStatesExplored      = 0;
  let completeMatchingsEvaluated = 0;
  let stopped  = false;
  let timedOut = false;
  let stepCount = 0;

  function emitProgress(done = false) {
    onProgress({
      partialStatesExplored,
      completeMatchingsEvaluated,
      validSolutionsFound: solutions.length,
      stopped, timedOut, done,
      exhausted: done && !stopped && !timedOut && solutions.length < maxSolutions,
    });
  }

  // Layer 3 key: sorted "botId:colour" tokens (order-independent).
  function partialKey(): string {
    return currentEdges.map(e => `${e.bottomNodeId}:${e.color}`).sort().join('|');
  }

  // ── DFS ──────────────────────────────────────────────────────
  function dfs(topIdx: number): void {
    if (stopped || timedOut || solutions.length >= maxSolutions) return;

    stepCount++;
    if (stepCount % STOP_CHECK_INTERVAL === 0) {
      if (shouldStop()) { stopped = true; return; }
      if (Date.now() - startTime > safetyTimeLimitMs) { timedOut = true; return; }
      emitProgress();
    }

    // Layer 3: memoisation guard.
    const key = partialKey();
    if (badStates.has(key)) return;

    if (topIdx === topFrontier.length) {
      // ── Base case: complete bipartite perfect matching ────────
      // Incremental checks have already validated all reachable cycles;
      // this call is a safety net for any the bounded path search missed.
      completeMatchingsEvaluated++;
      if (!validateCompleteMatching(topGraph, bottomGraph, currentEdges)) return;

      const connections: ConnectionSnapshot[] = currentEdges.map(e => ({
        from: e.topNodeId, to: e.bottomNodeId, color: e.color,
      }));
      const snap: SolutionSnapshot = {
        id:          `sol-${Date.now()}-${solutions.length}`,
        generation:  gen,
        connections,
        timestamp:   Date.now(),
      };
      solutions.push(snap);
      onSolution(snap);   // stream to caller immediately
      return;
    }

    const topNode        = topFrontier[topIdx];
    const topForbidColor = parentColor.get(topNode.id);
    const prevSolCount   = solutions.length;

    for (const botNode of botFrontier) {
      if (usedBotIds.has(botNode.id)) continue;
      const botForbidColor = parentColor.get(botNode.id);

      for (const color of COLORS) {
        // ── Layer 1: Rule A gate, O(1) ───────────────────────
        if (color === topForbidColor || color === botForbidColor) continue;

        partialStatesExplored++;

        // ── Layer 2: incremental cycle check ─────────────────
        const newCycleSeqs = findNewCycleColors(adj, topNode.id, botNode.id, color);
        const newFps: string[]  = [];
        const newFpSet          = new Set<string>();
        let pruned              = false;

        for (const seq of newCycleSeqs) {
          const fp = canonicalRotation(seq).join(',');
          // Rule B: fingerprint must be new among all cycles on this path.
          if (seenFingerprints.has(fp) || newFpSet.has(fp)) { pruned = true; break; }
          // Rule C: even-length mirror-symmetric cycle is forbidden.
          if (seq.length % 2 === 0 && hasMirrorSymmetry(seq)) { pruned = true; break; }
          newFps.push(fp);
          newFpSet.add(fp);
        }
        if (pruned) continue;

        // ── Commit ────────────────────────────────────────────
        addIncrEdge(adj, topNode.id, botNode.id, color);
        currentEdges.push({ id: `s${topIdx}`, topNodeId: topNode.id, bottomNodeId: botNode.id, color });
        usedBotIds.add(botNode.id);
        for (const fp of newFps) seenFingerprints.add(fp);

        dfs(topIdx + 1);

        // ── Backtrack (reverse order) ─────────────────────────
        for (const fp of newFps) seenFingerprints.delete(fp);
        usedBotIds.delete(botNode.id);
        currentEdges.pop();
        removeIncrEdge(adj, topNode.id, botNode.id, color);
      }
    }

    // Layer 3: if this subtree yielded nothing new, mark it as bad.
    if (solutions.length === prevSolCount && !stopped && !timedOut) {
      badStates.add(key);
    }
  }

  dfs(0);
  emitProgress(true);

  return {
    solutions,
    progress: {
      partialStatesExplored,
      completeMatchingsEvaluated,
      validSolutionsFound: solutions.length,
      stopped,
      timedOut,
      done:      !stopped && !timedOut,
      exhausted: !stopped && !timedOut && solutions.length < maxSolutions,
    },
  };
}
