// PartialSearch.tsx — UI for finding valid partial matchings of exactly N cross-edges.

import { useState, useEffect, useRef } from 'react';
import type { Graph } from '../types/graph';
import type { PartialPattern } from '../types/partial';
import type { PartialProgress, PartialResult } from '../solver/partialSearch';
import { loadPartials, appendPartials, clearPartialsForGen } from '../storage/partials';
import { EDGE_COLORS } from './GraphView';

interface Props {
  gen: number;
  topGraph: Graph;
  bottomGraph: Graph;
  onSelectPattern: (p: PartialPattern) => void;
}

const PRESET_SIZES = [4, 6, 8];
const DEFAULT_SIZE = 6;
const MAX_PATTERNS = 200;

function isValidPartial(p: PartialPattern, gen: number, targetEdges: number): boolean {
  return (
    p.generation === gen &&
    p.connections.length === targetEdges
  );
}

export default function PartialSearch({ gen, topGraph, bottomGraph, onSelectPattern }: Props) {
  const [patterns, setPatterns]     = useState<PartialPattern[]>([]);
  const [running, setRunning]       = useState(false);
  const [progress, setProgress]     = useState<PartialProgress | null>(null);
  const [targetEdges, setTargetEdges] = useState(DEFAULT_SIZE);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const workerRef       = useRef<Worker | null>(null);
  const lastProgressRef = useRef<PartialProgress | null>(null);
  const importRef       = useRef<HTMLInputElement>(null);

  const topFrontierCount = topGraph.nodes.filter(n => n.isFrontier).length;
  const botFrontierCount = bottomGraph.nodes.filter(n => n.isFrontier).length;
  const countsEqual      = topFrontierCount === botFrontierCount;
  const canSearch        = countsEqual && targetEdges <= topFrontierCount;

  const loadFiltered = () =>
    loadPartials().filter(p => isValidPartial(p, gen, targetEdges));

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    lastProgressRef.current = null;
    setRunning(false);
    setPatterns(loadFiltered());
    setProgress(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, targetEdges]);

  const handleRun = () => {
    if (!canSearch) return;
    workerRef.current?.terminate();
    workerRef.current = null;

    setPatterns([]);
    setRunning(true);
    setWorkerError(null);
    setProgress({
      statesExplored: 0, patternsFound: 0,
      stopped: false, timedOut: false, done: false,
    });
    lastProgressRef.current = null;
    clearPartialsForGen(gen);

    const worker = new Worker(
      new URL('../solver/partialWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    const runTarget = targetEdges;

    worker.onmessage = (e: MessageEvent) => {
      const { type } = e.data as { type: string };

      if (type === 'PATTERN') {
        const pat = (e.data as { type: string; pattern: PartialPattern }).pattern;
        if (isValidPartial(pat, gen, runTarget)) {
          setPatterns(prev => [...prev, pat]);
        }
      } else if (type === 'PROGRESS') {
        const p = (e.data as { type: string; progress: PartialProgress }).progress;
        lastProgressRef.current = p;
        setProgress(p);
      } else if (type === 'DONE') {
        const { patterns: finalPats, progress: finalProg } =
          (e.data as { type: string; result: PartialResult }).result;
        appendPartials(finalPats);
        setPatterns(loadFiltered());
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
      payload: { gen, topGraph, bottomGraph, targetEdges, maxPatterns: MAX_PATTERNS },
    });
  };

  const handleStop = () => {
    if (!workerRef.current) return;
    workerRef.current.terminate();
    workerRef.current = null;
    setPatterns(prev => { appendPartials(prev); return prev; });
    const last = lastProgressRef.current;
    setProgress(
      last
        ? { ...last, stopped: true, done: false }
        : { statesExplored: 0, patternsFound: 0, stopped: true, timedOut: false, done: false },
    );
    setRunning(false);
  };

  const handleClear = () => {
    clearPartialsForGen(gen);
    setPatterns([]);
    setProgress(null);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(patterns, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `partials-gen${gen}-size${targetEdges}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw      = JSON.parse(ev.target?.result as string) as PartialPattern[];
        const filtered = raw.filter(p => isValidPartial(p, gen, targetEdges));
        appendPartials(filtered);
        setPatterns(loadFiltered());
      } catch {
        alert('Import failed: invalid JSON.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const statusLabel = (() => {
    if (!progress) return null;
    if (!progress.done && !progress.stopped && !progress.timedOut) return null;
    if (progress.timedOut) return '⏱ Timed out — results may be incomplete';
    if (progress.stopped)  return '⏹ Stopped — results may be incomplete';
    return '✓ Done — all partial patterns found';
  })();

  return (
    <div className="partial-search">
      <p className="search-mode-label">
        <strong>Partial Matching Search</strong>
        {' — '}Find all valid partial matchings of exactly{' '}
        <strong>{targetEdges}</strong> cross-edges for gen {gen}.
        {' '}({topFrontierCount} top · {botFrontierCount} bottom)
      </p>

      {!countsEqual && (
        <p className="search-frontier-error">
          Cannot run search: unequal frontier counts
          ({topFrontierCount} top vs {botFrontierCount} bottom).
        </p>
      )}

      {/* Size selector */}
      <div className="search-mode-selector">
        <span className="search-mode-selector-label">Edges:</span>
        {PRESET_SIZES.map(s => (
          <button
            key={s}
            className={`search-mode-btn${targetEdges === s ? ' search-mode-btn--active' : ''}`}
            onClick={() => setTargetEdges(s)}
            disabled={running}
          >{s}</button>
        ))}
        {/* Custom size input for non-preset values */}
        <input
          type="number"
          min={1}
          max={topFrontierCount || 24}
          value={targetEdges}
          disabled={running}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 1) setTargetEdges(v);
          }}
          className="partial-size-input"
        />
      </div>

      {/* Toolbar */}
      <div className="search-toolbar">
        {!running ? (
          <button className="search-run-btn" onClick={handleRun} disabled={!canSearch}>
            Run Search
          </button>
        ) : (
          <button className="search-stop-btn" onClick={handleStop}>Stop</button>
        )}
        <button
          className="search-clear-btn"
          onClick={handleClear}
          disabled={running || patterns.length === 0}
        >Clear</button>
        <button
          className="search-export-btn"
          onClick={handleExport}
          disabled={patterns.length === 0}
        >Export JSON</button>
        <button
          className="search-import-btn"
          onClick={() => importRef.current?.click()}
          disabled={running}
        >Import JSON</button>
        <input
          ref={importRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleImport}
        />
      </div>

      {workerError && (
        <p className="search-frontier-error">Worker error: {workerError}</p>
      )}

      {/* Progress */}
      {progress && (
        <div className="search-progress">
          {statusLabel && <span className="search-progress-status">{statusLabel}</span>}
          <span className="search-progress-stat">
            {progress.statesExplored.toLocaleString()} states explored
          </span>
          <span className="search-progress-stat search-progress-found">
            <strong>{progress.patternsFound}</strong>{' '}
            partial pattern{progress.patternsFound !== 1 ? 's' : ''} found
          </span>
        </div>
      )}

      {/* Empty states */}
      {!running && canSearch && progress === null && patterns.length === 0 && (
        <p className="search-empty">
          No partial patterns stored for gen {gen} with {targetEdges} edges.{' '}
          Press <em>Run Search</em> to find them.
        </p>
      )}
      {!running && canSearch && progress !== null && patterns.length === 0 && (
        <p className="search-empty">No valid partial patterns found.</p>
      )}

      {/* Pattern grid */}
      {patterns.length > 0 && (
        <div className="solution-grid">
          {patterns.map(pat => (
            <PartialCard
              key={pat.id}
              pattern={pat}
              onSelect={() => onSelectPattern(pat)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PartialCard({
  pattern,
  onSelect,
}: {
  pattern: PartialPattern;
  onSelect: () => void;
}) {
  return (
    <div className="solution-card partial-card">
      <div className="solution-card-header">
        <span className="solution-card-edges">
          {pattern.connections.length} edges
        </span>
        <span className="solution-card-ts">
          {pattern.remainingTopNodes.length} remaining
        </span>
        <button className="solution-load-btn partial-select-btn" onClick={onSelect}>
          Complete →
        </button>
      </div>
      <ul className="solution-edge-list">
        {pattern.connections.map((c, i) => (
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
