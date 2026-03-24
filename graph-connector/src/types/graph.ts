// Core types for the graph explorer app.
export type EdgeColor = 'red' | 'green' | 'blue';

export interface GraphNode {
  id: string;
  x: number;         // absolute SVG x coordinate
  y: number;         // absolute SVG y coordinate
  isFrontier: boolean;
  // Frontier nodes have degree < 3 within their own graph by design —
  // the missing edge(s) are filled by user-added cross-graph connections.
  // Non-frontier (internal) nodes satisfy degree-3 where appropriate.
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  color: EdgeColor;
}

// A single graph (top or bottom side).
export interface Graph {
  id: string;   // 'top' | 'bot'
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// A connection added by the user between a top-graph frontier node
// and a bottom-graph frontier node.
export interface CrossEdge {
  id: string;
  topNodeId: string;     // node in the top graph
  bottomNodeId: string;  // node in the bottom graph
  color: EdgeColor;
}
