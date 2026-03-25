// completeWorker.ts — Web Worker for completing a partial matching.
//
// ── FAST PATH (N ≤ FAST_COMPLETE_THRESHOLD remaining pairs) ──────────────────
// When only a few frontier pairs are left (typically 1–4), the generic CP solver
// is massively over-engineered:
//   • It pre-commits all fixed edges with VALIDATE_MAX_PATHS=10,000 each.
//   • It calls validateCompleteMatching (which replays ALL edges × 10,000 cap) at
//     every base case.
//   • If mode='first1', it does this 5 times (restarts), inflating all counters.
//
// The fast path:
//   1. Builds adj from tree edges + fixed edges in one pass (cap 200, same as the
//      cpSolver DFS-time cap; fixed edges are already validated by partial search).
//   2. Directly enumerates the tiny remaining space (at most N! × 3^N leaf nodes).
//   3. Checks each new edge incrementally (cap 200) — no replay at the base case.
//   4. Each unique (assignment) attempt is counted exactly once.
//
// ── FULL PATH (N > FAST_COMPLETE_THRESHOLD remaining pairs) ──────────────────
// Delegates to runSearch / cpSolver as before.
//
// Message protocol (main → worker):
//   { type: 'START', payload: { gen, topGraph, bottomGraph, pattern, mode } }
//
// Message protocol (worker → main):
//   { type: 'ACK',        gen }
//   { type: 'DEBUG_INFO', info: DebugInfo }
//   { type: 'SOLUTION',   solution: SolutionSnapshot }
//   { type: 'PROGRESS',   progress: SearchProgress }
//   { type: 'DONE',       result: SearchResult }
//   { type: 'ERROR',      message: string }

import { runSearch }   from './matchingSearch';
import { buildBaseAdj } from './cpSolver';
import type { SearchMode, SearchProgress, SearchResult } from './matchingSearch';
import type { SolutionSnapshot, ConnectionSnapshot } from '../types/solution';
import type { PartialPattern } from '../types/partial';
import type { CrossEdge, Graph, EdgeColor } from '../types/graph';
import { dihedralCanonical, hasMirrorSymmetry } from '../validation/cycleAnalysis';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = self as any;

const COLORS: EdgeColor[]         = ['red', 'green', 'blue'];
const FAST_COMPLETE_THRESHOLD     = 4;      // use fast path when ≤ N remaining pairs
// Two-tier path caps for the fast path:
//   SETUP_CAP    — pre-commit fixed edges (they are already validated; low cap is fine for
//                  fingerprint collection and keeps setup fast).
//   CHECK_CAP    — check each COMPLETION edge (these are the new, unvalidated ones; must
//                  match the safety-net cap so violations like long mirror-symmetric cycles
//                  are caught — cap 200 is insufficient for a gen-4 graph with 23 fixed edges
//                  because the violating 24-edge cycle has >200 path representations in the DFS).
const SETUP_CAP                   = 200;    // fixed-edge pre-commit
const CHECK_CAP                   = 10_000; // completion-edge cycle checks

// ── Local adjacency helpers (structurally identical to cpSolver.ts) ──────────
type AdjEntry = { neighbor: string; color: EdgeColor };
type Adj = Map<string, AdjEntry[]>;

function adjAddEdge(adj: Adj, a: string, b: string, color: EdgeColor) {
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a)!.push({ neighbor: b, color });
  adj.get(b)!.push({ neighbor: a, color });
}

function adjRemoveEdge(adj: Adj, a: string, b: string, color: EdgeColor) {
  const strip = (arr: AdjEntry[], tgt: string, c: EdgeColor) => {
    const i = arr.findIndex(e => e.neighbor === tgt && e.color === c);
    if (i !== -1) arr.splice(i, 1);
  };
  const la = adj.get(a); if (la) strip(la, b, color);
  const lb = adj.get(b); if (lb) strip(lb, a, color);
}

