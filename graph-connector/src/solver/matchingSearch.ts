// matchingSearch.ts — public entry point for the bipartite matching search.
//
// This file is the ONLY module imported by matchingWorker.ts and SearchMode.tsx.
// It owns the public types (SearchMode, SearchProgress, SearchResult) and the
// runSearch() function.  The actual search engine lives in cpSolver.ts, behind
// the CpSolverParams / CpSolverResult interface.
//
// ── DISPATCH STRATEGY ──────────────────────────────────────────────────────────
// • first1  — random-restart search.  Tries up to FIRST1_RESTARTS different
//             random orderings of the bottom frontier, each with 1/FIRST1_RESTARTS
//             of the total time budget.  Random restarts are highly effective when
//             solutions exist but the default ordering leads to a long dry run
//             before the first solution is encountered.
//
// • first10 / all — single-pass CP solver.  The constraint propagation is the
//             bottleneck for exhaustive enumeration; changing search order between
//             restarts would re-explore the same solution space.
//
// ── REPLACING THE ENGINE ───────────────────────────────────────────────────────
// To swap in a SAT/WASM/server-side solver, implement runCPSolver's interface
// (CpSolverParams → CpSolverResult) in a new file and update the two dispatch
// calls in runSinglePass / runWithRestarts below.

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';
import type { SolutionSnapshot } from '../types/solution';
import {
  runCPSolver, buildBaseAdj,
  type CpProgress, type CpSolverResult,
} from './cpSolver';

/** Generations above this threshold trigger a search-time warning in the UI. */
export const MAX_SEARCH_GEN = 3;

/** Number of restart attempts for first1 mode (each gets timeBudget/N ms). */
const FIRST1_RESTARTS = 5;

export type SearchMode = 'first1' | 'first10' | 'all';

export interface SearchProgress {
  /** (topNode, botNode, colour) triples tentatively explored. */
  partialStatesExplored:      number;
  /** Times a complete matching was reached and validated. */
  completeMatchingsEvaluated: number;
  /** Complete matchings that passed all cycle rules. */
  validSolutionsFound:        number;
  stopped:   boolean;
  timedOut:  boolean;
  done:      boolean;
  exhausted: boolean;
  unequalCounts?: boolean;
}

