// App.tsx — top-level layout.
// Two generated binary-tree graphs face each other vertically:
//   top graph: root at top, frontier nodes at bottom of its region
//   bottom graph: root at bottom, frontier nodes at top of its region
//
// Pairing edges may connect any two frontier nodes — same tree or across trees.

import { useState, useMemo, useEffect, useCallback } from 'react';
import GraphView, { EDGE_COLORS } from './components/GraphView';
import ColorPicker from './components/ColorPicker';
import GenSelector from './components/GenSelector';
import SearchMode from './components/SearchMode';
import PartialSearch from './components/PartialSearch';
import CompleteFromPartial from './components/CompleteFromPartial';
import DebugValidation from './components/DebugValidation';
import AuditMode from './components/AuditMode';
import RandomSearch from './components/RandomSearch';
import { generateGraph, computeSvgDimensions, LEVEL_HEIGHT } from './generation/graphGenerator';
import { useGraphInteraction } from './hooks/useGraphInteraction';
import { validateMove } from './validation/validateMove';
import type { ValidationResult } from './validation/validateMove';
import type { CycleAnalysis } from './validation/cycleAnalysis';
import { validateGraph } from './validation/validateGraph';
import type { GraphValidationResult } from './validation/validateGraph';
import type { CrossEdge } from './types/graph';
import type { ConnectionSnapshot } from './types/solution';
import type { PartialPattern } from './types/partial';
import './index.css';

// ── RejectionOverlay ──────────────────────────────────────────────────────
interface RejectionOverlay {
  x1: number; y1: number;
  x2: number; y2: number;
  highlightNodeIds: ReadonlySet<string>;
  highlightEdgeKeys: ReadonlySet<string>;
}

