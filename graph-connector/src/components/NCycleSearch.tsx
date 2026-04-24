// NCycleSearch.tsx
//
// Display hierarchy:
//   Edge-Set Group
//     ├── Colorings (A, B, C …) ← grouped by WHAT colors each edge gets
//     │     ├── e1=blue, e2=green, e3=red, e4=blue
//     │     ├── Drawing orders:  e1→e3→e2→e4  /  e2→e1→e4→e3
//     │     └── [Load Coloring →]
//     └── Graph Grid (one mini-SVG preview per coloring)

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Graph, CrossEdge } from '../types/graph';
import type { NCResult, NCProgress, NCWorkerOut, NCSearchPayload, NCEdge } from '../cycleOrderSearch/types';
import type { ConnectionSnapshot } from '../types/solution';
import {
  canonicalKey, buildGroup, mergeIntoGroup, computeTrends, groupByColoring,
  type GroupedResult, type CanonicalColoring, type TrendSummary,
} from '../cycleOrderSearch/grouping';
import {
  validateCycleAndBuildHighlight,
  type CycleHighlight,
} from '../cycleOrderSearch/validateCycle';
import { EDGE_COLORS } from './GraphView';

interface Props {
  gen:         number;
  topGraph:    Graph;
  bottomGraph: Graph;
  onLoadNCycle: (connections: ConnectionSnapshot[], highlight: CycleHighlight) => void;
}

const MAX_ORDERS_PER_RESULT  = 50;
const DEFAULT_TIME_LIMIT_MS  = 30_000;
const MAX_GRID_VISIBLE       = 9;   // paginate after this many mini-cards
const EMPTY_SET: ReadonlySet<string> = new Set();

