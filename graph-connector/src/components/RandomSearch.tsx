// RandomSearch.tsx — two coexisting workflows:
//
//  1. BROWSER  — runs search in a Web Worker right in the tab.
//               Convenient for quick exploration; speed limited by browser.
//
//  2. IMPORT   — import a solutions JSON file produced by the local Node
//               runner (local-search/search.js) for heavier/faster runs.
//
// Both modes display solutions as clickable cards that load into the graph.

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Graph } from '../types/graph';
import type { ConnectionSnapshot, SolutionSnapshot } from '../types/solution';
import { appendSolutions } from '../storage/solutions';
import { EDGE_COLORS } from './GraphView';

interface Props {
  gen:            number;
  topGraph:       Graph;
  bottomGraph:    Graph;
  onLoadSolution: (connections: ConnectionSnapshot[]) => void;
}

interface RandomStats {
  attempts:              number;
  validFound:            number;
  attemptsPerSecCurrent: number;
  attemptsPerSecAvg:     number;
  uptime:                number;
  uiUpdates:             number;
  avgBatchSize:          number;
}

// ── localStorage checkpoint helpers ──────────────────────────────────────────
interface CheckpointData { attempts: number; validFound: number; timestamp: number; }

function ckptKey(gen: number) { return `rnd-ckpt-g${gen}`; }
function loadCheckpoint(gen: number): CheckpointData | null {
  try { const r = localStorage.getItem(ckptKey(gen)); return r ? JSON.parse(r) : null; }
  catch { return null; }
}
function saveCheckpoint(gen: number, d: CheckpointData) {
  try { localStorage.setItem(ckptKey(gen), JSON.stringify(d)); } catch { /* quota */ }
}
function clearCheckpoint(gen: number) {
  try { localStorage.removeItem(ckptKey(gen)); } catch { /* ignore */ }
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtRate(n: number) {
  if (n === 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M/s`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k/s`;
  return `${n}/s`;
}
function fmtUptime(sec: number) {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}m ${s}s`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function RandomSearch({ gen, topGraph, bottomGraph, onLoadSolution }: Props) {
  // 'browser' | 'import' — which sub-panel is expanded
  const [activeTab, setActiveTab] = useState<'browser' | 'import'>('browser');

  // ── Browser search state ───────────────────────────────────────────────────
  const [running,       setRunning]       = useState(false);
  const [browserSols,   setBrowserSols]   = useState<SolutionSnapshot[]>([]);
  const [stats,         setStats]         = useState<RandomStats | null>(null);
  const [stopped,       setStopped]       = useState(false);
  const [lastCkpt,      setLastCkpt]      = useState<CheckpointData | null>(null);

  // ── Import state ───────────────────────────────────────────────────────────
  const [importedSols,  setImportedSols]  = useState<SolutionSnapshot[]>([]);
  const [importErr,     setImportErr]     = useState<string | null>(null);
  const [importMsg,     setImportMsg]     = useState<string | null>(null);

  const workerRef      = useRef<Worker | null>(null);
  const baseAttempts   = useRef(0);
  const baseValidFound = useRef(0);
  const importRef      = useRef<HTMLInputElement>(null);

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  // Reset when gen changes.
  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(false);
    setBrowserSols([]);
    setStopped(false);
    setImportErr(null);
    setImportMsg(null);

    const ckpt = loadCheckpoint(gen);
    baseAttempts.current   = ckpt?.attempts   ?? 0;
    baseValidFound.current = ckpt?.validFound ?? 0;
    setLastCkpt(ckpt);
    setStats(ckpt ? {
      attempts: ckpt.attempts, validFound: ckpt.validFound,
      attemptsPerSecCurrent: 0, attemptsPerSecAvg: 0,
      uptime: 0, uiUpdates: 0, avgBatchSize: 0,
    } : null);
  }, [gen]);

  // ── Browser search handlers ────────────────────────────────────────────────
  const handleStart = useCallback(() => {
    workerRef.current?.terminate();
    setBrowserSols([]);
    setRunning(true);
    setStopped(false);

    const worker = new Worker(
      new URL('../solver/randomWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;
    const base = baseAttempts.current, baseVF = baseValidFound.current;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string } & Record<string, unknown>;
      if (msg.type === 'SOLUTION') {
        const sol = msg.solution as SolutionSnapshot;
        appendSolutions([sol]);
        setBrowserSols(prev => [...prev, sol]);
      } else if (msg.type === 'PROGRESS') {
        setStats({
          attempts:              base   + (msg.attempts   as number),
          validFound:            baseVF + (msg.validFound as number),
          attemptsPerSecCurrent: msg.attemptsPerSecCurrent as number,
          attemptsPerSecAvg:     msg.attemptsPerSecAvg     as number,
          uptime:                msg.uptime                as number,
          uiUpdates:             msg.uiUpdates             as number,
          avgBatchSize:          msg.avgBatchSize           as number,
        });
      } else if (msg.type === 'CHECKPOINT') {
        const ckpt: CheckpointData = {
          attempts:   base + (msg.attempts   as number),
          validFound: baseVF + (msg.validFound as number),
          timestamp:  Date.now(),
        };
        saveCheckpoint(gen, ckpt);
        setLastCkpt(ckpt);
      } else if (msg.type === 'STOPPED') {
        setStats(prev => prev ? {
          ...prev,
          attempts:   base   + (msg.attempts   as number),
          validFound: baseVF + (msg.validFound as number),
        } : null);
        setRunning(false);
        setStopped(true);
        workerRef.current = null;
      }
    };
    worker.onerror = () => { setRunning(false); workerRef.current = null; };
    worker.postMessage({ type: 'START', payload: { gen, topGraph, bottomGraph, baseAttempts: base } });
  }, [gen, topGraph, bottomGraph]);

  const handleStop  = useCallback(() => { workerRef.current?.postMessage({ type: 'STOP' }); }, []);
  const handleClear = useCallback(() => {
    clearCheckpoint(gen);
    baseAttempts.current = 0; baseValidFound.current = 0;
    setBrowserSols([]); setStats(null); setStopped(false); setLastCkpt(null);
  }, [gen]);

  const handleExport = useCallback(() => {
    if (browserSols.length === 0) return;
    const blob = new Blob([JSON.stringify(browserSols, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `solutions-gen${gen}.json`; a.click();
    URL.revokeObjectURL(url);
  }, [browserSols, gen]);

  // ── Import handler ─────────────────────────────────────────────────────────
  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportErr(null); setImportMsg(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target?.result as string) as SolutionSnapshot[];
        if (!Array.isArray(raw)) throw new Error('Expected a JSON array.');
        const valid     = raw.filter(s => s && typeof s.generation === 'number' && Array.isArray(s.connections));
        const forGen    = valid.filter(s => s.generation === gen);
        if (valid.length > 0 && forGen.length === 0) {
          setImportErr(`File has ${valid.length} solution(s) but none for gen ${gen}.`);
          return;
        }
        if (forGen.length === 0) { setImportErr('No valid solutions found in file.'); return; }
        appendSolutions(forGen);
        setImportedSols(prev => {
          const existingIds = new Set(prev.map(s => s.id));
          return [...prev, ...forGen.filter(s => !existingIds.has(s.id))];
        });
        setImportMsg(`Imported ${forGen.length} solution${forGen.length !== 1 ? 's' : ''} for gen ${gen}.`);
      } catch {
        setImportErr('Import failed: file must be a valid solutions JSON array.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [gen]);

  const handleClearImported = useCallback(() => {
    setImportedSols([]); setImportErr(null); setImportMsg(null);
  }, []);

  const hitRate = (stats && stats.attempts > 0)
    ? ((stats.validFound / stats.attempts) * 100).toFixed(3)
    : null;

  return (
    <div className="random-panel">

      {/* ── Mode selector tabs ─────────────────────────────────────────────── */}
      <div className="search-mode-selector" style={{ marginBottom: '12px' }}>
        <button
          className={`search-mode-btn${activeTab === 'browser' ? ' search-mode-btn--active' : ''}`}
          onClick={() => setActiveTab('browser')}
        >
          Run in Browser
        </button>
        <button
          className={`search-mode-btn${activeTab === 'import' ? ' search-mode-btn--active' : ''}`}
          onClick={() => setActiveTab('import')}
        >
          Import Local Results
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* BROWSER PANEL                                                        */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'browser' && (
        <div>
          <p className="random-starting" style={{ marginTop: 0, marginBottom: '10px' }}>
            Runs directly in your browser using a Web Worker.
            Convenient for quick exploration — typically <strong>40–80k/s</strong>.
            For long heavy runs use the local Node runner and import here.
          </p>

          <div className="random-controls">
            {!running ? (
              <button className="random-start-btn" onClick={handleStart}>
                Start Random Search
              </button>
            ) : (
              <button className="random-stop-btn" onClick={handleStop}>Stop</button>
            )}
            <button
              className="random-clear-btn"
              onClick={handleClear}
              disabled={running || (browserSols.length === 0 && !stats)}
            >Clear</button>
            <button
              className="search-export-btn"
              onClick={handleExport}
              disabled={browserSols.length === 0}
              title="Save found solutions as JSON"
            >Export JSON</button>
          </div>

          {stats && (
            <>
              <div className="random-stats">
                <div className="random-stat">
                  <span className="random-stat-label">Attempts</span>
                  <span className="random-stat-value">{fmtCount(stats.attempts)}</span>
                </div>
                <div className="random-stat">
                  <span className="random-stat-label">Valid found</span>
                  <span className="random-stat-value random-stat-value--found">{stats.validFound}</span>
                </div>
                <div className="random-stat">
                  <span className="random-stat-label">Rate (cur)</span>
                  <span className="random-stat-value">{fmtRate(stats.attemptsPerSecCurrent)}</span>
                </div>
                <div className="random-stat">
                  <span className="random-stat-label">Rate (avg)</span>
                  <span className="random-stat-value">{fmtRate(stats.attemptsPerSecAvg)}</span>
                </div>
                {hitRate !== null && (
                  <div className="random-stat">
                    <span className="random-stat-label">Hit rate</span>
                    <span className="random-stat-value">{hitRate}%</span>
                  </div>
                )}
              </div>

              <div className="random-diag">
                <span className="random-diag-title">Diagnostics</span>
                <div className="random-stats random-stats--diag">
                  <div className="random-stat random-stat--sm">
                    <span className="random-stat-label">Uptime</span>
                    <span className="random-stat-value random-stat-value--dim">{fmtUptime(stats.uptime)}</span>
                  </div>
                  <div className="random-stat random-stat--sm">
                    <span className="random-stat-label">UI updates</span>
                    <span className="random-stat-value random-stat-value--dim">{stats.uiUpdates}</span>
                  </div>
                  <div className="random-stat random-stat--sm">
                    <span className="random-stat-label">Avg batch</span>
                    <span className="random-stat-value random-stat-value--dim">{fmtCount(stats.avgBatchSize)}</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {lastCkpt && (
            <p className="random-checkpoint">
              Last checkpoint: {fmtCount(lastCkpt.attempts)} attempts
              {' · '}{new Date(lastCkpt.timestamp).toLocaleTimeString()}
            </p>
          )}

          {stopped && !running && (
            <p className="random-stopped">
              Stopped — {browserSols.length} solution{browserSols.length !== 1 ? 's' : ''} collected.
            </p>
          )}

          {!stats && !running && (
            <p className="random-starting">
              Press <em>Start Random Search</em> to begin.
            </p>
          )}

          {browserSols.length > 0 && (
            <div className="solution-grid">
              {browserSols.map(sol => (
                <SolutionCard key={sol.id} solution={sol} onLoad={() => onLoadSolution(sol.connections)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* IMPORT PANEL                                                         */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'import' && (
        <div>
          <p className="random-starting" style={{ marginTop: 0, marginBottom: '10px' }}>
            Import a <code>solutions-gen{gen}.json</code> file produced by the local Node runner
            on your computer. The Node runner runs at <strong>~1M+/s</strong> and is better for
            long or heavy searches.
          </p>
          <p className="random-starting" style={{ marginTop: 0, marginBottom: '14px', fontSize: '12px', opacity: 0.75 }}>
            Run locally: <code>node local-search/search.js --gen {gen}</code>
            {' '}then import the output file here.
          </p>

          <div className="random-controls">
            <button
              className="search-import-btn"
              onClick={() => importRef.current?.click()}
              title="Import solutions-genN.json from local Node runner"
            >
              Import Solutions JSON
            </button>
            <button
              className="random-clear-btn"
              onClick={handleClearImported}
              disabled={importedSols.length === 0}
            >Clear</button>
            <input
              ref={importRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleImport}
            />
          </div>

          {importErr && <p className="search-frontier-error">{importErr}</p>}
          {importMsg && (
            <p className="random-checkpoint" style={{ color: '#3ab03a' }}>{importMsg}</p>
          )}

          {importedSols.length === 0 && !importErr && !importMsg && (
            <p className="random-starting">
              No solutions imported yet. Click <em>Import Solutions JSON</em> to load a file.
            </p>
          )}

          {importedSols.length > 0 && (
            <>
              <p className="random-checkpoint">
                {importedSols.length} solution{importedSols.length !== 1 ? 's' : ''} imported for gen {gen}.
              </p>
              <div className="solution-grid">
                {importedSols.map(sol => (
                  <SolutionCard key={sol.id} solution={sol} onLoad={() => onLoadSolution(sol.connections)} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SolutionCard({ solution, onLoad }: { solution: SolutionSnapshot; onLoad: () => void }) {
  return (
    <div className="solution-card">
      <div className="solution-card-header">
        <span className="solution-card-edges">{solution.connections.length} pairs</span>
        <button className="solution-load-btn" onClick={onLoad}>Load →</button>
      </div>
      <ul className="solution-edge-list">
        {solution.connections.map((c, i) => (
          <li key={i} className="solution-edge-item">
            <span className="solution-edge-dot" style={{ background: EDGE_COLORS[c.color] }} />
            <span className="solution-edge-label">
              {c.from.replace(/^[^-]+-/, '')} → {c.to.replace(/^[^-]+-/, '')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
