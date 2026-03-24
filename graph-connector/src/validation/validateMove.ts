// validateMove.ts — orchestrates all validation checks for a proposed cross-edge.
//
// Call order:
//   1. Rule A — same-color endpoint check (fast, no cycle computation needed)
//   2. Build post-move graph, find all cycles
//   3. Identify NEW cycles: those that use the proposed edge
//   4. Rule B — rotation equivalence check on new cycles vs existing cycles
//   5. Rule C — mirror symmetry check on new even cycles
//
// Stops at the first failing rule and returns the reason.

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';
import type { Cycle } from '../utils/cycleDetection';
import { buildUnifiedAdjList, findAllCycles } from '../utils/cycleDetection';
import { checkColorCompatibility } from './colorCompatibility';
import { analyzeCycles } from './cycleAnalysis';
import type { CycleAnalysis } from './cycleAnalysis';

// ── Public result type ────────────────────────────────────────

export interface ValidationResult {
  allowed: boolean;
  /** Human-readable reason — always set (success or failure). */
  reason: string;
  /** Analysis of new cycles formed by this move (empty on Rule A failure). */
  newCycleAnalyses: CycleAnalysis[];
  /** All cycles in the post-move graph, for display. */
  allCyclesAfter: Cycle[];
  anyRotationViolation: boolean;
  anyMirrorViolation: boolean;
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Returns true if `cycle` traverses the undirected edge (a, b).
 * Used to identify which post-move cycles are NEW (they must use the new edge).
 */
function cycleUsesEdge(cycle: Cycle, a: string, b: string): boolean {
  const n = cycle.nodes.length;
  for (let i = 0; i < n; i++) {
    const u = cycle.nodes[i];
    const v = cycle.nodes[(i + 1) % n];
    if ((u === a && v === b) || (u === b && v === a)) return true;
  }
  return false;
}

// ── Main entry point ──────────────────────────────────────────

/**
 * Validates whether adding a cross-edge with the given color between
 * leftNodeId and rightNodeId is permitted under Rules A, B, and C.
 *
 * Returns a ValidationResult describing outcome and cycle analysis.
 * Pure function — does not mutate any inputs.
 */
export function validateMove(
  topGraph: Graph,
  bottomGraph: Graph,
  existingCrossEdges: CrossEdge[],
  proposed: { topNodeId: string; bottomNodeId: string; color: EdgeColor },
): ValidationResult {
  const { topNodeId, bottomNodeId, color } = proposed;

  // ── Rule A ────────────────────────────────────────────────────
  const colorCheck = checkColorCompatibility(
    topNodeId, bottomNodeId, color,
    topGraph, bottomGraph, existingCrossEdges,
  );
  if (!colorCheck.ok) {
    return {
      allowed: false,
      reason: colorCheck.reason,
      newCycleAnalyses: [],
      allCyclesAfter: [],
      anyRotationViolation: false,
      anyMirrorViolation: false,
    };
  }

  // ── Build provisional post-move graph ────────────────────────
  const provisional: CrossEdge = {
    id: '__provisional__',
    topNodeId, bottomNodeId, color,
  };
  const adj = buildUnifiedAdjList(topGraph, bottomGraph, [...existingCrossEdges, provisional]);
  const allCyclesAfter = findAllCycles(adj);

  // Partition: new cycles (use the proposed edge) vs existing (don't).
  const newCycles      = allCyclesAfter.filter(c => cycleUsesEdge(c, topNodeId, bottomNodeId));
  const existingCycles = allCyclesAfter.filter(c => !cycleUsesEdge(c, topNodeId, bottomNodeId));

  // ── Rules B + C ───────────────────────────────────────────────
  const { analyses, anyRotationViolation, anyMirrorViolation } =
    analyzeCycles(existingCycles, newCycles);

  if (anyRotationViolation) {
    return {
      allowed: false,
      reason: 'A new cycle has a color pattern rotationally equivalent to an existing cycle.',
      newCycleAnalyses: analyses,
      allCyclesAfter,
      anyRotationViolation: true,
      anyMirrorViolation,
    };
  }

  if (anyMirrorViolation) {
    return {
      allowed: false,
      reason: 'A new even-length cycle has mirror symmetry (reversed sequence = cyclic rotation of original).',
      newCycleAnalyses: analyses,
      allCyclesAfter,
      anyRotationViolation: false,
      anyMirrorViolation: true,
    };
  }

  return {
    allowed: true,
    reason: 'Move accepted.',
    newCycleAnalyses: analyses,
    allCyclesAfter,
    anyRotationViolation: false,
    anyMirrorViolation: false,
  };
}
