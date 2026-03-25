// auditWorker.ts — Web Worker for correctness auditing.
//
// Runs the naive brute-force solver and the optimized CP solver on the same
// input, then compares their solution sets to detect:
//   • Completeness bugs: solutions found by naive but not optimized.
//   • Safety bugs: solutions found by optimized but not naive (false positives).
//
// Message protocol (main → worker):
//   { type: 'START', payload: { gen, topGraph, bottomGraph } }
//
// Message protocol (worker → main):
//   { type: 'ACK'        }
//   { type: 'STATUS',    message: string }
//   { type: 'NAIVE_DONE', count: number, stats: NaiveStats }
//   { type: 'OPT_DONE',   count: number }
//   { type: 'DONE',       result: AuditResult }
//   { type: 'ERROR',      message: string }

import { runNaiveSolver } from './naiveSolver';
import { runSearch } from './matchingSearch';
import type { Graph } from '../types/graph';
import type { SolutionSnapshot } from '../types/solution';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = self as any;

/** Canonical key for a solution — order-independent so both solvers' keys match. */
function solutionKey(sol: SolutionSnapshot): string {
  return sol.connections
    .map(c => `${c.from}|${c.to}|${c.color}`)
    .sort()
    .join('~');
}

ctx.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data as {
    type: string;
    payload: { gen: number; topGraph: Graph; bottomGraph: Graph };
  };

  if (type !== 'START') return;

  const { gen, topGraph, bottomGraph } = payload;
  ctx.postMessage({ type: 'ACK' });

  try {
    // ── 1. Naive solver (ground truth) ────────────────────────────────────────
    ctx.postMessage({ type: 'STATUS', message: 'Running naive solver (this may take a moment)…' });

    const naiveResult = runNaiveSolver(gen, topGraph, bottomGraph, 500, () => false);

    ctx.postMessage({
      type: 'NAIVE_DONE',
      count: naiveResult.solutions.length,
      stats: {
        partialStatesExplored:      naiveResult.partialStatesExplored,
        completeMatchingsEvaluated: naiveResult.completeMatchingsEvaluated,
      },
    });

    // ── 2. Optimized CP solver ─────────────────────────────────────────────────
    ctx.postMessage({ type: 'STATUS', message: 'Running optimized solver…' });

    const optResult = runSearch(
      gen, topGraph, bottomGraph, 'all',
      () => false, () => {}, () => {}, 120_000,
    );

    ctx.postMessage({ type: 'OPT_DONE', count: optResult.solutions.length });

    // ── 3. Compare ─────────────────────────────────────────────────────────────
    ctx.postMessage({ type: 'STATUS', message: 'Comparing solution sets…' });

    const naiveMap = new Map<string, SolutionSnapshot>(
      naiveResult.solutions.map(s => [solutionKey(s), s]),
    );
    const optMap = new Map<string, SolutionSnapshot>(
      optResult.solutions.map(s => [solutionKey(s), s]),
    );

    const missedByOpt: SolutionSnapshot[] = [];
    const falseByOpt:  SolutionSnapshot[] = [];

    for (const [k, s] of naiveMap) {
      if (!optMap.has(k)) missedByOpt.push(s);
    }
    for (const [k, s] of optMap) {
      if (!naiveMap.has(k)) falseByOpt.push(s);
    }

    ctx.postMessage({
      type: 'DONE',
      result: {
        naiveCount:  naiveResult.solutions.length,
        optCount:    optResult.solutions.length,
        matchCount:  naiveResult.solutions.length - missedByOpt.length,
        missedByOpt,
        falseByOpt,
        naiveStats: {
          partialStatesExplored:      naiveResult.partialStatesExplored,
          completeMatchingsEvaluated: naiveResult.completeMatchingsEvaluated,
        },
        optStats: {
          partialStatesExplored:      optResult.progress.partialStatesExplored,
          completeMatchingsEvaluated: optResult.progress.completeMatchingsEvaluated,
        },
        optExhausted: optResult.progress.exhausted,
        optTimedOut:  optResult.progress.timedOut,
      },
    });
  } catch (err) {
    ctx.postMessage({ type: 'ERROR', message: String(err) });
  }
};
