// colorCompatibility.ts — Rule A: same-color endpoint check.
//
// ASSUMPTION (Rule A):
//   At any node incident to the proposed new edge, no two edges of the same
//   color may be incident. Equivalently: if the proposed edge has color C,
//   and either endpoint already has an incident edge (internal or cross) of
//   color C, the move is forbidden.
//
// To change the rule, edit isSameColorForbidden. The helpers above it are
// general-purpose and do not encode the rule themselves.

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';

/**
 * Returns the set of colors already used by edges incident to nodeId,
 * across all three edge sources: left-graph, right-graph, and cross-edges.
 */
export function getIncidentColors(
  nodeId: string,
  leftGraph: Graph,
  rightGraph: Graph,
  crossEdges: CrossEdge[],
): Set<EdgeColor> {
  const colors = new Set<EdgeColor>();

  for (const e of leftGraph.edges) {
    if (e.sourceId === nodeId || e.targetId === nodeId) colors.add(e.color);
  }
  for (const e of rightGraph.edges) {
    if (e.sourceId === nodeId || e.targetId === nodeId) colors.add(e.color);
  }
  for (const e of crossEdges) {
    if (e.topNodeId === nodeId || e.bottomNodeId === nodeId) colors.add(e.color);
  }

  return colors;
}

/**
 * Returns whether adding a cross-edge of `color` between the two nodes is
 * forbidden due to a same-color collision at either endpoint.
 *
 * Current rule: forbidden if EITHER endpoint already has an incident edge
 * of the same color (Rule A above). Change this function to adjust the rule.
 */
export function checkColorCompatibility(
  topNodeId: string,
  bottomNodeId: string,
  color: EdgeColor,
  topGraph: Graph,
  bottomGraph: Graph,
  existingCrossEdges: CrossEdge[],
): { ok: true } | { ok: false; reason: string } {
  const topColors    = getIncidentColors(topNodeId,    topGraph, bottomGraph, existingCrossEdges);
  const bottomColors = getIncidentColors(bottomNodeId, topGraph, bottomGraph, existingCrossEdges);

  if (topColors.has(color)) {
    return { ok: false, reason: `${topNodeId} already has a ${color} edge — same color at endpoint.` };
  }
  if (bottomColors.has(color)) {
    return { ok: false, reason: `${bottomNodeId} already has a ${color} edge — same color at endpoint.` };
  }

  return { ok: true };
}
