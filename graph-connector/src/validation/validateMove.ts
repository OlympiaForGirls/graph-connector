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
  /** Node IDs involved in offending cycles (for visual highlight). Empty on success. */
  offendingNodeIds: string[];
  /** Canonical edge keys "A|B" (lexicographically sorted) in offending cycles. Empty on success. */
  offendingEdgeKeys: string[];
  /** Node ID that triggered Rule A color conflict, or '' if not a Rule A failure. */
  ruleAConflictNodeId: string;
}

// ── Helpers ───────────────────────────────────────────────────

/** Canonical undirected edge key: smaller node ID first. */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

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
      offendingNodeIds: [colorCheck.conflictNodeId],
      offendingEdgeKeys: [],
      ruleAConflictNodeId: colorCheck.conflictNodeId,
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

  // Collect nodes and edges from cycles that violated a rule (for visual highlight).
  const offNodeSet = new Set<string>();
  const offEdgeSet = new Set<string>();
  for (const a of analyses) {
    if (!a.rejectedForRotation && !a.rejectedForMirror) continue;
    for (const n of a.cycle.nodes) offNodeSet.add(n);
    for (let i = 0; i < a.cycle.nodes.length; i++) {
      offEdgeSet.add(edgeKey(a.cycle.nodes[i], a.cycle.nodes[(i + 1) % a.cycle.nodes.length]));
    }
  }
  const offendingNodeIds  = [...offNodeSet];
  const offendingEdgeKeys = [...offEdgeSet];

  if (anyRotationViolation) {
    return {
      allowed: false,
      reason: 'A new cycle has a color pattern rotationally equivalent to an existing cycle.',
      newCycleAnalyses: analyses,
      allCyclesAfter,
      anyRotationViolation: true,
      anyMirrorViolation,
      offendingNodeIds,
      offendingEdgeKeys,
      ruleAConflictNodeId: '',
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
      offendingNodeIds,
      offendingEdgeKeys,
      ruleAConflictNodeId: '',
    };
  }

  return {
    allowed: true,
    reason: 'Move accepted.',
    newCycleAnalyses: analyses,
    allCyclesAfter,
    anyRotationViolation: false,
    anyMirrorViolation: false,
    offendingNodeIds: [],
    offendingEdgeKeys: [],
    ruleAConflictNodeId: '',
  };
}
