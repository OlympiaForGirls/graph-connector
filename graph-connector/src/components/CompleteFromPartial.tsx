// CompleteFromPartial.tsx — run the full CP solver on the remaining frontier nodes,
// with the partial pattern's edges fixed (locked).

import { useState, useEffect, useRef } from 'react';
import type { Graph } from '../types/graph';
import type { PartialPattern } from '../types/partial';
import type { ConnectionSnapshot, SolutionSnapshot } from '../types/solution';
import type { SearchMode, SearchProgress, SearchResult } from '../solver/matchingSearch';
import type { DebugInfo } from '../solver/completeWorker';
import { MAX_SEARCH_GEN } from '../solver/matchingSearch';
import { loadSolutions, appendSolutions } from '../storage/solutions';
import { EDGE_COLORS } from './GraphView';

interface Props {
  gen: number;
  topGraph: Graph;
  bottomGraph: Graph;
  pattern: PartialPattern | null;
  onLoadSolution: (connections: ConnectionSnapshot[]) => void;
}

const MODE_LABELS: Record<SearchMode, string> = {
  first1:  'Find 1',
  first10: 'Find 10',
  all:     'Find all',
};

function isCompleteSolution(sol: SolutionSnapshot, expectedPairs: number): boolean {
  if (sol.connections.length !== expectedPairs) return false;
  const fromIds = new Set(sol.connections.map(c => c.from));
  const toIds   = new Set(sol.connections.map(c => c.to));
  if (fromIds.size !== expectedPairs) return false;
  if (toIds.size   !== expectedPairs) return false;
  return sol.connections.every(c => c.from.startsWith('top-') && c.to.startsWith('bot-'));
}

