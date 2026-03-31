// graphGenerator.js — generates the same tree structure as the frontend.
// No SVG coordinates: x/y are not needed for search, only node IDs and edges.
'use strict';

function nodesAtLevel(level) {
  if (level === 0) return 1;
  if (level === 1) return 3;
  return 3 * Math.pow(2, level - 1);
}

function childColors(parentColor) {
  const all  = ['blue', 'green', 'red'];
  const rest = all.filter(c => c !== parentColor);
  return [rest[0], rest[1]];
}

function generateGraph(gen, graphId) {
  const nodes   = [];
  const edges   = [];
  const records = [];

  for (let level = 0; level <= gen; level++) {
    const count      = nodesAtLevel(level);
    const isFrontier = level === gen;

    for (let pos = 0; pos < count; pos++) {
      const id = `${graphId}-${level}:${pos}`;
      let parentEdgeColor = null;

      if (level === 1) {
        const rootChildColors = ['blue', 'green', 'red'];
        parentEdgeColor = rootChildColors[pos];
        edges.push({ id: `${graphId}-e${level}:${pos}`, sourceId: `${graphId}-0:0`, targetId: id, color: parentEdgeColor });
      } else if (level > 1) {
        const parentPos = Math.floor(pos / 2);
        const isLeft    = pos % 2 === 0;
        const parent    = records.find(r => r.level === level - 1 && r.pos === parentPos);
        const [lc, rc]  = childColors(parent.parentEdgeColor);
        parentEdgeColor = isLeft ? lc : rc;
        edges.push({ id: `${graphId}-e${level}:${pos}`, sourceId: `${graphId}-${level - 1}:${parentPos}`, targetId: id, color: parentEdgeColor });
      }

      records.push({ level, pos, parentEdgeColor });
      nodes.push({ id, isFrontier });
    }
  }

  return { id: graphId, nodes, edges };
}

module.exports = { generateGraph };