export interface SearchResult {
  solutions: SolutionSnapshot[];
  progress:  SearchProgress;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seeded Fisher-Yates shuffle (deterministic per seed, O(N)). */
function shuffled<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed | 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;   // LCG
    const j = ((s >>> 0) % (i + 1)) | 0;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function toSearchProgress(
  r: CpSolverResult,
  done: boolean,
): SearchProgress {
  return {
    partialStatesExplored:      r.partialStatesExplored,
    completeMatchingsEvaluated: r.completeMatchingsEvaluated,
    validSolutionsFound:        r.solutions.length,
    stopped:   r.stopped,
    timedOut:  r.timedOut,
    done,
    exhausted: r.exhausted,
  };
}

/** Accumulate progress counts across multiple solver runs (for restart reporting). */
function accumulateProgress(
  prev: SearchProgress,
  r: CpSolverResult,
  done: boolean,
): SearchProgress {
  return {
    partialStatesExplored:
      prev.partialStatesExplored + r.partialStatesExplored,
    completeMatchingsEvaluated:
      prev.completeMatchingsEvaluated + r.completeMatchingsEvaluated,
    validSolutionsFound: prev.validSolutionsFound + r.solutions.length,
    stopped:   r.stopped,
    timedOut:  r.timedOut,
    done,
    exhausted: r.exhausted,
  };
}

/** Compute parent-edge colour for each frontier node (forbidden on cross-edges). */
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

// ── Single-pass solver (first10 / all) ───────────────────────────────────────
function runSinglePass(
  gen:              number,
  topGraph:         Graph,
  bottomGraph:      Graph,
  topFrontier:      Graph['nodes'],
  botFrontier:      Graph['nodes'],
  parentColor:      Map<string, EdgeColor>,
  maxSolutions:     number,
  shouldStop:       () => boolean,
  onProgress:       (p: SearchProgress) => void,
  onSolution:       (s: SolutionSnapshot) => void,
  safetyTimeLimitMs: number,
  fixedCrossEdges?: CrossEdge[],
): SearchResult {
  const startTime = Date.now();
  const adj       = buildBaseAdj(topGraph, bottomGraph);

  const r = runCPSolver({
    gen, topGraph, bottomGraph, topFrontier, botFrontier,
    parentColor, adj, maxSolutions,
    shouldStop,
    onProgress: (p: CpProgress) => {
      onProgress({ ...p, done: false, exhausted: false });
    },
    onSolution,
    startTime, timeLimitMs: safetyTimeLimitMs,
    fixedCrossEdges,
  });

  const done = !r.stopped && !r.timedOut;
  const final = toSearchProgress(r, done);
  onProgress(final);
  return { solutions: r.solutions, progress: final };
}

// ── Random-restart solver (first1) ────────────────────────────────────────────
//
// Tries FIRST1_RESTARTS different random bot orderings in sequence.
// Each restart gets timeBudget / FIRST1_RESTARTS ms.
// Stops as soon as any restart finds a solution or the user cancels.
//
// Why restarts help for first1:
//   With N=24, the search tree's "good" branches (those leading quickly to a
//   solution) may be at unfavourable positions under the default bot ordering.
//   A different ordering changes which branches are explored first, giving a
//   probabilistic guarantee of finding a solution quickly if one exists at
//   shallow depth.  Seed 0 is always the original ordering so we don't skip it.
function runWithRestarts(
  gen:              number,
  topGraph:         Graph,
  bottomGraph:      Graph,
  topFrontier:      Graph['nodes'],
  botFrontier:      Graph['nodes'],
  parentColor:      Map<string, EdgeColor>,
  shouldStop:       () => boolean,
  onProgress:       (p: SearchProgress) => void,
  onSolution:       (s: SolutionSnapshot) => void,
  safetyTimeLimitMs: number,
  fixedCrossEdges?: CrossEdge[],
): SearchResult {
  const perRestartMs = Math.floor(safetyTimeLimitMs / FIRST1_RESTARTS);

  let accumulated: SearchProgress = {
    partialStatesExplored: 0, completeMatchingsEvaluated: 0, validSolutionsFound: 0,
    stopped: false, timedOut: false, done: false, exhausted: false,
  };

  for (let restart = 0; restart < FIRST1_RESTARTS; restart++) {
    if (shouldStop()) break;

    // Seed 0 → original order; seeds 1..N-1 → different random permutations.
    const orderedBots = restart === 0 ? botFrontier : shuffled(botFrontier, restart * 0x9e3779b9);
    const adj         = buildBaseAdj(topGraph, bottomGraph);
    const startTime   = Date.now();

    const r = runCPSolver({
      gen, topGraph, bottomGraph,
      topFrontier, botFrontier: orderedBots,
      parentColor, adj,
      maxSolutions: 1,
      shouldStop,
      onProgress: (p: CpProgress) => {
        const sp: SearchProgress = {
          partialStatesExplored:
            accumulated.partialStatesExplored + p.partialStatesExplored,
          completeMatchingsEvaluated:
            accumulated.completeMatchingsEvaluated + p.completeMatchingsEvaluated,
          validSolutionsFound:
            accumulated.validSolutionsFound + p.validSolutionsFound,
          stopped: p.stopped, timedOut: p.timedOut,
          done: false, exhausted: false,
        };
        onProgress(sp);
      },
      onSolution,
      startTime, timeLimitMs: perRestartMs,
      fixedCrossEdges,
    });

    accumulated = accumulateProgress(accumulated, r, false);

    if (r.solutions.length > 0 || r.stopped) {
      // Found a solution (or user stopped) — done.
      const final: SearchProgress = {
        ...accumulated,
        validSolutionsFound: accumulated.validSolutionsFound,
        stopped:   r.stopped,
        timedOut:  false,
        done:      !r.stopped,
        exhausted: false,
      };
      onProgress(final);
      return { solutions: r.solutions, progress: final };
    }

    // This restart timed out with no solution.  Accumulate counts and try next.
  }

  // All restarts exhausted without finding a solution.
  const final: SearchProgress = {
    ...accumulated,
    timedOut:  true,
    done:      false,
    exhausted: false,
  };
  onProgress(final);
  return { solutions: [], progress: final };
}

// ── Main entry point ──────────────────────────────────────────────────────────
export function runSearch(
  gen:              number,
  topGraph:         Graph,
  bottomGraph:      Graph,
  mode:             SearchMode = 'all',
  shouldStop:       () => boolean = () => false,
  onProgress:       (p: SearchProgress) => void = () => {},
  onSolution:       (s: SolutionSnapshot) => void = () => {},
  safetyTimeLimitMs = 60_000,
  fixedCrossEdges?: CrossEdge[],
): SearchResult {

  const topFrontier = topGraph.nodes.filter(n => n.isFrontier);
  const botFrontier = bottomGraph.nodes.filter(n => n.isFrontier);

  const empty = (extra: Partial<SearchProgress> = {}): SearchResult => ({
    solutions: [],
    progress: {
      partialStatesExplored: 0, completeMatchingsEvaluated: 0, validSolutionsFound: 0,
      stopped: false, timedOut: false, done: true, exhausted: true, ...extra,
    },
  });

  if (topFrontier.length !== botFrontier.length) {
    return empty({ unequalCounts: true });
  }

  const parentColor = computeParentColors(topGraph, bottomGraph, topFrontier, botFrontier);
  const maxSolutions = mode === 'first1' ? 1 : mode === 'first10' ? 10 : 200;

  if (mode === 'first1') {
    return runWithRestarts(
      gen, topGraph, bottomGraph, topFrontier, botFrontier,
      parentColor, shouldStop, onProgress, onSolution, safetyTimeLimitMs, fixedCrossEdges,
    );
  }

  return runSinglePass(
    gen, topGraph, bottomGraph, topFrontier, botFrontier,
    parentColor, maxSolutions, shouldStop, onProgress, onSolution, safetyTimeLimitMs, fixedCrossEdges,
  );
}
