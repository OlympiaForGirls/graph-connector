// SearchMode.tsx — auto-search UI for bipartite perfect matchings.
//
// SOLUTION INTEGRITY GUARANTEE:
//   The visible solution list contains ONLY complete bipartite perfect matchings
//   that passed all validation rules (A, B, C). Nothing else is stored, rendered,
//   or exported — not partial matchings, not stale localStorage entries from
//   previous solver versions, not timed-out intermediate states.
//
// STOP IMPLEMENTATION NOTE:
//   Stopping is done via worker.terminate() (not postMessage).
//   A Web Worker running a synchronous DFS cannot process messages while its
//   event loop is occupied, so posting { type: 'STOP' } has no effect.
//   terminate() kills the worker process immediately from the main thread.
//
// CONCURRENCY:
//   SearchMode stays mounted even when the Manual tab is active (App.tsx renders
//   both panels and toggles visibility).  This means the worker keeps running
//   while the user works in Manual Mode and results appear when they return.

import { useState, useEffect, useRef } from 'react';
import type { Graph } from '../types/graph';
import type { ConnectionSnapshot, SolutionSnapshot } from '../types/solution';
import { MAX_SEARCH_GEN, type SearchMode, type SearchProgress } from '../solver/matchingSearch';
import type { SearchResult } from '../solver/matchingSearch';
import {
  loadSolutions,
  appendSolutions,
  clearSolutionsForGen,
} from '../storage/solutions';
import { EDGE_COLORS } from './GraphView';

interface Props {
  gen: number;
  topGraph: Graph;
  bottomGraph: Graph;
  onLoadSolution: (connections: ConnectionSnapshot[]) => void;
}

// ── Strict completeness filter ────────────────────────────────────────────────
function isCompleteSolution(sol: SolutionSnapshot, expectedPairs: number): boolean {
  if (sol.connections.length !== expectedPairs) return false;
  const fromIds = new Set(sol.connections.map(c => c.from));
  const toIds   = new Set(sol.connections.map(c => c.to));
  if (fromIds.size !== expectedPairs) return false;
  if (toIds.size   !== expectedPairs) return false;
  return sol.connections.every(
    c => c.from.startsWith('top-') && c.to.startsWith('bot-'),
  );
}

const MODE_LABELS: Record<SearchMode, string> = {
  first1:  'Find 1',
  first10: 'Find 10',
  all:     'Find all',
};