function findNewCycleColors(
  adj: Adj, edgeFrom: string, edgeTo: string,
  edgeColor: EdgeColor, maxPaths: number,
): EdgeColor[][] {
  const results: EdgeColor[][] = [];
  const pathColors: EdgeColor[] = [];
  const visited = new Set<string>([edgeTo]);
  function dfs(cur: string): void {
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

function computeParentColors(
  topGraph: Graph, bottomGraph: Graph,
  topFrontier: Graph['nodes'], botFrontier: Graph['nodes'],
): Map<string, EdgeColor> {
  const parentColor = new Map<string, EdgeColor>();
  const frontierIds = new Set([...topFrontier, ...botFrontier].map(n => n.id));
  for (const e of topGraph.edges)    if (frontierIds.has(e.targetId)) parentColor.set(e.targetId, e.color);
  for (const e of bottomGraph.edges) if (frontierIds.has(e.targetId)) parentColor.set(e.targetId, e.color);
  return parentColor;
}

// ── Fast completion path ──────────────────────────────────────────────────────

export interface DebugInfo {
  remainingTopCount:    number;
  remainingBotCount:    number;
  pairsCount:           number;
  legalColorsForFirst:  number;  // -1 when N=0
}

function runFastCompletion(
  gen:             number,
  topGraph:        Graph,
  bottomGraph:     Graph,
  remainingTop:    Graph['nodes'],
  remainingBot:    Graph['nodes'],
  fixedCrossEdges: CrossEdge[],
  maxSolutions:    number,
  onSolution:      (s: SolutionSnapshot) => void,
  onProgress:      (p: SearchProgress) => void,
): SearchResult {
  const N = remainingTop.length;

  // Build adj from all tree edges (full graphs, not filtered).
  const adj = buildBaseAdj(topGraph, bottomGraph) as Adj;
  const seenFps = new Set<string>();

  // Pre-commit fixed edges incrementally (low cap — fixed edges are already validated).
  for (const e of fixedCrossEdges) {
    const seqs = findNewCycleColors(adj, e.topNodeId, e.bottomNodeId, e.color, SETUP_CAP);
    for (const seq of seqs) seenFps.add(dihedralCanonical(seq));
    adjAddEdge(adj, e.topNodeId, e.bottomNodeId, e.color);
  }

  const parentColor = computeParentColors(topGraph, bottomGraph, remainingTop, remainingBot);

  const solutions:    SolutionSnapshot[] = [];
  const currentEdges: CrossEdge[]        = [];
  const usedBotIds    = new Set<string>();
  let partialStatesExplored      = 0;
  let completeMatchingsEvaluated = 0;

  function dfs(depth: number): void {
    if (solutions.length >= maxSolutions) return;

    if (depth === N) {
      // All remaining pairs have been assigned and passed incremental cycle checks.
      completeMatchingsEvaluated++;
      const connections: ConnectionSnapshot[] = currentEdges.map(e => ({
        from: e.topNodeId, to: e.bottomNodeId, color: e.color,
      }));
      const snap: SolutionSnapshot = {
        id: `comp-${Date.now()}-${solutions.length}`,
        generation: gen,
        connections,
        timestamp: Date.now(),
      };
      solutions.push(snap);
      onSolution(snap);
      return;
    }

    const topId     = remainingTop[depth].id;
    const forbidTop = parentColor.get(topId);

    for (let bi = 0; bi < N; bi++) {
      if (solutions.length >= maxSolutions) return;
      const botId = remainingBot[bi].id;
      if (usedBotIds.has(botId)) continue;

      const forbidBot = parentColor.get(botId);

      for (let ci = 0; ci < COLORS.length; ci++) {
        if (solutions.length >= maxSolutions) return;
        const color = COLORS[ci];

        // Rule A: forbidden parent-edge color.
        if (color === forbidTop || color === forbidBot) continue;

        // Incremental cycle check (Rules B + C) — high cap to catch long violating cycles.
        const seqs = findNewCycleColors(adj, topId, botId, color, CHECK_CAP);
        let violated = false;
        const newFps: string[] = [];
        for (const seq of seqs) {
          const fp = dihedralCanonical(seq);
          if (seenFps.has(fp)) { violated = true; break; }
          if (seq.length % 2 === 0 && hasMirrorSymmetry(seq)) { violated = true; break; }
          newFps.push(fp);
        }
        if (violated) continue;

        // Commit.
        partialStatesExplored++;
        for (const fp of newFps) seenFps.add(fp);
        adjAddEdge(adj, topId, botId, color);
        usedBotIds.add(botId);
        currentEdges.push({ id: `c-${depth}-${bi}-${ci}`, topNodeId: topId, bottomNodeId: botId, color });

        dfs(depth + 1);

        // Undo.
        currentEdges.pop();
        usedBotIds.delete(botId);
        adjRemoveEdge(adj, topId, botId, color);
        for (const fp of newFps) seenFps.delete(fp);
      }
    }
  }

  dfs(0);

  const progress: SearchProgress = {
    partialStatesExplored,
    completeMatchingsEvaluated,
    validSolutionsFound: solutions.length,
    stopped:   false,
    timedOut:  false,
    done:      true,
    exhausted: solutions.length < maxSolutions,
  };
  onProgress(progress);

  return { solutions, progress };
}

// Returns the number of legally colorable options for a specific (top, bot) pair,
// given the current adj and seenFps state.
function countLegalColorsForPair(
  adj: Adj, seenFps: Set<string>,
  topId: string, botId: string,
  parentColor: Map<string, EdgeColor>,
): number {
  const forbidTop = parentColor.get(topId);
  const forbidBot = parentColor.get(botId);
  let count = 0;
  for (const color of COLORS) {
    if (color === forbidTop || color === forbidBot) continue;
    const seqs = findNewCycleColors(adj, topId, botId, color, CHECK_CAP);
    let ok = true;
    for (const seq of seqs) {
      const fp = dihedralCanonical(seq);
      if (seenFps.has(fp) || (seq.length % 2 === 0 && hasMirrorSymmetry(seq))) { ok = false; break; }
    }
    if (ok) count++;
  }
  return count;
}

// ── Worker message handler ───────────────────────────────────────────────────
ctx.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data as {
    type: string;
    payload: {
      gen: number;
      topGraph: Graph;
      bottomGraph: Graph;
      pattern: PartialPattern;
      mode: SearchMode;
    };
  };

  if (type !== 'START') return;

  const { gen, topGraph, bottomGraph, pattern, mode } = payload;
  ctx.postMessage({ type: 'ACK', gen });

  try {
    const usedTopSet = new Set(pattern.usedTopNodes);
    const usedBotSet = new Set(pattern.usedBotNodes);

    // Compute exact remaining frontier nodes from the original graphs.
    const remainingTopFrontier = topGraph.nodes.filter(n => n.isFrontier && !usedTopSet.has(n.id));
    const remainingBotFrontier = bottomGraph.nodes.filter(n => n.isFrontier && !usedBotSet.has(n.id));
    const N = remainingTopFrontier.length;

    const fixedCrossEdges: CrossEdge[] = pattern.connections.map((c, i) => ({
      id:           `fixed-${i}`,
      topNodeId:    c.from,
      bottomNodeId: c.to,
      color:        c.color,
    }));

    // ── Compute debug info ──────────────────────────────────────────────────
    // Build a temporary adj for this purpose; do not mutate the one used in search.
    let legalColorsForFirst = -1;
    if (N >= 1) {
      const tmpAdj = buildBaseAdj(topGraph, bottomGraph) as Adj;
      const tmpFps = new Set<string>();
      for (const fe of fixedCrossEdges) {
        const seqs = findNewCycleColors(tmpAdj, fe.topNodeId, fe.bottomNodeId, fe.color, SETUP_CAP);
        for (const seq of seqs) tmpFps.add(dihedralCanonical(seq));
        adjAddEdge(tmpAdj, fe.topNodeId, fe.bottomNodeId, fe.color);
      }
      const parentColor = computeParentColors(topGraph, bottomGraph, remainingTopFrontier, remainingBotFrontier);
      // For N=1 there is exactly one (top, bot) pair — report that.
      // For N>1 report the count for the first top vs first bot (indicative).
      legalColorsForFirst = countLegalColorsForPair(
        tmpAdj, tmpFps,
        remainingTopFrontier[0].id,
        remainingBotFrontier[0].id,
        parentColor,
      );
    }

    const debugInfo: DebugInfo = {
      remainingTopCount:   N,
      remainingBotCount:   remainingBotFrontier.length,
      pairsCount:          N,
      legalColorsForFirst,
    };
    ctx.postMessage({ type: 'DEBUG_INFO', info: debugInfo });

    // ── Choose search path ──────────────────────────────────────────────────
    const maxSolutions = mode === 'first1' ? 1 : mode === 'first10' ? 10 : 200;

    let completionSolutions: SolutionSnapshot[];
    let finalProgress: SearchProgress;

    if (N <= FAST_COMPLETE_THRESHOLD) {
      // ── Fast path: direct enumeration, no CP solver overhead ──────────────
      const result = runFastCompletion(
        gen, topGraph, bottomGraph,
        remainingTopFrontier, remainingBotFrontier,
        fixedCrossEdges,
        maxSolutions,
        (sol: SolutionSnapshot) => {
          // Stitch fixed + completion edges for the live SOLUTION message.
          const full: SolutionSnapshot = {
            ...sol,
            connections: [...pattern.connections, ...sol.connections],
          };
          ctx.postMessage({ type: 'SOLUTION', solution: full });
        },
        (progress: SearchProgress) => ctx.postMessage({ type: 'PROGRESS', progress }),
      );
      completionSolutions = result.solutions;
      finalProgress       = result.progress;
    } else {
      // ── Full CP solver path: mark matched nodes as non-frontier ───────────
      const filteredTopGraph: Graph = {
        ...topGraph,
        nodes: topGraph.nodes.map(n =>
          usedTopSet.has(n.id) ? { ...n, isFrontier: false } : n,
        ),
      };
      const filteredBotGraph: Graph = {
        ...bottomGraph,
        nodes: bottomGraph.nodes.map(n =>
          usedBotSet.has(n.id) ? { ...n, isFrontier: false } : n,
        ),
      };

      const result: SearchResult = runSearch(
        gen,
        filteredTopGraph,
        filteredBotGraph,
        mode,
        () => false,
        (progress: SearchProgress) => ctx.postMessage({ type: 'PROGRESS', progress }),
        (sol: SolutionSnapshot) => {
          const full: SolutionSnapshot = {
            ...sol,
            connections: [...pattern.connections, ...sol.connections],
          };
          ctx.postMessage({ type: 'SOLUTION', solution: full });
        },
        60_000,
        fixedCrossEdges,
      );
      completionSolutions = result.solutions;
      finalProgress       = result.progress;
    }

    // Stitch fixed edges into the DONE result (completionSolutions has only the new edges).
    const stitchedResult: SearchResult = {
      solutions: completionSolutions.map(sol => ({
        ...sol,
        connections: [...pattern.connections, ...sol.connections],
      })),
      progress: finalProgress,
    };

    ctx.postMessage({ type: 'DONE', result: stitchedResult });
  } catch (err) {
    ctx.postMessage({ type: 'ERROR', message: String(err) });
  }
};