// ── NCycleSearch ───────────────────────────────────────────────────────────────
export default function NCycleSearch({ gen, topGraph, bottomGraph, onLoadNCycle }: Props) {
  const topFrontier = topGraph.nodes.filter(n => n.isFrontier);
  const botFrontier = bottomGraph.nodes.filter(n => n.isFrontier);
  const maxN     = Math.min(topFrontier.length, botFrontier.length);
  const maxEvenN = maxN % 2 === 0 ? maxN : maxN - 1;

  const [n, setN]           = useState<number>(2);
  const [groups, setGroups] = useState<Map<string, GroupedResult>>(new Map());
  const [running, setRunning]     = useState(false);
  const [progress, setProgress]   = useState<NCProgress | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);

  const workerRef       = useRef<Worker | null>(null);
  const lastProgressRef = useRef<NCProgress | null>(null);

  useEffect(() => {
    setN(prev => Math.min(Math.max(2, prev), maxEvenN < 2 ? 2 : maxEvenN));
  }, [maxEvenN]);

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(false);
    setGroups(new Map());
    setProgress(null);
    lastProgressRef.current = null;
  }, [gen, topGraph.id, bottomGraph.id]);

  const handleRun = useCallback(() => {
    if (maxEvenN < 2) return;
    workerRef.current?.terminate();
    workerRef.current = null;
    setGroups(new Map());
    setRunning(true);
    setWorkerError(null);
    const zero: NCProgress = {
      matchingsChecked: 0, candidateCyclesFound: 0,
      validOrdersFound: 0, stopped: false, done: false,
    };
    setProgress(zero);
    lastProgressRef.current = zero;

    const worker = new Worker(
      new URL('../cycleOrderSearch/cycleOrderWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as NCWorkerOut;
      if (msg.type === 'RESULT') {
        const incoming: NCResult = msg.result;
        const key = canonicalKey(incoming.pairs);
        setGroups(prev => {
          const next = new Map(prev);
          next.set(key, next.has(key)
            ? mergeIntoGroup(next.get(key)!, incoming)
            : buildGroup(incoming));
          return next;
        });
      } else if (msg.type === 'PROGRESS') {
        lastProgressRef.current = msg.progress;
        setProgress(msg.progress);
      } else if (msg.type === 'DONE') {
        setProgress(msg.progress);
        lastProgressRef.current = msg.progress;
        setRunning(false);
        workerRef.current = null;
      } else if (msg.type === 'ERROR') {
        setWorkerError(msg.message);
        setRunning(false);
        workerRef.current = null;
      }
    };

    worker.onerror = (ev: ErrorEvent) => {
      setWorkerError(ev.message || 'Unknown worker error');
      setRunning(false);
      workerRef.current = null;
    };

    const payload: NCSearchPayload = {
      n, topGraph, bottomGraph,
      maxOrdersPerResult: MAX_ORDERS_PER_RESULT,
      timeLimitMs:        DEFAULT_TIME_LIMIT_MS,
    };
    worker.postMessage({ type: 'START', payload });
  }, [n, topGraph, bottomGraph, maxEvenN]);

  const handleStop = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    const last = lastProgressRef.current;
    setProgress(last
      ? { ...last, stopped: true, done: false }
      : { matchingsChecked: 0, candidateCyclesFound: 0, validOrdersFound: 0, stopped: true, done: false });
    setRunning(false);
  }, []);

  const handleClear = useCallback(() => { setGroups(new Map()); setProgress(null); }, []);

  const statusLabel = (() => {
    if (!progress) return null;
    if (!progress.done && !progress.stopped && !progress.timedOut) return null;
    if (progress.timedOut) return '⏱ Time limit reached — results may be incomplete';
    if (progress.stopped)  return '⏹ Stopped — results may be incomplete';
    return '✓ Search complete';
  })();

  const groupList = Array.from(groups.values());
  const canRun    = maxEvenN >= 2 && !running;

  return (
    <div className="search-mode nc-search">
      <p className="search-mode-label">
        <strong>N-Cycle Order Search</strong>
        {' — '}Choose <em>n</em> connection edges that form one single cycle,
        then find every valid coloring and drawing order.
        {' '}({topFrontier.length} top · {botFrontier.length} bottom frontier)
      </p>

      {maxEvenN < 2 && (
        <p className="search-frontier-warning">
          Need at least 2 frontier nodes per side ({topFrontier.length} top, {botFrontier.length} bottom).
        </p>
      )}

      {maxEvenN >= 2 && (
        <div className="nc-n-control">
          <div className="nc-n-label">
            <span className="nc-n-value">n = {n}</span>
            <span className="nc-n-desc">connection edges in the target cycle (even only)</span>
          </div>
          <div className="nc-n-slider-row">
            <span className="nc-n-tick">2</span>
            <input id="nc-n-slider" type="range"
              min={2} max={maxEvenN} step={2} value={n}
              disabled={running}
              onChange={e => setN(Number(e.target.value))}
              className="nc-n-slider"
            />
            <span className="nc-n-tick">{maxEvenN}</span>
          </div>
        </div>
      )}

      <div className="search-toolbar">
        {!running
          ? <button className="search-run-btn" onClick={handleRun} disabled={!canRun}>Run Search</button>
          : <button className="search-stop-btn" onClick={handleStop}>Stop</button>
        }
        <button className="search-clear-btn" onClick={handleClear}
          disabled={running || groups.size === 0}>Clear</button>
      </div>

      {workerError && <p className="search-frontier-error">Worker error: {workerError}</p>}

      {progress && (
        <div className="search-progress">
          {statusLabel && <span className="search-progress-status">{statusLabel}</span>}
          <span className="search-progress-stat">{progress.matchingsChecked.toLocaleString()} matchings checked</span>
          <span className="search-progress-stat">{progress.candidateCyclesFound.toLocaleString()} candidate cycles</span>
          <span className="search-progress-stat search-progress-found">
            <strong>{groupList.length}</strong> edge-set group{groupList.length !== 1 ? 's' : ''}
            {' · '}<strong>{progress.validOrdersFound.toLocaleString()}</strong> valid combinations
          </span>
        </div>
      )}

      {!running && progress === null && groups.size === 0 && maxEvenN >= 2 && (
        <p className="search-empty">Press <em>Run Search</em> to find all valid n-cycle edge sets, colorings, and drawing orders.</p>
      )}
      {!running && progress !== null && groups.size === 0 && (
        <p className="search-empty">No results found for n={n}.</p>
      )}

      {groupList.length > 0 && (
        <div className="nc-results">
          <p className="nc-results-count">{groupList.length} edge-set group{groupList.length !== 1 ? 's' : ''}</p>
          {groupList.map((g, idx) => (
            <NCGroupCard key={g.key} group={g} index={idx + 1}
              topGraph={topGraph} bottomGraph={bottomGraph}
              onLoadNCycle={onLoadNCycle} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── NCGroupCard ────────────────────────────────────────────────────────────────

function NCGroupCard({ group, index, topGraph, bottomGraph, onLoadNCycle }: {
  group: GroupedResult;
  index: number;
  topGraph: Graph;
  bottomGraph: Graph;
  onLoadNCycle: (c: ConnectionSnapshot[], h: CycleHighlight) => void;
}) {
  const [expanded,  setExpanded]  = useState(false);
  const [showGrid,  setShowGrid]  = useState(false);

  const trends: TrendSummary = computeTrends(group);
  const colorings: CanonicalColoring[] = useMemo(() => groupByColoring(group), [group]);

  // Pre-compute the cycle highlight once (color-independent).
  const highlight = useMemo<CycleHighlight | null>(() => {
    const r = validateCycleAndBuildHighlight(group.cycleNodeIds, group.pairs, topGraph, bottomGraph);
    return r.valid ? r.highlight : null;
  }, [group.key, topGraph.id, bottomGraph.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = group.pairs.length;
  const frontierIds = new Set(group.pairs.flatMap(p => [p.topNodeId, p.bottomNodeId]));
  const internalCount = group.cycleNodeIds.filter(id => !frontierIds.has(id)).length;

  return (
    <div className="nc-group-card">

      {/* ── Always-visible header ─────────────────────────────────────── */}
      <div className="nc-group-header">
        <span className="nc-group-num">#{index}</span>
        <span className="nc-group-meta">
          <span className="nc-group-badge">{n} edges</span>
          <span className="nc-group-badge nc-group-badge--pattern">
            {trends.distinctPatternCount} draw pattern{trends.distinctPatternCount !== 1 ? 's' : ''}
          </span>
          <span className="nc-group-badge nc-group-badge--combo">
            {colorings.length} coloring{colorings.length !== 1 ? 's' : ''}
          </span>
          <span className="nc-group-badge">
            {group.totalCombinations} combination{group.totalCombinations !== 1 ? 's' : ''}
            {group.totalCombinations >= MAX_ORDERS_PER_RESULT ? ' (capped)' : ''}
          </span>
        </span>
        <button className="nc-toggle-btn" onClick={() => setExpanded(v => !v)}>
          {expanded ? '▲ Collapse' : '▼ Expand'}
        </button>
      </div>

      {/* ── A. Edge set (structure, no colors) ────────────────────────── */}
      <div className="nc-section-group">
        <span className="nc-section-label">A. Edge Set</span>
        <div className="nc-edge-set-row">
          {group.pairs.map((p, i) => (
            <span key={i} className="nc-edge-chip">
              <span className="nc-chip-label">{group.edgeLabels[i]}</span>
              <span className="nc-chip-top">{shortId(p.topNodeId)}</span>
              <span className="nc-chip-arrow">↔</span>
              <span className="nc-chip-bot">{shortId(p.bottomNodeId)}</span>
            </span>
          ))}
          <span className="nc-cycle-len">
            {group.cycleNodeIds.length}-node cycle
            ({n * 2} frontier{internalCount > 0 ? ` + ${internalCount} internal` : ''})
          </span>
        </div>
      </div>

      {/* ── Expanded content ────────────────────────────────────────────── */}
      {expanded && (
        <div className="nc-expanded">

          {/* Edge legend */}
          <div>
            <span className="nc-section-label">Edge legend</span>
            <div className="nc-legend-grid">
              {group.pairs.map((p, i) => (
                <div key={i} className="nc-legend-row">
                  <span className="nc-legend-label">{group.edgeLabels[i]}</span>
                  <span className="nc-legend-eq">=</span>
                  <span className="nc-legend-top">{shortId(p.topNodeId)}</span>
                  <span className="nc-legend-arrow">↔</span>
                  <span className="nc-legend-bot">{shortId(p.bottomNodeId)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Cycle sequence */}
          <CycleSequenceRow cycleNodeIds={group.cycleNodeIds} pairs={group.pairs} />

          {/* Trend summary */}
          <TrendBox trends={trends} labels={group.edgeLabels} />

          {/* Show Graphs toggle */}
          <div className="nc-grid-toggle-row">
            <button
              className={`nc-grid-toggle-btn${showGrid ? ' nc-grid-toggle-btn--active' : ''}`}
              onClick={() => setShowGrid(v => !v)}
            >
              {showGrid ? 'Hide Graph Grid' : 'Show Graph Grid'}
            </button>
            {showGrid && (
              <span className="nc-grid-toggle-hint">
                {colorings.length} graph{colorings.length !== 1 ? 's' : ''} — one per coloring
              </span>
            )}
          </div>

          {/* B. Graph grid */}
          {showGrid && (
            <GraphGrid
              group={group}
              colorings={colorings}
              highlight={highlight}
              topGraph={topGraph}
              bottomGraph={bottomGraph}
              onLoadNCycle={onLoadNCycle}
            />
          )}

          {/* C. Colorings list */}
          <div>
            <span className="nc-section-label">
              B. Colorings &amp; C. Drawing Orders
            </span>
            <div className="nc-colorings-section">
              {colorings.map((coloring, ci) => (
                <ColoringCard
                  key={coloring.key}
                  coloring={coloring}
                  group={group}
                  highlight={highlight}
                  onLoadNCycle={onLoadNCycle}
                  initiallyExpanded={colorings.length === 1}
                />
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

// ── GraphGrid ──────────────────────────────────────────────────────────────────

function GraphGrid({ group, colorings, highlight, topGraph, bottomGraph, onLoadNCycle }: {
  group: GroupedResult;
  colorings: CanonicalColoring[];
  highlight: CycleHighlight | null;
  topGraph: Graph;
  bottomGraph: Graph;
  onLoadNCycle: (c: ConnectionSnapshot[], h: CycleHighlight) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? colorings : colorings.slice(0, MAX_GRID_VISIBLE);

  function loadColoring(coloring: CanonicalColoring) {
    if (!highlight) return;
    onLoadNCycle(
      coloring.sampleOrder.map(e => ({ from: e.topNodeId, to: e.bottomNodeId, color: e.color })),
      highlight,
    );
  }

  // Compute viewBox once for all mini-SVGs.
  const viewBox = useMemo(() => computeViewBox(topGraph, bottomGraph), [topGraph.id, bottomGraph.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const topPos  = useMemo(() => Object.fromEntries(topGraph.nodes.map(n => [n.id, { x: n.x, y: n.y }])), [topGraph]);
  const botPos  = useMemo(() => Object.fromEntries(bottomGraph.nodes.map(n => [n.id, { x: n.x, y: n.y }])), [bottomGraph]);

  return (
    <div className="nc-graph-grid-section">
      <div className="nc-mini-grid">
        {visible.map(coloring => {
          const crossEdges: CrossEdge[] = group.pairs.map((p, i) => ({
            id: `mg-${coloring.key}-${i}`,
            topNodeId:    p.topNodeId,
            bottomNodeId: p.bottomNodeId,
            color:        coloring.colors[i],
          }));
          return (
            <MiniGraphPreview
              key={coloring.key}
              label={coloring.label}
              colors={coloring.colors}
              edgeLabels={group.edgeLabels}
              orderCount={coloring.totalOrderCount}
              viewBox={viewBox}
              topGraph={topGraph}
              bottomGraph={bottomGraph}
              topPos={topPos}
              botPos={botPos}
              crossEdges={crossEdges}
              highlight={highlight}
              onClick={() => loadColoring(coloring)}
            />
          );
        })}
      </div>
      {colorings.length > MAX_GRID_VISIBLE && (
        <button className="nc-grid-show-more" onClick={() => setShowAll(v => !v)}>
          {showAll
            ? 'Show fewer'
            : `Show all ${colorings.length} colorings`
          }
        </button>
      )}
    </div>
  );
}

// ── MiniGraphPreview ───────────────────────────────────────────────────────────

function MiniGraphPreview({
  label, colors, edgeLabels, orderCount, viewBox,
  topGraph, bottomGraph, topPos, botPos, crossEdges, highlight, onClick,
}: {
  label:       string;
  colors:      readonly string[];
  edgeLabels:  string[];
  orderCount:  number;
  viewBox:     string;
  topGraph:    Graph;
  bottomGraph: Graph;
  topPos:      Record<string, { x: number; y: number }>;
  botPos:      Record<string, { x: number; y: number }>;
  crossEdges:  CrossEdge[];
  highlight:   CycleHighlight | null;
  onClick:     () => void;
}) {
  const cycleNodeIds  = highlight?.nodeIds    ?? EMPTY_SET;
  const cycleEdgeKeys = highlight?.treeEdgeKeys ?? EMPTY_SET;

  return (
    <div className="nc-mini-card" onClick={onClick} role="button" title={`Load ${label} into graph`}>
      <div className="nc-mini-header">
        <span className="nc-mini-label">{label}</span>
        <span className="nc-mini-order-count">{orderCount} order{orderCount !== 1 ? 's' : ''}</span>
      </div>

      {/* Color assignment dots */}
      <div className="nc-mini-colors">
        {colors.map((c, i) => (
          <span key={i} className="nc-mini-color-item" title={`${edgeLabels[i]}: ${c}`}>
            <span className="nc-mini-edge-label">{edgeLabels[i]}</span>
            <span className="nc-mini-dot" style={{ background: EDGE_COLORS[c as keyof typeof EDGE_COLORS] }} />
          </span>
        ))}
      </div>

      {/* Mini SVG graph preview */}
      <svg className="nc-mini-svg" viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
        {/* Cycle tree-edge glow */}
        <MiniTreeGraph graph={topGraph}    cycleNodeIds={cycleNodeIds} cycleEdgeKeys={cycleEdgeKeys} />
        <MiniTreeGraph graph={bottomGraph} cycleNodeIds={cycleNodeIds} cycleEdgeKeys={cycleEdgeKeys} />
        {/* Cross-edges */}
        <MiniCrossEdges edges={crossEdges} topPos={topPos} botPos={botPos} cycleNodeIds={cycleNodeIds} />
      </svg>

      <div className="nc-mini-load-hint">Click to load →</div>
    </div>
  );
}

// ── MiniTreeGraph ──────────────────────────────────────────────────────────────

function MiniTreeGraph({ graph, cycleNodeIds, cycleEdgeKeys }: {
  graph:        Graph;
  cycleNodeIds: ReadonlySet<string>;
  cycleEdgeKeys: ReadonlySet<string>;
}) {
  const nodeById = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
  return (
    <g>
      {graph.edges.map(edge => {
        const src = nodeById[edge.sourceId];
        const tgt = nodeById[edge.targetId];
        if (!src || !tgt) return null;
        const ek = src.id < tgt.id ? `${src.id}|${tgt.id}` : `${tgt.id}|${src.id}`;
        const isCycle = cycleEdgeKeys.has(ek);
        return (
          <g key={edge.id}>
            {isCycle && <line x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
              stroke="#00c8d8" strokeWidth={10} opacity={0.28} strokeLinecap="round" />}
            <line x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
              stroke={EDGE_COLORS[edge.color]} strokeWidth={2.5} strokeLinecap="round" />
          </g>
        );
      })}
      {graph.nodes.map(node => {
        const isCycle = cycleNodeIds.has(node.id);
        return (
          <g key={node.id}>
            {isCycle && <circle cx={node.x} cy={node.y} r={12}
              fill="none" stroke="#00c8d8" strokeWidth={2} opacity={0.65} />}
            <circle cx={node.x} cy={node.y} r={6}
              fill={node.isFrontier ? '#e8e8ff' : '#1e1e2e'}
              stroke={node.isFrontier ? '#f5a623' : '#6666aa'}
              strokeWidth={1.5}
              strokeDasharray={node.isFrontier ? '3 1.5' : undefined}
            />
          </g>
        );
      })}
    </g>
  );
}

// ── MiniCrossEdges ─────────────────────────────────────────────────────────────

function MiniCrossEdges({ edges, topPos, botPos, cycleNodeIds }: {
  edges:        CrossEdge[];
  topPos:       Record<string, { x: number; y: number }>;
  botPos:       Record<string, { x: number; y: number }>;
  cycleNodeIds: ReadonlySet<string>;
}) {
  return (
    <g>
      {edges.map(edge => {
        const a = topPos[edge.topNodeId]    ?? botPos[edge.topNodeId];
        const b = topPos[edge.bottomNodeId] ?? botPos[edge.bottomNodeId];
        if (!a || !b) return null;
        const isCycle = cycleNodeIds.has(edge.topNodeId) && cycleNodeIds.has(edge.bottomNodeId);
        return (
          <g key={edge.id}>
            {isCycle && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke="#00c8d8" strokeWidth={9} opacity={0.28} strokeLinecap="round" />}
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={EDGE_COLORS[edge.color]} strokeWidth={2}
              strokeDasharray="5 2" strokeLinecap="round" opacity={0.9} />
          </g>
        );
      })}
    </g>
  );
}

// ── ColoringCard ───────────────────────────────────────────────────────────────

function ColoringCard({ coloring, group, highlight, onLoadNCycle, initiallyExpanded }: {
  coloring:        CanonicalColoring;
  group:           GroupedResult;
  highlight:       CycleHighlight | null;
  onLoadNCycle:    (c: ConnectionSnapshot[], h: CycleHighlight) => void;
  initiallyExpanded: boolean;
}) {
  const [showOrders, setShowOrders] = useState(initiallyExpanded);
  const [loadError,  setLoadError]  = useState<string | null>(null);

  function handleLoad() {
    if (!highlight) { setLoadError('Cycle highlight not available.'); return; }
    setLoadError(null);
    onLoadNCycle(
      coloring.sampleOrder.map(e => ({ from: e.topNodeId, to: e.bottomNodeId, color: e.color })),
      highlight,
    );
  }

  return (
    <div className="nc-coloring-card">
      {/* Header row: label + colors + order count + toggle + load */}
      <div className="nc-coloring-card-header">
        <span className="nc-coloring-card-label">{coloring.label}</span>

        {/* B. Color assignment */}
        <div className="nc-col-assignment">
          {coloring.colors.map((c, i) => (
            <span key={i} className="nc-col-item">
              <span className="nc-col-elabel">{group.edgeLabels[i]}</span>
              <span className="nc-col-dot" style={{ background: EDGE_COLORS[c] }} title={c} />
              <span className="nc-col-cname">{c}</span>
            </span>
          ))}
        </div>

        <span className="nc-coloring-card-count">
          {coloring.totalOrderCount} order{coloring.totalOrderCount !== 1 ? 's' : ''}
        </span>

        <button className="nc-coloring-toggle" onClick={() => setShowOrders(v => !v)}>
          {showOrders ? '▲' : '▼'}
        </button>

        <button className="nc-load-btn" onClick={handleLoad} disabled={!highlight}>
          Load →
        </button>
        {loadError && <span className="nc-load-error">⚠ {loadError}</span>}
      </div>

      {/* C. Drawing orders */}
      {showOrders && (
        <div className="nc-col-orders">
          <span className="nc-col-orders-label">
            Drawing orders ({coloring.drawPatterns.length} distinct):
          </span>
          <ul className="nc-col-order-list">
            {coloring.drawPatterns.map((pat, i) => (
              <li key={i} className="nc-col-order-item">
                <span className="nc-col-pat-num">{i + 1}.</span>
                <span className="nc-col-pat-seq">{pat}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── CycleSequenceRow ──────────────────────────────────────────────────────────

function CycleSequenceRow({ cycleNodeIds, pairs }: {
  cycleNodeIds: string[];
  pairs:        Array<{ topNodeId: string; bottomNodeId: string }>;
}) {
  const [showFull, setShowFull] = useState(false);
  const frontierSet = new Set(pairs.flatMap(p => [p.topNodeId, p.bottomNodeId]));
  const MAX = 12;
  const full    = cycleNodeIds.map(id => shortId(id));
  const display = !showFull && full.length > MAX
    ? [...full.slice(0, MAX), `…+${full.length - MAX}`]
    : full;

  return (
    <div className="nc-cycle-sequence">
      <span className="nc-section-label">Cycle node sequence</span>
      <div className="nc-cycle-seq-nodes">
        {display.map((label, i) => {
          const origId    = cycleNodeIds[i];
          const isFrontier = origId ? frontierSet.has(origId) : false;
          return (
            <span key={i} className={`nc-seq-node${isFrontier ? ' nc-seq-node--frontier' : ''}`}>
              {label}
              {i < display.length - 1 && <span className="nc-seq-arrow">→</span>}
            </span>
          );
        })}
        <span className="nc-seq-node nc-seq-close">↩</span>
      </div>
      {full.length > MAX && (
        <button className="nc-seq-toggle" onClick={() => setShowFull(v => !v)}>
          {showFull ? 'Show less' : `Show all ${full.length} nodes`}
        </button>
      )}
    </div>
  );
}

// ── TrendBox ──────────────────────────────────────────────────────────────────

function TrendBox({ trends, labels }: { trends: TrendSummary; labels: string[] }) {
  return (
    <div className="nc-trend-box">
      <span className="nc-section-label">Trends</span>
      <div className="nc-trend-rows">
        <div className="nc-trend-row">
          <span className="nc-trend-key">Distinct draw patterns</span>
          <span className="nc-trend-val">{trends.distinctPatternCount}</span>
        </div>
        {trends.mostCommonFirstEdges.length > 0 && (
          <div className="nc-trend-row">
            <span className="nc-trend-key">Most common first</span>
            <span className="nc-trend-val nc-trend-edge">
              {trends.mostCommonFirstEdges.map(i => labels[i]).join(', ')}
            </span>
          </div>
        )}
        {trends.mostCommonLastEdges.length > 0 && (
          <div className="nc-trend-row">
            <span className="nc-trend-key">Most common last</span>
            <span className="nc-trend-val nc-trend-edge">
              {trends.mostCommonLastEdges.map(i => labels[i]).join(', ')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function shortId(nodeId: string): string {
  return nodeId.replace(/^[^-]+-/, '');
}

function computeViewBox(topGraph: Graph, bottomGraph: Graph): string {
  const nodes = [...topGraph.nodes, ...bottomGraph.nodes];
  const PAD  = 22;
  const minX = Math.min(...nodes.map(n => n.x)) - PAD;
  const maxX = Math.max(...nodes.map(n => n.x)) + PAD;
  const minY = Math.min(...nodes.map(n => n.y)) - PAD;
  const maxY = Math.max(...nodes.map(n => n.y)) + PAD;
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
}
