// matchingWorker.ts — Web Worker entry point for the matching search.
//
// Loaded via:
//   new Worker(new URL('./matchingWorker.ts', import.meta.url), { type: 'module' })
//
// Message protocol (main → worker):
//   { type: 'START', payload: { gen, topGraph, bottomGraph, mode } }
//   (To stop: call worker.terminate() from the main thread — postMessage STOP
//    cannot interrupt a running synchronous DFS since the message queue is
//    blocked while the worker event loop is occupied.)
//
// Message protocol (worker → main):
//   { type: 'SOLUTION',  solution: SolutionSnapshot } — one per valid solution, streamed
//   { type: 'PROGRESS',  progress: SearchProgress   } — emitted every ~200 DFS steps
//   { type: 'DONE',      result:   SearchResult      } — sent once when search ends

import { runSearch } from './matchingSearch';
import type { SearchMode, SearchProgress, SearchResult } from './matchingSearch';
import type { SolutionSnapshot } from '../types/solution';
import type { Graph } from '../types/graph';

// `self` is DedicatedWorkerGlobalScope at runtime; cast to any because the
// project's tsconfig targets the DOM lib rather than the webworker lib.
/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = self as any;

ctx.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data as {
    type: string;
    payload: { gen: number; topGraph: Graph; bottomGraph: Graph; mode: SearchMode };
  };

  if (type !== 'START') return;

  const { gen, topGraph, bottomGraph, mode } = payload;

  const topFrontierCount = topGraph.nodes.filter((n: { isFrontier: boolean }) => n.isFrontier).length;
  const botFrontierCount = bottomGraph.nodes.filter((n: { isFrontier: boolean }) => n.isFrontier).length;
  console.log(`[worker] gen=${gen} topFrontier=${topFrontierCount} botFrontier=${botFrontierCount} mode=${mode}`);

  // Send an immediate acknowledgement so the main thread can verify the worker
  // received the START message (distinct from the first PROGRESS emission).
  ctx.postMessage({ type: 'ACK', gen, topFrontierCount, botFrontierCount });

  try {
    const result: SearchResult = runSearch(
      gen,
      topGraph,
      bottomGraph,
      mode,
      () => false,   // stopping is done via worker.terminate(), not a flag
      (progress: SearchProgress) => ctx.postMessage({ type: 'PROGRESS', progress }),
      (solution: SolutionSnapshot) => ctx.postMessage({ type: 'SOLUTION', solution }),
      60_000,
    );

    ctx.postMessage({ type: 'DONE', result });
  } catch (err) {
    ctx.postMessage({ type: 'ERROR', message: String(err) });
  }
};
