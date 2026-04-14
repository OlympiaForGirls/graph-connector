// graphGenerator.ts — builds a tree graph with absolute SVG coordinates.
//
// Two graph families (GraphTemplate):
//
//   '3branch' (default / current):
//     Level 0: 1 root with exactly 3 children.
//     Level 1: 3 nodes, each degree 3 (1 parent + 2 children).
//     Levels 2…gen-1: interior nodes, each degree 3.
//     Frontier (level gen): 3 × 2^(gen-1) nodes, degree 1 (1 parent edge).
//
//   '2branch':
//     Level 0: 1 root with exactly 2 children.
//     Level 1: 2 nodes, each degree 3 (1 parent + 2 children).
//     Levels 2…gen-1: interior nodes, each degree 3.
//     Frontier (level gen): 2^gen nodes, degree 1 (1 parent edge).
//
// EDGE COLORING (both families):
//   '3branch' root children → [blue, green, red] at positions [0,1,2].
//   '2branch' root children → [blue, green] at positions [0,1].
//   For level k≥2: given a node whose parent edge has color C, its two
//   child edges get the remaining two colors from {blue,green,red}
//   sorted alphabetically (same rule for both families).
//
// LAYOUT:
//   Nodes use absolute SVG coordinates passed via LayoutOptions.
//   The bottom graph uses negative levelHeight so it grows upward.

import type { Graph, GraphNode, GraphEdge, EdgeColor } from '../types/graph';

// ── Graph template ────────────────────────────────────────────────────────────
// '3branch' | '2branch' — two-tree mode (top + bottom graph face each other).
// 'solo'                — single-tree mode (one binary tree, frontier self-connects).
export type GraphTemplate = '3branch' | '2branch' | 'solo';

// ── Layout constants (exported for App.tsx layout math) ───────────────────────
export const NODE_SPACING   = 80;
export const LEVEL_HEIGHT   = 75;
export const CONNECTOR_H    = 80;
/** Vertical gap between solo-tree frontier and the shadow soloB frontier (0 = same row). */
const SOLO_CONNECTOR = 0;
export const NODE_RADIUS    = 14;
export const MAX_GEN        = 10;
export const MIN_GEN        = 1;

const PAD_X   = 40;
const PAD_TOP = 44;
const PAD_BOT = 40;
const MIN_W   = 420;

// ── Node count helpers ────────────────────────────────────────────────────────

function nodesAtLevel(level: number, template: GraphTemplate): number {
  if (level === 0) return 1;
  if (template === '2branch' || template === 'solo') return Math.pow(2, level);
  if (level === 1) return 3;
  return 3 * Math.pow(2, level - 1);
}

export function frontierCount(gen: number, template: GraphTemplate = '3branch'): number {
  return nodesAtLevel(gen, template);
}

export function totalNodeCount(gen: number, template: GraphTemplate = '3branch'): number {
  if (template === '2branch' || template === 'solo') return Math.pow(2, gen + 1) - 1;
  return 3 * Math.pow(2, gen) - 2;
}

// ── SVG dimension calculation ─────────────────────────────────────────────────

export interface SvgDimensions {
  svgW: number;
  svgH: number;
  centerX: number;
  topRootY: number;
  topFrontierY: number;
  botFrontierY: number;
  botRootY: number;
}

export function computeSvgDimensions(gen: number, template: GraphTemplate = '3branch'): SvgDimensions {
  const fc      = frontierCount(gen, template);
  const span    = fc * NODE_SPACING;
  const svgW    = Math.max(MIN_W, span + 2 * PAD_X);
  const centerX = svgW / 2;

  const topRootY     = PAD_TOP;
  const topFrontierY = PAD_TOP + gen * LEVEL_HEIGHT;

  if (template === 'solo') {
    // Single-tree layout: soloB shadow tree placed SOLO_CONNECTOR below solo frontier.
    // soloB root is at topRootY + SOLO_CONNECTOR so that soloB frontier lands at
    // topFrontierY + SOLO_CONNECTOR (= botFrontierY).
    const botFrontierY = topFrontierY + SOLO_CONNECTOR;
    const botRootY     = topRootY + SOLO_CONNECTOR;  // soloB root (not rendered)
    const svgH         = botFrontierY + PAD_BOT;
    return { svgW, svgH, centerX, topRootY, topFrontierY, botFrontierY, botRootY };
  }

  const botFrontierY = topFrontierY + CONNECTOR_H;
  const botRootY     = botFrontierY + gen * LEVEL_HEIGHT;
  const svgH         = botRootY + PAD_BOT;

  return { svgW, svgH, centerX, topRootY, topFrontierY, botFrontierY, botRootY };
}

// ── Graph generation ──────────────────────────────────────────────────────────

export interface LayoutOptions {
  graphId: 'top' | 'bot' | 'solo' | 'soloB';
  rootX: number;
  rootY: number;
  levelHeight: number;
}

export function generateGraph(
  gen: number,
  opts: LayoutOptions,
  template: GraphTemplate = '3branch',
): Graph {
  const { graphId, rootX, rootY, levelHeight } = opts;

  // 'solo' uses the same binary-tree structure as '2branch'.
  const tpl: '2branch' | '3branch' = template === 'solo' ? '2branch' : template;

  const fc        = frontierCount(gen, tpl);
  const totalSpan = fc * NODE_SPACING;
  const leftEdge  = rootX - totalSpan / 2;

  interface NodeRecord { level: number; pos: number; parentEdgeColor: EdgeColor | null }
  const records: NodeRecord[] = [];

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Root children colors depend on the effective template.
  const rootChildColors: EdgeColor[] =
    tpl === '2branch' ? ['blue', 'green'] : ['blue', 'green', 'red'];

  for (let level = 0; level <= gen; level++) {
    const count      = nodesAtLevel(level, tpl);
    const subWidth   = totalSpan / count;
    const isFrontier = level === gen;

    for (let pos = 0; pos < count; pos++) {
      const x  = leftEdge + pos * subWidth + subWidth / 2;
      const y  = rootY + level * levelHeight;
      const id = mkNodeId(graphId, level, pos);

      let parentEdgeColor: EdgeColor | null = null;

      if (level === 1) {
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

// ── Internal helpers ──────────────────────────────────────────────────────────

function mkNodeId(graphId: string, level: number, pos: number): string {
  return `${graphId}-${level}:${pos}`;
}

function mkEdgeId(graphId: string, level: number, pos: number): string {
  return `${graphId}-e${level}:${pos}`;
}

function childColors(parentEdgeColor: EdgeColor | null): [EdgeColor, EdgeColor] {
  const all: EdgeColor[] = ['blue', 'green', 'red'];
  const rest = all.filter(c => c !== parentEdgeColor) as EdgeColor[];
  return [rest[0], rest[1]];
}