// ── Component ────────────────────────────────────────────────────────────────
export default function SearchMode({ gen, topGraph, bottomGraph, onLoadSolution }: Props) {
  const [solutions, setSolutions]   = useState<SolutionSnapshot[]>([]);
  const [running, setRunning]       = useState(false);
  const [progress, setProgress]     = useState<SearchProgress | null>(null);
  const [searchMode, setSearchMode] = useState<SearchMode>('all');
  const workerRef = useRef<Worker | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const topFrontierCount = topGraph.nodes.filter(n => n.isFrontier).length;
  const botFrontierCount = bottomGraph.nodes.filter(n => n.isFrontier).length;
  const countsEqual      = topFrontierCount === botFrontierCount;
  const canSearch        = countsEqual;
  const expectedPairs    = topFrontierCount;

  const loadFiltered = (): SolutionSnapshot[] =>
    loadSolutions()
      .filter(s => s.generation === gen)
      .filter(s => isCompleteSolution(s, expectedPairs));

  // Cleanup on unmount.
  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  // On gen change: kill running search, reload stored solutions for the new gen.
  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(false);
    setSolutions(loadFiltered());
    setProgress(null);
  }, [gen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRun = () => {
    if (!canSearch) return;

    // Terminate any previous worker without touching running state yet.
    workerRef.current?.terminate();
    workerRef.current = null;

    setSolutions([]);
    setRunning(true);
    setProgress(null);

    clearSolutionsForGen(gen);

    const worker = new Worker(
      new URL('../solver/matchingWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    // Capture per-run values for use inside the closure.
    const runExpectedPairs = expectedPairs;

    worker.onmessage = (e: MessageEvent) => {
      const { type } = e.data as { type: string };

      if (type === 'SOLUTION') {
        // Stream valid solutions into state as they arrive.
        const sol = (e.data as { type: string; solution: SolutionSnapshot }).solution;
        if (isCompleteSolution(sol, runExpectedPairs)) {
          setSolutions(prev => [...prev, sol]);
        }
      } else if (type === 'PROGRESS') {
        setProgress((e.data as { type: string; progress: SearchProgress }).progress);
      } else if (type === 'DONE') {
        const { solutions: finalSols, progress: finalProgress } =
          (e.data as { type: string; result: SearchResult }).result;
        // Persist all valid solutions found during this run.
        appendSolutions(finalSols);
        // Re-load from storage as the authoritative final list.
        setSolutions(loadFiltered());
        setProgress(finalProgress);
        setRunning(false);
        workerRef.current = null;
      }
    };

    worker.onerror = () => {
      setRunning(false);
      workerRef.current = null;
    };

    worker.postMessage({
      type: 'START',
      payload: { gen, topGraph, bottomGraph, mode: searchMode },
    });
  };

  // Stop: terminate() kills the worker immediately regardless of what it's doing.
  const handleStop = () => {
    if (!workerRef.current) return;
    workerRef.current.terminate();
    workerRef.current = null;
    // Persist whatever valid solutions have streamed in so far.
    setSolutions(prev => {
      appendSolutions(prev);
      return prev;
    });
    setProgress(prev =>
      prev
        ? { ...prev, stopped: true, done: false, exhausted: false }
        : { partialStatesExplored: 0, completeMatchingsEvaluated: 0,
            validSolutionsFound: 0, stopped: true, timedOut: false,
            done: false, exhausted: false },
    );
    setRunning(false);
  };

  const handleClear = () => {
    clearSolutionsForGen(gen);
    setSolutions([]);
    setProgress(null);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(solutions, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `solutions-gen${gen}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw      = JSON.parse(ev.target?.result as string) as SolutionSnapshot[];
        const filtered = raw.filter(s => isCompleteSolution(s, expectedPairs));
        appendSolutions(filtered);
        setSolutions(loadFiltered());
      } catch {
        alert('Import failed: invalid JSON.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const statusLabel = (() => {
    if (!progress || progress.unequalCounts) return null;
    if (!progress.done && !progress.stopped && !progress.timedOut) return null;
    if (progress.timedOut) return '⏱ Timed out — results are incomplete';
    if (progress.stopped)  return '⏹ Stopped — results are incomplete';
    if (progress.exhausted) return '✓ All possibilities searched';
    return '✓ Done — solution limit reached (more may exist)';
  })();

  return (
    <div className="search-mode">

      <p className="search-mode-label">
        <strong>Bipartite Perfect Matching</strong>
        {' — '}Each top frontier node must be paired with exactly one bottom frontier node.
        {' '}({topFrontierCount} top · {botFrontierCount} bottom)
      </p>

      {/* High-generation warning (non-blocking) */}
      {gen > MAX_SEARCH_GEN && (
        <p className="search-frontier-warning">
          Warning: gen {gen} has {topFrontierCount} frontier nodes per side —
          search may take a very long time. Use <em>Find 1</em> or <em>Find 10</em> to
          get results faster, or press <em>Stop</em> at any time.
        </p>
      )}

      {/* Unequal-count error (blocks search) */}
      {!countsEqual && (
        <p className="search-frontier-error">
          Cannot run search: unequal frontier counts
          ({topFrontierCount} top vs {botFrontierCount} bottom).
        </p>
      )}

      {/* Search mode selector */}
      <div className="search-mode-selector">
        <span className="search-mode-selector-label">Mode:</span>
        {(['first1', 'first10', 'all'] as SearchMode[]).map(m => (
          <button
            key={m}
            className={`search-mode-btn${searchMode === m ? ' search-mode-btn--active' : ''}`}
            onClick={() => setSearchMode(m)}
            disabled={running}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="search-toolbar">
        {!running ? (
          <button
            className="search-run-btn"
            onClick={handleRun}
            disabled={!canSearch}
          >
            Run Search
          </button>
        ) : (
          <button className="search-stop-btn" onClick={handleStop}>
            Stop
          </button>
        )}
        <button
          className="search-clear-btn"
          onClick={handleClear}
          disabled={running || solutions.length === 0}
        >
          Clear
        </button>
        <button
          className="search-export-btn"
          onClick={handleExport}
          disabled={solutions.length === 0}
        >
          Export JSON
        </button>
        <button
          className="search-import-btn"
          onClick={() => importRef.current?.click()}
          disabled={running}
        >
          Import JSON
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleImport}
        />
      </div>

      {/* Progress — live during run and after completion */}
      {progress && !progress.unequalCounts && (
        <div className="search-progress">
          {statusLabel && (
            <span className="search-progress-status">{statusLabel}</span>
          )}
          <span className="search-progress-stat">
            {progress.partialStatesExplored.toLocaleString()} partial states explored
          </span>
          <span className="search-progress-stat">
            {progress.completeMatchingsEvaluated.toLocaleString()} complete matchings evaluated
          </span>
          <span className="search-progress-stat search-progress-found">
            <strong>{progress.validSolutionsFound}</strong>{' '}
            valid solution{progress.validSolutionsFound !== 1 ? 's' : ''} found
          </span>
        </div>
      )}

      {/* Empty states */}
      {!running && canSearch && progress === null && solutions.length === 0 && (
        <p className="search-empty">
          No solutions stored for gen {gen}.{' '}
          Press <em>Run Search</em> to find them.
        </p>
      )}
      {!running && canSearch && progress !== null && solutions.length === 0 && (
        <p className="search-empty">No valid complete solutions found.</p>
      )}

      {/* Solution grid — only valid complete matchings */}
      {solutions.length > 0 && (
        <div className="solution-grid">
          {solutions.map(sol => (
            <SolutionCard
              key={sol.id}
              solution={sol}
              onLoad={() => onLoadSolution(sol.connections)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── SolutionCard ───────────────────────────────────────────────────────────────

function SolutionCard({
  solution,
  onLoad,
}: {
  solution: SolutionSnapshot;
  onLoad: () => void;
}) {
  const d  = new Date(solution.timestamp);
  const ts = `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;

  return (
    <div className="solution-card">
      <div className="solution-card-header">
        <span className="solution-card-edges">
          {solution.connections.length} pair{solution.connections.length !== 1 ? 's' : ''}
        </span>
        <span className="solution-card-ts">{ts}</span>
        <button className="solution-load-btn" onClick={onLoad}>Load →</button>
      </div>
      <ul className="solution-edge-list">
        {solution.connections.map((c, i) => (
          <li key={i} className="solution-edge-item">
            <span
              className="solution-edge-dot"
              style={{ background: EDGE_COLORS[c.color] }}
            />
            <span className="solution-edge-label">
              {c.from.replace(/^[^-]+-/, '')} → {c.to.replace(/^[^-]+-/, '')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