export default function CompleteFromPartial({
  gen, topGraph, bottomGraph, pattern, onLoadSolution,
}: Props) {
  const [solutions, setSolutions]   = useState<SolutionSnapshot[]>([]);
  const [running, setRunning]       = useState(false);
  const [progress, setProgress]     = useState<SearchProgress | null>(null);
  const [searchMode, setSearchMode] = useState<SearchMode>('all');
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo]   = useState<DebugInfo | null>(null);
  const workerRef       = useRef<Worker | null>(null);
  const lastProgressRef = useRef<SearchProgress | null>(null);

  const topFrontierCount = topGraph.nodes.filter(n => n.isFrontier).length;
  const expectedPairs    = topFrontierCount;

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  // Reset when pattern or gen changes.
  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    lastProgressRef.current = null;
    setRunning(false);
    setSolutions([]);
    setProgress(null);
    setDebugInfo(null);
  }, [gen, pattern]);

  const handleRun = () => {
    if (!pattern) return;
    workerRef.current?.terminate();
    workerRef.current = null;

    setSolutions([]);
    setRunning(true);
    setWorkerError(null);
    setDebugInfo(null);
    setProgress({
      partialStatesExplored: 0, completeMatchingsEvaluated: 0, validSolutionsFound: 0,
      stopped: false, timedOut: false, done: false, exhausted: false,
    });
    lastProgressRef.current = null;

    const worker = new Worker(
      new URL('../solver/completeWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    const runExpectedPairs = expectedPairs;

    worker.onmessage = (e: MessageEvent) => {
      const { type } = e.data as { type: string };

      if (type === 'DEBUG_INFO') {
        setDebugInfo((e.data as { type: string; info: DebugInfo }).info);
      } else if (type === 'SOLUTION') {
        const sol = (e.data as { type: string; solution: SolutionSnapshot }).solution;
        if (isCompleteSolution(sol, runExpectedPairs)) {
          setSolutions(prev => [...prev, sol]);
        }
      } else if (type === 'PROGRESS') {
        const p = (e.data as { type: string; progress: SearchProgress }).progress;
        lastProgressRef.current = p;
        setProgress(p);
      } else if (type === 'DONE') {
        const { solutions: finalSols, progress: finalProg } =
          (e.data as { type: string; result: SearchResult }).result;
        appendSolutions(finalSols.filter(s => isCompleteSolution(s, runExpectedPairs)));
        setSolutions(
          loadSolutions()
            .filter(s => s.generation === gen && isCompleteSolution(s, runExpectedPairs)),
        );
        setProgress(finalProg);
        setRunning(false);
        workerRef.current = null;
      } else if (type === 'ERROR') {
        const msg = (e.data as { type: string; message: string }).message;
        setWorkerError(msg);
        setRunning(false);
        workerRef.current = null;
      }
    };

    worker.onerror = (ev: ErrorEvent) => {
      setWorkerError(ev.message || 'Unknown worker error');
      setRunning(false);
      workerRef.current = null;
    };

    worker.postMessage({
      type: 'START',
      payload: { gen, topGraph, bottomGraph, pattern, mode: searchMode },
    });
  };

  const handleStop = () => {
    if (!workerRef.current) return;
    workerRef.current.terminate();
    workerRef.current = null;
    setSolutions(prev => { appendSolutions(prev); return prev; });
    const last = lastProgressRef.current;
    setProgress(
      last
        ? { ...last, stopped: true, done: false, exhausted: false }
        : { partialStatesExplored: 0, completeMatchingsEvaluated: 0,
            validSolutionsFound: 0, stopped: true, timedOut: false,
            done: false, exhausted: false },
    );
    setRunning(false);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(solutions, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `completions-gen${gen}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statusLabel = (() => {
    if (!progress) return null;
    if (!progress.done && !progress.stopped && !progress.timedOut) return null;
    if (progress.timedOut) return '⏱ Timed out — results are incomplete';
    if (progress.stopped)  return '⏹ Stopped — results are incomplete';
    if (progress.exhausted) return '✓ All completions found';
    return '✓ Done — solution limit reached';
  })();

  const remainingCount = pattern?.remainingTopNodes.length ?? 0;

  return (
    <div className="complete-panel">
      {!pattern ? (
        <p className="search-empty complete-no-pattern">
          No partial pattern selected.{' '}
          Go to <em>Partial Search</em>, find patterns, and click <em>Complete →</em>.
        </p>
      ) : (
        <>
          {/* Fixed edges summary */}
          <div className="complete-fixed-summary">
            <span className="complete-fixed-label">Fixed edges ({pattern.connections.length}):</span>
            <ul className="complete-fixed-list">
              {pattern.connections.map((c, i) => (
                <li key={i} className="solution-edge-item">
                  <span
                    className="solution-edge-dot complete-fixed-dot"
                    style={{ background: EDGE_COLORS[c.color] }}
                  />
                  <span className="solution-edge-label">
                    {c.from.replace(/^[^-]+-/, '')} → {c.to.replace(/^[^-]+-/, '')}
                  </span>
                  <span className="complete-locked-badge">locked</span>
                </li>
              ))}
            </ul>
            <p className="complete-remaining">
              {remainingCount} remaining frontier pair{remainingCount !== 1 ? 's' : ''} to fill.
            </p>
          </div>

          {gen > MAX_SEARCH_GEN && (
            <p className="search-frontier-warning">
              Warning: gen {gen} completion may take a long time. Use <em>Find 1</em> or <em>Stop</em> at any time.
            </p>
          )}

          {/* Mode selector */}
          <div className="search-mode-selector">
            <span className="search-mode-selector-label">Mode:</span>
            {(['first1', 'first10', 'all'] as SearchMode[]).map(m => (
              <button
                key={m}
                className={`search-mode-btn${searchMode === m ? ' search-mode-btn--active' : ''}`}
                onClick={() => setSearchMode(m)}
                disabled={running}
              >{MODE_LABELS[m]}</button>
            ))}
          </div>

          {/* Toolbar */}
          <div className="search-toolbar">
            {!running ? (
              <button className="search-run-btn" onClick={handleRun}>
                Run Completion
              </button>
            ) : (
              <button className="search-stop-btn" onClick={handleStop}>Stop</button>
            )}
            <button
              className="search-export-btn"
              onClick={handleExport}
              disabled={solutions.length === 0}
            >Export JSON</button>
          </div>

          {workerError && (
            <p className="search-frontier-error">Worker error: {workerError}</p>
          )}

          {/* Debug info panel — appears once worker reports it */}
          {debugInfo && (
            <div className="complete-debug-info">
              <span className="complete-debug-title">Completion scope</span>
              <div className="complete-debug-grid">
                <span className="complete-debug-label">Unmatched top nodes</span>
                <span className="complete-debug-value">{debugInfo.remainingTopCount}</span>
                <span className="complete-debug-label">Unmatched bot nodes</span>
                <span className="complete-debug-value">{debugInfo.remainingBotCount}</span>
                <span className="complete-debug-label">Pairs to assign</span>
                <span className="complete-debug-value">{debugInfo.pairsCount}</span>
                <span className="complete-debug-label">
                  Legal colors for first pair
                  {debugInfo.pairsCount > 1 ? ' ¹' : ''}
                </span>
                <span className={`complete-debug-value ${debugInfo.legalColorsForFirst === 0 ? 'complete-debug-value--zero' : ''}`}>
                  {debugInfo.legalColorsForFirst === -1 ? 'n/a' : debugInfo.legalColorsForFirst}
                </span>
              </div>
              {debugInfo.pairsCount > 1 && (
                <p className="complete-debug-note">¹ First top node vs first bot node (indicative).</p>
              )}
              {debugInfo.legalColorsForFirst === 0 && debugInfo.pairsCount === 1 && (
                <p className="complete-debug-note complete-debug-note--warn">
                  No legal colors available — this partial pattern has no valid completion.
                </p>
              )}
              {debugInfo.pairsCount <= 4 && (
                <p className="complete-debug-note complete-debug-note--fast">
                  Fast path active — direct enumeration, no restart overhead.
                </p>
              )}
            </div>
          )}

          {/* Progress */}
          {progress && (
            <div className="search-progress">
              {statusLabel && <span className="search-progress-status">{statusLabel}</span>}
              <span className="search-progress-stat">
                {progress.partialStatesExplored.toLocaleString()} partial states explored
              </span>
              <span className="search-progress-stat">
                {progress.completeMatchingsEvaluated.toLocaleString()} complete matchings evaluated
              </span>
              <span className="search-progress-stat search-progress-found">
                <strong>{progress.validSolutionsFound}</strong>{' '}
                completion{progress.validSolutionsFound !== 1 ? 's' : ''} found
              </span>
            </div>
          )}

          {!running && progress === null && solutions.length === 0 && (
            <p className="search-empty">Press <em>Run Completion</em> to find completions.</p>
          )}
          {!running && progress !== null && solutions.length === 0 && (
            <p className="search-empty">No valid completions found for this partial pattern.</p>
          )}

          {solutions.length > 0 && (
            <div className="solution-grid">
              {solutions.map(sol => (
                <CompletionCard
                  key={sol.id}
                  solution={sol}
                  fixedCount={pattern.connections.length}
                  onLoad={() => onLoadSolution(sol.connections)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CompletionCard({
  solution,
  fixedCount,
  onLoad,
}: {
  solution: SolutionSnapshot;
  fixedCount: number;
  onLoad: () => void;
}) {
  return (
    <div className="solution-card">
      <div className="solution-card-header">
        <span className="solution-card-edges">
          {solution.connections.length} pairs
        </span>
        <button className="solution-load-btn" onClick={onLoad}>Load →</button>
      </div>
      <ul className="solution-edge-list">
        {solution.connections.map((c, i) => (
          <li key={i} className={`solution-edge-item${i < fixedCount ? ' complete-fixed-edge-item' : ''}`}>
            <span
              className="solution-edge-dot"
              style={{ background: EDGE_COLORS[c.color] }}
            />
            <span className="solution-edge-label">
              {c.from.replace(/^[^-]+-/, '')} → {c.to.replace(/^[^-]+-/, '')}
            </span>
            {i < fixedCount && <span className="complete-locked-badge">🔒</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
