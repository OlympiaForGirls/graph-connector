// partialWorker.ts — Web Worker entry point for partial matching search.
//
// Message protocol (main → worker):
//   { type: 'START', payload: { gen, topGraph, bottomGraph, targetEdges, maxPatterns } }
//
// Message protocol (worker → main):
//   { type: 'PATTERN',  pattern: PartialPattern   } — one per valid partial, streamed
//   { type: 'PROGRESS', progress: PartialProgress } — emitted every ~200 steps
//   { type: 'DONE',     result: PartialResult     } — sent once when search ends
//   { type: 'ERROR',    message: string           }

import { runPartialSearch } from './partialSearch';
import type { PartialProgress, PartialResult } from './partialSearch';
import type { PartialPattern } from '../types/partial';
import type { Graph } from '../types/graph';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = self as any;

ctx.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data as {
    type: string;
    payload: {
      gen: number;
      topGraph: Graph;
      bottomGraph: Graph;
      targetEdges: number;
      maxPatterns: number;
    };
  };

  if (type !== 'START') return;

  const { gen, topGraph, bottomGraph, targetEdges, maxPatterns } = payload;

  ctx.postMessage({ type: 'ACK', gen, targetEdges });

  try {
    const result: PartialResult = runPartialSearch(
      gen,
      topGraph,
      bottomGraph,
      targetEdges,
      maxPatterns,
      () => false,
      (progress: PartialProgress) => ctx.postMessage({ type: 'PROGRESS', progress }),
      (pattern: PartialPattern)   => ctx.postMessage({ type: 'PATTERN',  pattern }),
      60_000,
    );

    ctx.postMessage({ type: 'DONE', result });
  } catch (err) {
    ctx.postMessage({ type: 'ERROR', message: String(err) });
  }
};
