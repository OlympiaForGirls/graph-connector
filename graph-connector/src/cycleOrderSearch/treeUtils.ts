import type { Graph } from '../types/graph';

/**
 * Returns the unique path from `fromId` to `toId` in the tree, as a sequence of
 * node IDs including both endpoints. Returns null if the nodes are not connected.
 */
export function getTreePath(graph: Graph, fromId: string, toId: string): string[] | null {
  if (fromId === toId) return [fromId];

  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    adj.get(e.sourceId)!.push(e.targetId);
    adj.get(e.targetId)!.push(e.sourceId);
  }

  // BFS — trees are acyclic so this always finds the unique shortest path.
  const parent = new Map<string, string>([[fromId, '']]);
  const queue = [fromId];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === toId) {
      const path: string[] = [];
      let node = toId;
      while (node !== '') {
        path.unshift(node);
        node = parent.get(node)!;
      }
      return path;
    }
    for (const next of adj.get(curr) ?? []) {
      if (!parent.has(next)) {
        parent.set(next, curr);
        queue.push(next);
      }
    }
  }
  return null;
}

/**
 * Returns true if all paths in the array are vertex-disjoint, considering only
 * INTERNAL nodes (all nodes except the first and last in each path).
 *
 * Frontier nodes are always the first/last of their path. Since all selected
 * frontier nodes are distinct, they cannot appear as internal nodes of any path
 * in a binary tree (leaves have degree 1, so no path passes through them).
 */
export function checkPathsVertexDisjoint(paths: string[][]): boolean {
  const seen = new Set<string>();
  for (const path of paths) {
    const internals = path.slice(1, -1);
    for (const nodeId of internals) {
      if (seen.has(nodeId)) return false;
      seen.add(nodeId);
    }
  }
  return true;
}
