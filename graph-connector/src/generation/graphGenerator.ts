// graphGenerator.ts — builds a ternary-root binary-branching tree with absolute SVG coordinates.
//
// STRUCTURE ASSUMPTIONS:
//   - Level 0: single root node with exactly 3 children (degree 3).
//   - Level 1: 3 nodes, each with 1 parent edge + 2 child edges = degree 3.
//   - Levels 2 … gen-1: internal nodes, each with 1 parent edge + 2 child edges = degree 3.
//   - Level gen: frontier nodes, each with 1 parent edge = degree 1.
//     Frontier nodes are open connection points; remaining capacity filled by cross-graph edges.
//
// NODE COUNTS per level:
//   level 0:   1
//   level 1:   3
//   level k≥2: 3 × 2^(k−1)
//   frontier (level gen, gen≥1): 3 × 2^(gen−1)
//
// EDGE COLORING:
//   Root's 3 children (level 1) receive colors [blue, green, red] at positions [0, 1, 2].
//   For level k≥2, given a node whose parent edge has color C, its two child edges get
//   the remaining two colors from {blue, green, red} sorted alphabetically:
//     childColors('blue')  → ['green', 'red']
//     childColors('green') → ['blue', 'red']
//     childColors('red')   → ['blue', 'green']
//   Every internal node thus has exactly one edge of each color (proper 3-edge-coloring).
//
// LAYOUT:
//   Nodes use absolute SVG coordinates passed via LayoutOptions.
//   The bottom graph is generated with negative levelHeight so it grows upward.

import type { Graph, GraphNode, GraphEdge, EdgeColor } from '../types/graph';

// ── Layout constants (exported for App.tsx layout math) ───────
export const NODE_SPACING = 80;   // px between adjacent frontier nodes
export const LEVEL_HEIGHT = 75;   // px per tree level
export const CONNECTOR_H  = 80;   // px gap between the two frontier rows
export const NODE_RADIUS  = 14;   // node circle radius (visual reference)
export const MAX_GEN      = 10;
export const MIN_GEN      = 1;

const PAD_X   = 40;
const PAD_TOP = 44;   // room for label above root
const PAD_BOT = 40;
const MIN_W   = 420;

// ── Node count helpers ────────────────────────────────────────

/** Number of nodes at the given level (root = level 0). */
function nodesAtLevel(level: number): number {
  if (level === 0) return 1;
  if (level === 1) return 3;
  return 3 * Math.pow(2, level - 1);
}

/** Total frontier nodes for a given gen (= nodesAtLevel(gen) for gen ≥ 1). */
export function frontierCount(gen: number): number {
  return nodesAtLevel(gen);
}

/** Total node count across all levels 0 … gen (= 3·2^gen − 2 for gen ≥ 1). */
export function totalNodeCount(gen: number): number {
  // sum_{k=0}^{gen} nodesAtLevel(k) = 1 + 3*(2^gen - 1) = 3*2^gen - 2
  return 3 * Math.pow(2, gen) - 2;
}

// ── SVG dimension calculation ─────────────────────────────────

export interface SvgDimensions {
  svgW: number;
  svgH: number;
  centerX: number;
  topRootY: number;       // y of top graph root
  topFrontierY: number;   // y of top graph frontier row
  botFrontierY: number;   // y of bottom graph frontier row
  botRootY: number;       // y of bottom graph root
}

export function computeSvgDimensions(gen: number): SvgDimensions {
  const fc      = frontierCount(gen);
  const span    = fc * NODE_SPACING;
  const svgW    = Math.max(MIN_W, span + 2 * PAD_X);
  const centerX = svgW / 2;

  const topRootY     = PAD_TOP;
  const topFrontierY = PAD_TOP + gen * LEVEL_HEIGHT;
  const botFrontierY = topFrontierY + CONNECTOR_H;
  const botRootY     = botFrontierY + gen * LEVEL_HEIGHT;
  const svgH         = botRootY + PAD_BOT;

  return { svgW, svgH, centerX, topRootY, topFrontierY, botFrontierY, botRootY };
}

// ── Graph generation ──────────────────────────────────────────

export interface LayoutOptions {
  graphId: 'top' | 'bot';
  rootX: number;
  rootY: number;
  /** Positive = downward (top graph). Negative = upward (bottom graph). */
  levelHeight: number;
}

export function generateGraph(gen: number, opts: LayoutOptions): Graph {
  const { graphId, rootX, rootY, levelHeight } = opts;

  const fc        = frontierCount(gen);
  const totalSpan = fc * NODE_SPACING;
  const leftEdge  = rootX - totalSpan / 2;

  // Per-node records: track parentEdgeColor for assigning child colors.
  interface NodeRecord { level: number; pos: number; parentEdgeColor: EdgeColor | null }
  const records: NodeRecord[] = [];

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (let level = 0; level <= gen; level++) {
    const count      = nodesAtLevel(level);
    const subWidth   = totalSpan / count;
    const isFrontier = level === gen;

    for (let pos = 0; pos < count; pos++) {
      const x  = leftEdge + pos * subWidth + subWidth / 2;
      const y  = rootY + level * levelHeight;
      const id = mkNodeId(graphId, level, pos);

      let parentEdgeColor: EdgeColor | null = null;

      if (level === 1) {
        // Root's three children receive one distinct color each.
        const rootChildColors: EdgeColor[] = ['blue', 'green', 'red'];
        parentEdgeColor = rootChildColors[pos];
        edges.push({
          id:       mkEdgeId(graphId, level, pos),
          sourceId: mkNodeId(graphId, 0, 0),
          targetId: id,
          color:    parentEdgeColor,
        });
      } else if (level > 1) {
        const parentPos = Math.floor(pos / 2);
        const isLeft    = pos % 2 === 0;
        const parent    = records.find(r => r.level === level - 1 && r.pos === parentPos)!;
        const [lc, rc]  = childColors(parent.parentEdgeColor);
        parentEdgeColor = isLeft ? lc : rc;
        edges.push({
          id:       mkEdgeId(graphId, level, pos),
          sourceId: mkNodeId(graphId, level - 1, parentPos),
          targetId: id,
          color:    parentEdgeColor,
        });
      }

      records.push({ level, pos, parentEdgeColor });
      nodes.push({ id, x, y, isFrontier });
    }
  }

  return { id: graphId, nodes, edges };
}

// ── Internal helpers ──────────────────────────────────────────

function mkNodeId(graphId: string, level: number, pos: number): string {
  return `${graphId}-${level}:${pos}`;
}

function mkEdgeId(graphId: string, level: number, pos: number): string {
  return `${graphId}-e${level}:${pos}`;
}

/**
 * Returns [leftChildColor, rightChildColor] for a node whose parent edge had `parentEdgeColor`.
 * Uses the remaining two colors from {blue, green, red} in alphabetical order.
 */
function childColors(parentEdgeColor: EdgeColor | null): [EdgeColor, EdgeColor] {
  const all: EdgeColor[] = ['blue', 'green', 'red'];
  const rest = all.filter(c => c !== parentEdgeColor) as EdgeColor[];
  return [rest[0], rest[1]];
}
