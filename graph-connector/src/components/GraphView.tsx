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
}

export default function GraphView({ graph, selectedNodeId, onNodeClick }: GraphViewProps) {
  const nodeById = Object.fromEntries(graph.nodes.map(n => [n.id, n]));

  return (
    <g>
      {/* Edges */}
      {graph.edges.map(edge => {
        const src = nodeById[edge.sourceId];
        const tgt = nodeById[edge.targetId];
        if (!src || !tgt) return null;
        return (
          <line
            key={edge.id}
            x1={src.x} y1={src.y}
            x2={tgt.x} y2={tgt.y}
            stroke={EDGE_COLORS[edge.color]}
            strokeWidth={3}
            strokeLinecap="round"
          />
        );
      })}

      {/* Nodes — rendered above edges */}
      {graph.nodes.map(node => {
        const isSelected = node.id === selectedNodeId;
        return (
          <g
            key={node.id}
            onClick={() => onNodeClick(graph.id, node.id)}
            style={{ cursor: 'pointer' }}
          >
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
