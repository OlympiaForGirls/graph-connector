// GraphView: renders one graph as a <g> group inside the shared SVG canvas.
// Node coordinates are absolute SVG coordinates — no offset transform needed.
// Must be a <g> (not its own <svg>) so cross-edges can span both graphs.

import type { Graph, EdgeColor } from '../types/graph';

export const EDGE_COLORS: Record<EdgeColor, string> = {
  red:   '#e84040',
  green: '#3ab03a',
  blue:  '#3a7ee8',
};

const NODE_RADIUS = 14;

// Short display label from a node id like 'top-2:3' → '2:3'
function shortLabel(nodeId: string): string {
  const colon = nodeId.indexOf('-');
  return colon >= 0 ? nodeId.slice(colon + 1) : nodeId;
}

interface GraphViewProps {
  graph: Graph;
  /** The nodeId currently selected in this graph, or null. */
  selectedNodeId: string | null;
  onNodeClick: (graphId: string, nodeId: string) => void;
  /** Node IDs to highlight with an orange glow ring (invalid-move feedback). */
  highlightNodeIds?: ReadonlySet<string>;
  /** Canonical edge keys "A|B" for tree edges to highlight orange. */
  highlightEdgeKeys?: ReadonlySet<string>;
  /** Node IDs that are part of the loaded N-Cycle result (teal ring). */
  cycleNodeIds?: ReadonlySet<string>;
  /** Canonical edge keys for tree edges that are part of the cycle (teal glow). */
  cycleEdgeKeys?: ReadonlySet<string>;
}

export default function GraphView({
  graph, selectedNodeId, onNodeClick,
  highlightNodeIds, highlightEdgeKeys,
  cycleNodeIds, cycleEdgeKeys,
}: GraphViewProps) {
  const nodeById = Object.fromEntries(graph.nodes.map(n => [n.id, n]));

  return (
    <g>
      {/* Edges */}
      {graph.edges.map(edge => {
        const src = nodeById[edge.sourceId];
        const tgt = nodeById[edge.targetId];
        if (!src || !tgt) return null;
        const ekey = edge.sourceId < edge.targetId
          ? `${edge.sourceId}|${edge.targetId}`
          : `${edge.targetId}|${edge.sourceId}`;
        const isHighlighted  = highlightEdgeKeys?.has(ekey) ?? false;
        const isCycleEdge   = cycleEdgeKeys?.has(ekey) ?? false;
        return (
          <g key={edge.id}>
            {isCycleEdge && (
              <line
                x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                stroke="#00c8d8" strokeWidth={11} strokeLinecap="round" opacity={0.35}
              />
            )}
            {isHighlighted && (
              <line
                x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                stroke="#f5a623" strokeWidth={9} strokeLinecap="round" opacity={0.45}
              />
            )}
            <line
              x1={src.x} y1={src.y}
              x2={tgt.x} y2={tgt.y}
              stroke={EDGE_COLORS[edge.color]}
              strokeWidth={3}
              strokeLinecap="round"
            />
          </g>
        );
      })}

      {/* Nodes — rendered above edges */}
      {graph.nodes.map(node => {
        const isSelected    = node.id === selectedNodeId;
        const isHighlighted = highlightNodeIds?.has(node.id) ?? false;
        const isCycleNode   = cycleNodeIds?.has(node.id) ?? false;
        return (
          <g
            key={node.id}
            onClick={() => onNodeClick(graph.id, node.id)}
            style={{ cursor: 'pointer' }}
          >
            {isCycleNode && (
              <circle
                cx={node.x} cy={node.y}
                r={NODE_RADIUS + 11}
                fill="none" stroke="#00c8d8" strokeWidth={2.5} opacity={0.5}
              />
            )}
            {isHighlighted && (
              <circle
                cx={node.x} cy={node.y}
                r={NODE_RADIUS + 9}
                fill="none" stroke="#f5a623" strokeWidth={3} opacity={0.6}
              />
            )}
            {isSelected && (
              <circle
                cx={node.x} cy={node.y}
                r={NODE_RADIUS + 7}
                fill="none" stroke="#f5a623" strokeWidth={2} opacity={0.5}
              />
            )}
            <circle
              cx={node.x} cy={node.y}
              r={NODE_RADIUS}
              fill={isSelected ? '#f5a623' : node.isFrontier ? '#e8e8ff' : '#1e1e2e'}
              stroke={isSelected ? '#ffca5a' : node.isFrontier ? '#f5a623' : '#6666aa'}
              strokeWidth={node.isFrontier ? 3 : 2}
              strokeDasharray={node.isFrontier && !isSelected ? '4 2' : undefined}
            />
            <text
              x={node.x} y={node.y + 4}
              textAnchor="middle"
              fontSize={9} fontWeight={600}
              fill={isSelected ? '#1e1e2e' : node.isFrontier ? '#334' : '#99a'}
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              {shortLabel(node.id)}
            </text>
          </g>
        );
      })}
    </g>
  );
}