// ── CrossEdgeLayer ─────────────────────────────────────────────────────────
// Looks up each endpoint in topPos first, then bottomPos.
// This supports top↔bottom, top↔top, and bottom↔bottom pairings.
function CrossEdgeLayer({
  crossEdges,
  topPos,
  bottomPos,
  onRemove,
}: {
  crossEdges: CrossEdge[];
  topPos:    Record<string, { x: number; y: number }>;
  bottomPos: Record<string, { x: number; y: number }>;
  onRemove: (id: string) => void;
}) {
  return (
    <g>
      {crossEdges.map(edge => {
        const a = topPos[edge.topNodeId]    ?? bottomPos[edge.topNodeId];
        const b = topPos[edge.bottomNodeId] ?? bottomPos[edge.bottomNodeId];
        if (!a || !b) return null;
        const mx  = (a.x + b.x) / 2;
        const my  = (a.y + b.y) / 2;
        const clr = EDGE_COLORS[edge.color];
        return (
          <g key={edge.id}>
            <line
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={clr} strokeWidth={2.5}
              strokeDasharray="7 3" strokeLinecap="round" opacity={0.9}
            />
            <g onClick={() => onRemove(edge.id)} style={{ cursor: 'pointer' }}>
              <circle cx={mx} cy={my} r={10} fill="#1e1e2e" stroke="#44445a" strokeWidth={1.5} />
              <text
                x={mx} y={my + 4} textAnchor="middle"
                fontSize={11} fontWeight={700} fill="#e84040"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >×</text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

// ── CrossEdgeGlowLayer ────────────────────────────────────────────────────
// Renders orange glow lines behind cross edges that are part of offending cycles.
function CrossEdgeGlowLayer({
  crossEdges, topPos, bottomPos, highlightEdgeKeys,
}: {
  crossEdges:       CrossEdge[];
  topPos:           Record<string, { x: number; y: number }>;
  bottomPos:        Record<string, { x: number; y: number }>;
  highlightEdgeKeys: ReadonlySet<string> | null;
}) {
  if (!highlightEdgeKeys || highlightEdgeKeys.size === 0) return null;
  return (
    <g>
      {crossEdges.map(edge => {
        const a = topPos[edge.topNodeId]    ?? bottomPos[edge.topNodeId];
        const b = topPos[edge.bottomNodeId] ?? bottomPos[edge.bottomNodeId];
        if (!a || !b) return null;
        const key = edge.topNodeId < edge.bottomNodeId
          ? `${edge.topNodeId}|${edge.bottomNodeId}`
          : `${edge.bottomNodeId}|${edge.topNodeId}`;
        if (!highlightEdgeKeys.has(key)) return null;
        return (
          <line
            key={edge.id}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke="#f5a623" strokeWidth={9} strokeLinecap="round" opacity={0.45}
          />
        );
      })}
    </g>
  );
}

// ── GhostEdgeLayer ────────────────────────────────────────────────────────
// Renders the rejected edge attempt as a dashed red line with an × mark.
function GhostEdgeLayer({ overlay }: { overlay: RejectionOverlay | null }) {
  if (!overlay) return null;
  const { x1, y1, x2, y2 } = overlay;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <g>
      <line
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke="#e84040" strokeWidth={2} strokeDasharray="6 3"
        strokeLinecap="round" opacity={0.5}
      />
      <text
        x={mx} y={my + 6}
        textAnchor="middle" fontSize={18} fontWeight={900}
        fill="#e84040" opacity={0.85}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >✕</text>
    </g>
  );
}

// ── CycleAnalysisRow ───────────────────────────────────────────────────────
function CycleAnalysisRow({ a }: { a: CycleAnalysis }) {
  const flags: string[] = [];
  if (a.rejectedForRotation) flags.push('rotation duplicate');
  if (a.rejectedForMirror)   flags.push('mirror-symmetric (even)');
  const isRejected = flags.length > 0;
  return (
    <li className={`cycle-item${isRejected ? ' cycle-item--rejected' : ''}`}>
      <span className="cycle-len">{a.cycle.nodes.length}</span>
      <span className="cycle-seq">
        {a.cycle.nodes.map((nodeId, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <span className="cycle-node">{nodeId.replace(/^[^-]+-/, '')}</span>
            <span
              className="cycle-edge-dot"
              style={{ background: EDGE_COLORS[a.colorSeq[i]] }}
              title={a.colorSeq[i]}
            />
          </span>
        ))}
        <span className="cycle-return">↩</span>
      </span>
      <span className="cycle-norm">
        [{a.normalizedSeq.map((c, i) => (
          <span key={i} className="cycle-norm-dot" style={{ background: EDGE_COLORS[c] }} title={c} />
        ))}]
      </span>
      {flags.length > 0 && <span className="cycle-flags">{flags.join(', ')}</span>}
    </li>
  );
}

// ── App ────────────────────────────────────────────────────────────────────
export default function App() {
  const [gen, setGen]               = useState(2);
  const [mode, setMode]             = useState<'manual' | 'search' | 'partial' | 'complete' | 'audit' | 'random'>('manual');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [rejection, setRejection]   = useState<RejectionOverlay | null>(null);
  const [showCycles, setShowCycles] = useState(true);
  const [selectedPartial, setSelectedPartial] = useState<PartialPattern | null>(null);
  const [debugResult, setDebugResult] = useState<GraphValidationResult | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  const {
    selectedNode, crossEdges, pendingColor,
    handleNodeClick, setColor, removeCrossEdge,
    clearSelection, reset, applySolution, createEdge,
  } = useGraphInteraction();

  // Regenerate both graphs whenever gen changes.
  const { topGraph, bottomGraph, dims } = useMemo(() => {
    const dims = computeSvgDimensions(gen);
    const topGraph = generateGraph(gen, {
      graphId: 'top',
      rootX: dims.centerX,
      rootY: dims.topRootY,
      levelHeight: LEVEL_HEIGHT,
    });
    const bottomGraph = generateGraph(gen, {
      graphId: 'bot',
      rootX: dims.centerX,
      rootY: dims.botRootY,
      levelHeight: -LEVEL_HEIGHT,   // grows upward
    });
    return { topGraph, bottomGraph, dims };
  }, [gen]);

  // r/g/b keyboard shortcuts for colour selection in Manual Mode.
  useEffect(() => {
    if (mode !== 'manual') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'r') setColor('red');
      if (e.key === 'g') setColor('green');
      if (e.key === 'b') setColor('blue');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, setColor]);

  // Reset all connections when gen changes (old node IDs are no longer valid).
  useEffect(() => {
    reset();
    setValidation(null);
    setRejection(null);
  }, [gen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Absolute position maps — used by CrossEdgeLayer.
  const topPos    = useMemo(
    () => Object.fromEntries(topGraph.nodes.map(n => [n.id, { x: n.x, y: n.y }])),
    [topGraph],
  );
  const bottomPos = useMemo(
    () => Object.fromEntries(bottomGraph.nodes.map(n => [n.id, { x: n.x, y: n.y }])),
    [bottomGraph],
  );

  // Combined node lookup (both graphs) for frontier checks.
  const allNodes = useMemo(
    () => new Map([...topGraph.nodes, ...bottomGraph.nodes].map(n => [n.id, n])),
    [topGraph, bottomGraph],
  );

  // Click handler for Manual Mode.
  // Allows pairing any two frontier nodes — same tree or across trees.
  const handleClick = useCallback((graphId: string, nodeId: string) => {
    const node = allNodes.get(nodeId);

    if (!selectedNode) {
      // First click: only select frontier nodes.
      if (node?.isFrontier) handleNodeClick(graphId, nodeId);
      setValidation(null);
      setRejection(null);
      return;
    }

    // Clicking the already-selected node, or a non-frontier node → deselect.
    if (selectedNode.nodeId === nodeId || !node?.isFrontier) {
      clearSelection();
      setValidation(null);
      setRejection(null);
      return;
    }

    // Two distinct frontier nodes selected — validate then create.
    const result = validateMove(topGraph, bottomGraph, crossEdges, {
      topNodeId:    selectedNode.nodeId,
      bottomNodeId: nodeId,
      color:        pendingColor,
    });
    setValidation(result);
    if (result.allowed) {
      createEdge(selectedNode.nodeId, nodeId, pendingColor);
      setRejection(null);
    } else {
      const fromPos = topPos[selectedNode.nodeId] ?? bottomPos[selectedNode.nodeId];
      const toPos   = topPos[nodeId] ?? bottomPos[nodeId];
      if (fromPos && toPos) {
        setRejection({
          x1: fromPos.x, y1: fromPos.y,
          x2: toPos.x,   y2: toPos.y,
          highlightNodeIds: new Set(result.offendingNodeIds),
          highlightEdgeKeys: new Set(result.offendingEdgeKeys),
        });
      }
      clearSelection();
    }
  }, [selectedNode, crossEdges, pendingColor, topGraph, bottomGraph,
      allNodes, handleNodeClick, clearSelection, createEdge, topPos, bottomPos]);

  const handleReset  = useCallback(() => { reset(); setValidation(null); setRejection(null); setDebugResult(null); }, [reset]);
  const handleRemove = useCallback(
    (id: string) => { removeCrossEdge(id); setValidation(null); setRejection(null); setDebugResult(null); },
    [removeCrossEdge],
  );

  const handleDebugValidate = useCallback(() => {
    setDebugResult(validateGraph(topGraph, bottomGraph, crossEdges));
  }, [topGraph, bottomGraph, crossEdges]);

  // Transfer a partial pattern from Partial Search to Complete From Partial.
  const handleSelectPartial = useCallback((p: PartialPattern) => {
    setSelectedPartial(p);
    setMode('complete');
  }, []);

  // Load a solution from Search Mode: apply edges and switch to Manual tab.
  const handleLoadSolution = useCallback((connections: ConnectionSnapshot[]) => {
    const edges: CrossEdge[] = connections.map((c, i) => ({
      id:           `sol-${i}`,
      topNodeId:    c.from,
      bottomNodeId: c.to,
      color:        c.color,
    }));
    applySolution(edges);
    setValidation(null);
    setMode('manual');
  }, [applySolution]);

  const isValid = validation?.allowed ?? null;
  const hint = selectedNode
    ? `${selectedNode.nodeId} selected — click another frontier node to connect`
    : 'Click a frontier node to start a connection.';

  const { svgW, svgH, topRootY, botRootY } = dims;

  return (
    <div className="app">
      <header className="app-header">
        <h1>3-Regular Graph Connection</h1>
        <p className="subtitle"></p>
      </header>

      {/* Controls row */}
      <div className="controls-row">
        <GenSelector value={gen} onChange={setGen} />
        {mode === 'manual' && <ColorPicker value={pendingColor} onChange={setColor} />}
      </div>

      <main className="app-main">
        <svg
          width={svgW} height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="graph-canvas"
        >
          {/* Graph labels */}
          <text
            x={svgW / 2} y={topRootY - 18}
            textAnchor="middle" fontSize={11} fontWeight={700}
            fill="#9999cc" letterSpacing={1.5}
            style={{ userSelect: 'none' }}
          >TOP GRAPH</text>
          <text
            x={svgW / 2} y={botRootY + 28}
            textAnchor="middle" fontSize={11} fontWeight={700}
            fill="#9999cc" letterSpacing={1.5}
            style={{ userSelect: 'none' }}
          >BOTTOM GRAPH</text>

          {/* Cycle glow and ghost edge — behind cross edges and nodes */}
          <CrossEdgeGlowLayer
            crossEdges={crossEdges}
            topPos={topPos} bottomPos={bottomPos}
            highlightEdgeKeys={rejection?.highlightEdgeKeys ?? null}
          />

          {/* Pairing edges drawn first (behind nodes) */}
          <CrossEdgeLayer
            crossEdges={crossEdges}
            topPos={topPos} bottomPos={bottomPos}
            onRemove={handleRemove}
          />

          <GhostEdgeLayer overlay={rejection} />

          <GraphView
            graph={topGraph}
            selectedNodeId={selectedNode?.graphId === 'top' ? selectedNode.nodeId : null}
            onNodeClick={mode === 'manual' ? handleClick : () => {}}
            highlightNodeIds={rejection?.highlightNodeIds}
            highlightEdgeKeys={rejection?.highlightEdgeKeys}
          />
          <GraphView
            graph={bottomGraph}
            selectedNodeId={selectedNode?.graphId === 'bot' ? selectedNode.nodeId : null}
            onNodeClick={mode === 'manual' ? handleClick : () => {}}
            highlightNodeIds={rejection?.highlightNodeIds}
            highlightEdgeKeys={rejection?.highlightEdgeKeys}
          />
        </svg>
      </main>

      {/* Mode tab bar */}
      <div className="mode-tabs">
        <button
          className={`mode-tab${mode === 'manual' ? ' mode-tab--active' : ''}`}
          onClick={() => setMode('manual')}
        >Manual Mode</button>
        <button
          className={`mode-tab${mode === 'search' ? ' mode-tab--active' : ''}`}
          onClick={() => setMode('search')}
        >Search Mode</button>
        <button
          className={`mode-tab${mode === 'partial' ? ' mode-tab--active' : ''}`}
          onClick={() => setMode('partial')}
        >Partial Search</button>
        <button
          className={`mode-tab${mode === 'complete' ? ' mode-tab--active' : ''}`}
          onClick={() => setMode('complete')}
        >Complete From Partial</button>
        <button
          className={`mode-tab${mode === 'audit' ? ' mode-tab--active' : ''}`}
          onClick={() => setMode('audit')}
        >Audit</button>
        <button
          className={`mode-tab${mode === 'random' ? ' mode-tab--active' : ''}`}
          onClick={() => setMode('random')}
        >Random Search</button>
      </div>

      {/* All panels always mounted; visibility toggled via display:none. */}
      <aside className="status-panel" style={mode !== 'manual' ? { display: 'none' } : {}}>
        <h3>Status</h3>

        <p className="status-row">
          <span className="status-label">Pairing edges:</span>
          <span>{crossEdges.length}</span>
        </p>
        <p className="status-row">
          <span className="status-label">Valid:</span>
          {isValid === null && <span className="status-dim">—</span>}
          {isValid === true  && <span className="status-ok">✓ Accepted</span>}
          {isValid === false && <span className="status-err">✗ Rejected</span>}
        </p>
        {validation && !validation.allowed && (
          <p className="status-row status-reason">
            <span className="status-label">Reason:</span>
            <span>{validation.reason}</span>
          </p>
        )}
        <p className="status-row status-hint">{hint}</p>

        {crossEdges.length > 0 && (
          <>
            <ul className="edge-list">
              {crossEdges.map(e => (
                <li key={e.id} className="edge-item">
                  <span className="edge-dot" style={{ background: EDGE_COLORS[e.color] }} />
                  <span className="edge-label">{e.topNodeId} ↔ {e.bottomNodeId}</span>
                  <button className="edge-remove-btn" onClick={() => handleRemove(e.id)}>×</button>
                </li>
              ))}
            </ul>
            <button className="reset-btn" onClick={handleReset}>Reset all</button>
          </>
        )}

        {validation && !validation.allowed && (
          <div className="cycle-section">
            <button className="cycle-toggle" onClick={() => setShowCycles(v => !v)}>
              New cycles from last move ({validation.newCycleAnalyses.length}){' '}
              {showCycles ? '▲' : '▼'}
            </button>
            {showCycles && (
              validation.newCycleAnalyses.length === 0
                ? <p className="cycle-empty">No new cycles formed.</p>
                : (
                  <ul className="cycle-list">
                    {validation.newCycleAnalyses.map(a => (
                      <CycleAnalysisRow key={a.cycle.id} a={a} />
                    ))}
                  </ul>
                )
            )}
          </div>
        )}

        <div className="dbg-section">
          <button
            className="dbg-run-btn"
            onClick={() => { handleDebugValidate(); setShowDebug(true); }}
          >
            Validate Graph (debug)
          </button>
          {debugResult && (
            <button
              className="cycle-toggle dbg-toggle"
              onClick={() => setShowDebug(v => !v)}
            >
              {debugResult.valid ? '✓ Valid' : '✗ Invalid'}{' '}
              {showDebug ? '▲' : '▼'}
            </button>
          )}
          {showDebug && debugResult && (
            <DebugValidation result={debugResult} crossEdges={crossEdges} />
          )}
        </div>
      </aside>

      <aside className="status-panel search-panel" style={mode !== 'search' ? { display: 'none' } : {}}>
        <h3>Search Mode</h3>
        <SearchMode
          gen={gen}
          topGraph={topGraph}
          bottomGraph={bottomGraph}
          onLoadSolution={handleLoadSolution}
        />
      </aside>

      <aside className="status-panel search-panel" style={mode !== 'partial' ? { display: 'none' } : {}}>
        <h3>Partial Search</h3>
        <PartialSearch
          gen={gen}
          topGraph={topGraph}
          bottomGraph={bottomGraph}
          onSelectPattern={handleSelectPartial}
        />
      </aside>

      <aside className="status-panel search-panel" style={mode !== 'complete' ? { display: 'none' } : {}}>
        <h3>Complete From Partial</h3>
        <CompleteFromPartial
          gen={gen}
          topGraph={topGraph}
          bottomGraph={bottomGraph}
          pattern={selectedPartial}
          onLoadSolution={handleLoadSolution}
        />
      </aside>

      <aside className="status-panel search-panel" style={mode !== 'audit' ? { display: 'none' } : {}}>
        <h3>Correctness Audit</h3>
        <AuditMode gen={gen} topGraph={topGraph} bottomGraph={bottomGraph} />
      </aside>

      <aside className="status-panel search-panel" style={mode !== 'random' ? { display: 'none' } : {}}>
        <h3>Random Search</h3>
        <RandomSearch
          gen={gen}
          topGraph={topGraph}
          bottomGraph={bottomGraph}
          onLoadSolution={handleLoadSolution}
        />
      </aside>
    </div>
  );
}
