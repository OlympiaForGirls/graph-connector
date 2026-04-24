// cycleOrderWorker.ts — Web Worker entry point for the N-Cycle Search.
//
// Worker message protocol (main → worker):
//   { type: 'START', payload: NCSearchPayload }
//   (Stopping: call worker.terminate() from the main thread.)
//
// Worker message protocol (worker → main):
//   { type: 'ACK' }                          — immediate acknowledgement
//   { type: 'RESULT',   result:   NCResult } — one per valid result, streamed
//   { type: 'PROGRESS', progress: NCProgress } — emitted periodically
//   { type: 'DONE',     progress: NCProgress } — sent once when complete
//   { type: 'ERROR',    message:  string }    — on uncaught exception

import { runNCSearch } from './runNCSearch';
import type { NCSearchPayload, NCResult, NCProgress } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = self as any;

ctx.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data as { type: string; payload: NCSearchPayload };
  if (type !== 'START') return;

  const { n, topGraph, bottomGraph, maxOrdersPerResult, timeLimitMs } = payload;

  ctx.postMessage({ type: 'ACK' });

  try {
    const final = runNCSearch(
      n,
      topGraph,
      bottomGraph,
      (result: NCResult)   => ctx.postMessage({ type: 'RESULT',   result }),
      (progress: NCProgress) => ctx.postMessage({ type: 'PROGRESS', progress }),
      () => false,  // stopping is via worker.terminate()
      maxOrdersPerResult,
      timeLimitMs,
    );
    ctx.postMessage({ type: 'DONE', progress: final });
  } catch (err) {
    ctx.postMessage({ type: 'ERROR', message: String(err) });
  }
};
