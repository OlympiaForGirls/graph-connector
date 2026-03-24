// useGraphInteraction: manages click-selection, pending color, and cross-edge state.
// Uses useReducer so all state transitions are pure and easy to test.
// No validation logic here — that lives in src/validation/.
//
// Edge-creation is now explicit via CREATE_EDGE (dispatched by App.tsx after
// validation). NODE_CLICK is a pure selection toggle — it never creates edges.
// This supports pairings within the same graph as well as across graphs.

import { useReducer, useCallback } from 'react';
import type { CrossEdge, EdgeColor } from '../types/graph';

export interface SelectedNode {
  graphId: string;   // 'top' | 'bot'
  nodeId: string;
}

interface State {
  selectedNode: SelectedNode | null;
  crossEdges: CrossEdge[];
  /** Color assigned to the next created cross-edge. */
  pendingColor: EdgeColor;
}

type Action =
  | { type: 'NODE_CLICK'; graphId: string; nodeId: string }
  | { type: 'SET_COLOR';  color: EdgeColor }
  | { type: 'REMOVE_EDGE'; edgeId: string }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'RESET' }
  | { type: 'APPLY_SOLUTION'; crossEdges: CrossEdge[] }
  | { type: 'CREATE_EDGE'; nodeAId: string; nodeBId: string; color: EdgeColor };

const initialState: State = {
  selectedNode: null,
  crossEdges:   [],
  pendingColor: 'red',
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_COLOR':
      return { ...state, pendingColor: action.color };

    case 'NODE_CLICK': {
      const { graphId, nodeId } = action;
      // Toggle: deselect if clicking the already-selected node, otherwise select.
      if (state.selectedNode?.nodeId === nodeId)
        return { ...state, selectedNode: null };
      return { ...state, selectedNode: { graphId, nodeId } };
    }

    case 'CREATE_EDGE': {
      // nodeAId / nodeBId may belong to the same graph or different graphs.
      const newEdge: CrossEdge = {
        id:           `cross-${Date.now()}`,
        topNodeId:    action.nodeAId,
        bottomNodeId: action.nodeBId,
        color:        action.color,
      };
      return { ...state, selectedNode: null, crossEdges: [...state.crossEdges, newEdge] };
    }

    case 'REMOVE_EDGE':
      return { ...state, crossEdges: state.crossEdges.filter(e => e.id !== action.edgeId) };

    case 'CLEAR_SELECTION':
      return { ...state, selectedNode: null };

    case 'RESET':
      return initialState;

    case 'APPLY_SOLUTION':
      return { ...state, crossEdges: action.crossEdges, selectedNode: null };
  }
}

export function useGraphInteraction() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const handleNodeClick = useCallback(
    (graphId: string, nodeId: string) => dispatch({ type: 'NODE_CLICK', graphId, nodeId }), []);
  const setColor        = useCallback(
    (color: EdgeColor) => dispatch({ type: 'SET_COLOR', color }), []);
  const removeCrossEdge = useCallback(
    (edgeId: string) => dispatch({ type: 'REMOVE_EDGE', edgeId }), []);
  const clearSelection  = useCallback(() => dispatch({ type: 'CLEAR_SELECTION' }), []);
  const reset           = useCallback(() => dispatch({ type: 'RESET' }), []);
  const applySolution   = useCallback(
    (crossEdges: CrossEdge[]) => dispatch({ type: 'APPLY_SOLUTION', crossEdges }), []);
  const createEdge      = useCallback(
    (nodeAId: string, nodeBId: string, color: EdgeColor) =>
      dispatch({ type: 'CREATE_EDGE', nodeAId, nodeBId, color }), []);

  return {
    ...state,
    handleNodeClick, setColor, removeCrossEdge,
    clearSelection, reset, applySolution, createEdge,
  };
}
