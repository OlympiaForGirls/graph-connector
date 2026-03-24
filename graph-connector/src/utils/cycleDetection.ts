// cycleDetection.ts — pure utility, no React, no side effects.
//
// ASSUMPTIONS (document here so they are easy to change later):
//
//  1. Simple graph: no multi-edges between the same pair of nodes.
//     Minimum meaningful cycle length is 3 edges.
//
//  2. De-duplication only — the normalization in cycleKey() is used SOLELY
//     to avoid reporting the same cycle multiple times (once per starting node,
//     once per direction). It is NOT the "forbidden cycle" rotation/mirror check.
//     That check will live in src/validation/ (future step).
//
//  3. cycleKey normalization: try every rotation; also try every rotation of the
//     reversed sequence. Take the lexicographically smallest result. This gives a
//     unique canonical key per undirected simple cycle regardless of where the DFS
//     happened to start or which direction it traversed.
//
//  4. The "prevNode" back-tracking guard is sufficient for simple graphs.
//     For multigraphs (same pair, multiple colored edges) it would need to track
//     the specific edge id used, not just the neighbor node.

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';

// ── Public types ───────────────────────────────────────────────

export interface Cycle {
  id: string;
  /** Ordered node IDs. Does NOT repeat the first node at the end. */
  nodes: string[];
  /**
   * colors[i] = color of the edge from nodes[i] → nodes[(i+1) % length].
   * Length always equals nodes.length.
   */
  colors: EdgeColor[];
}

// ── Internal adjacency list ────────────────────────────────────

type AdjEntry = { to: string; color: EdgeColor };
export type AdjList = Map<string, AdjEntry[]>;

function addUndirectedEdge(adj: AdjList, a: string, b: string, color: EdgeColor) {
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a)!.push({ to: b, color });
  adj.get(b)!.push({ to: a, color });
}

/**
 * Merges all three edge sources into one undirected adjacency list.
 * Left-graph nodes use their own ids (l*), right-graph nodes use theirs (r*).
 */
export function buildUnifiedAdjList(
  leftGraph: Graph,
  rightGraph: Graph,
  crossEdges: CrossEdge[],
): AdjList {
  const adj: AdjList = new Map();

  // Seed every node so isolated nodes appear in the map.
  for (const n of leftGraph.nodes)  adj.set(n.id, []);
  for (const n of rightGraph.nodes) adj.set(n.id, []);

  for (const e of leftGraph.edges)
    addUndirectedEdge(adj, e.sourceId, e.targetId, e.color);
  for (const e of rightGraph.edges)
    addUndirectedEdge(adj, e.sourceId, e.targetId, e.color);
  for (const e of crossEdges)
    addUndirectedEdge(adj, e.topNodeId, e.bottomNodeId, e.color);

  return adj;
}

// ── Canonical key for deduplication ───────────────────────────

/**
 * Returns a canonical string for the cycle so that rotations and reflections
 * of the same cycle map to the same key.
 *
 * Algorithm: generate all n rotations and all n rotations of the reversed
 * sequence; return the lexicographically smallest.
 *
 * NOTE: This is ONLY used for dedup inside findAllCycles. The separate
 * "are these two cycles equivalent under the game's rules?" check is not here.
 */
function cycleKey(nodes: string[], colors: EdgeColor[]): string {
  const n = nodes.length;
  let best = '';

  for (let i = 0; i < n; i++) {
    // Forward rotation starting at index i
    const fn = [...nodes.slice(i), ...nodes.slice(0, i)];
    const fc = [...colors.slice(i), ...colors.slice(0, i)];
    const fwd = fn.join('\x00') + '|' + fc.join('\x00');
    if (best === '' || fwd < best) best = fwd;

    // Reverse rotation: go around the cycle the other way, starting at nodes[i].
    // Reversed node sequence: [nodes[i], nodes[i-1], ..., nodes[i+1]] (mod n).
    // Reversed color sequence: the edge from nodes[i] back to nodes[i-1] had
    // color colors[(i-1+n)%n], etc. Equivalently, reverse the rotated colors.
    const rn = [fn[0], ...fn.slice(1).reverse()];
    const rc = [...fc].reverse();
    const rev = rn.join('\x00') + '|' + rc.join('\x00');
    if (rev < best) best = rev;
  }

  return best;
}

// ── DFS cycle finder ───────────────────────────────────────────

/**
 * Finds all simple cycles in the undirected graph given by adjList.
 *
 * Approach:
 *   - DFS from every node as a potential cycle "start".
 *   - Track the current path; when a neighbor equals the start node and the
 *     path has >= 3 nodes, a cycle has been closed.
 *   - Guard against immediate back-tracking with prevNode.
 *   - De-duplicate via cycleKey (see assumption 3 above).
 *
 * Complexity: exponential in the worst case, but fine for small graphs (≤ ~20 nodes).
 */
export function findAllCycles(adjList: AdjList): Cycle[] {
  const nodeIds = Array.from(adjList.keys()).sort();
  const dedup   = new Set<string>();
  const cycles: Cycle[] = [];

  function dfs(
    start:      string,
    current:    string,
    path:       string[],     // nodes visited so far (includes start)
    pathColors: EdgeColor[],  // pathColors[i] = color of edge path[i]→path[i+1]
    prevNode:   string | null,
  ) {
    for (const { to, color } of adjList.get(current) ?? []) {
      // Never immediately backtrack along the edge we just came from.
      if (to === prevNode) continue;

      if (to === start && path.length >= 3) {
        // Closed a simple cycle back to start.
        const key = cycleKey(path, [...pathColors, color]);
        if (!dedup.has(key)) {
          dedup.add(key);
          cycles.push({
            id: `cycle-${cycles.length}`,
            nodes:  [...path],
            colors: [...pathColors, color],
          });
        }
        continue;
      }

      // Only continue to nodes not already in the path (simple cycle constraint).
      if (!path.includes(to)) {
        path.push(to);
        pathColors.push(color);
        dfs(start, to, path, pathColors, current);
        path.pop();
        pathColors.pop();
      }
    }
  }

  for (const start of nodeIds) {
    dfs(start, start, [start], [], null);
  }

  return cycles;
}
