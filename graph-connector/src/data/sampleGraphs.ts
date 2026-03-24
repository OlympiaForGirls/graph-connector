// Hardcoded sample 3-regular graph structures.
// In the final combined graph (left + cross-edges + right), every node has degree 3.
// Frontier nodes here have degree 2 within their own graph; the missing edge
// will be supplied by a user-added cross-graph connection.
//
// Layout coordinates fit a 300×280 SVG viewport (left/right graphs share the same dims).

import type { Graph } from '../types/graph';

// Sample A: a simple 6-node structure laid out like a tree.
// Top 4 nodes are internal (degree 3), bottom 2 are frontier (degree 2).
//
//         [l0]
//        /    \
//      [l1]  [l2]
//      / \    / \
//    [l3][l4][l5][l6]  <- only l4 & l5 are frontier (center-bottom)
//
// For simplicity this placeholder uses 6 nodes and approximate tree layout.
// Exact 3-regularity will be enforced by data once interaction is implemented.
export const sampleLeftGraph: Graph = {
  id: 'left',
  nodes: [
    { id: 'l0', x: 150, y: 40,  isFrontier: false },
    { id: 'l1', x: 80,  y: 120, isFrontier: false },
    { id: 'l2', x: 220, y: 120, isFrontier: false },
    { id: 'l3', x: 40,  y: 220, isFrontier: false },
    { id: 'l4', x: 140, y: 220, isFrontier: true  },
    { id: 'l5', x: 260, y: 220, isFrontier: true  },
  ],
  edges: [
    { id: 'le0', sourceId: 'l0', targetId: 'l1', color: 'red'   },
    { id: 'le1', sourceId: 'l0', targetId: 'l2', color: 'blue'  },
    { id: 'le2', sourceId: 'l1', targetId: 'l3', color: 'green' },
    { id: 'le3', sourceId: 'l1', targetId: 'l4', color: 'blue'  },
    { id: 'le4', sourceId: 'l2', targetId: 'l4', color: 'red'   },
    { id: 'le5', sourceId: 'l2', targetId: 'l5', color: 'green' },
    { id: 'le6', sourceId: 'l0', targetId: 'l3', color: 'green' },
  ],
};

// Mirror of sampleLeftGraph for the right side.
// x-coordinates are flipped (300 - x) so the layout mirrors left-to-right.
export const sampleRightGraph: Graph = {
  id: 'right',
  nodes: [
    { id: 'r0', x: 150, y: 40,  isFrontier: false },
    { id: 'r1', x: 220, y: 120, isFrontier: false },
    { id: 'r2', x: 80,  y: 120, isFrontier: false },
    { id: 'r3', x: 260, y: 220, isFrontier: false },
    { id: 'r4', x: 160, y: 220, isFrontier: true  },
    { id: 'r5', x: 40,  y: 220, isFrontier: true  },
  ],
  edges: [
    { id: 're0', sourceId: 'r0', targetId: 'r1', color: 'red'   },
    { id: 're1', sourceId: 'r0', targetId: 'r2', color: 'blue'  },
    { id: 're2', sourceId: 'r1', targetId: 'r3', color: 'green' },
    { id: 're3', sourceId: 'r1', targetId: 'r4', color: 'blue'  },
    { id: 're4', sourceId: 'r2', targetId: 'r4', color: 'red'   },
    { id: 're5', sourceId: 'r2', targetId: 'r5', color: 'green' },
    { id: 're6', sourceId: 'r0', targetId: 'r3', color: 'green' },
  ],
};
