import type { EdgeColor } from '../types/graph';

/** A single colored connection edge (top frontier ↔ bottom frontier). */
export interface NCEdge {
  topNodeId: string;
  bottomNodeId: string;
  color: EdgeColor;
}

/** One complete drawing order: n colored edges in the sequence they were drawn. */
export type NCDrawingOrder = NCEdge[];

/**
 * One search result: a structural matching (n uncolored pairs) that forms a single
 * simple cycle through all n pairs, plus every valid (order + color) combination.
 */
export interface NCResult {
  id: string;
  /** The n (top, bottom) pairs — the structural edge set without colors. */
  pairs: Array<{ topNodeId: string; bottomNodeId: string }>;
  /**
   * Full node sequence of the single simple cycle, including tree-internal nodes.
   * Does NOT repeat the starting node at the end.
   */
  cycleNodeIds: string[];
  /** All valid drawing orders discovered (may be capped at maxOrdersPerResult). */
  validOrders: NCDrawingOrder[];
  validOrderCount: number;
}

export interface NCProgress {
  matchingsChecked: number;
  candidateCyclesFound: number;
  validOrdersFound: number;
  stopped: boolean;
  done: boolean;
  timedOut?: boolean;
}

// ── Worker message protocol ────────────────────────────────────────────────────

import type { Graph } from '../types/graph';

export interface NCSearchPayload {
  n: number;
  topGraph: Graph;
  bottomGraph: Graph;
  maxOrdersPerResult: number;
  timeLimitMs: number;
}

export type NCWorkerIn = { type: 'START'; payload: NCSearchPayload };

export type NCWorkerOut =
  | { type: 'ACK' }
  | { type: 'RESULT'; result: NCResult }
  | { type: 'PROGRESS'; progress: NCProgress }
  | { type: 'DONE'; progress: NCProgress }
  | { type: 'ERROR'; message: string };
