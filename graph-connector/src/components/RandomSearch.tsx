// RandomSearch.tsx — Monte Carlo random graph search UI.
//
// Supports two modes:
//   LOCAL  (default)  — runs search in a browser Web Worker.
//   BACKEND           — delegates to the Express backend API.
//                       Activated by setting VITE_BACKEND_URL in the build env.
//
// The local mode is unchanged from the original implementation.
// The backend mode polls /random-search-status every 3 s and
// fetches /random-search-solutions whenever validFound increases.

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Graph } from '../types/graph';
import type { ConnectionSnapshot, SolutionSnapshot } from '../types/solution';
import { appendSolutions } from '../storage/solutions';
import { EDGE_COLORS } from './GraphView';

// ── Backend config ────────────────────────────────────────────────────────────
const BACKEND_URL = (
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? ''
).replace(/\/$/, '');
const USE_BACKEND = BACKEND_URL.length > 0;

interface BackendStatus {
  running:               boolean;
  gen:                   number | null;
  attempts:              number;
  validFound:            number;
  attemptsPerSecCurrent: number;
  attemptsPerSecAvg:     number;
  uptime:                number;
}

// ── Props ─────────────────────────────────────────────────────────────────────
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

// ── localStorage checkpoint helpers (local mode only) ─────────────────────────
interface CheckpointData {
  attempts:   number;
  validFound: number;
  timestamp:  number;
}

function ckptKey(gen: number): string { return `rnd-ckpt-g${gen}`; }

function loadCheckpoint(gen: number): CheckpointData | null {
  try {
    const raw = localStorage.getItem(ckptKey(gen));
    return raw ? (JSON.parse(raw) as CheckpointData) : null;
  } catch { return null; }
}

function saveCheckpoint(gen: number, data: CheckpointData): void {
  try { localStorage.setItem(ckptKey(gen), JSON.stringify(data)); } catch { /* quota/private */ }
}

function clearCheckpoint(gen: number): void {
  try { localStorage.removeItem(ckptKey(gen)); } catch { /* ignore */ }
}

// ── Formatters ────────────────────────────────────────────────────────────────
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatRate(n: number): string {
  if (n === 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M/s`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k/s`;
  return `${n}/s`;
}

function formatUptime(sec: number): string {
  if (sec < 60)  return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}m ${s}s`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function RandomSearch({
  gen, topGraph, bottomGraph, onLoadSolution,
}: Props) {
  const [running,      setRunning]      = useState(false);
  const [solutions,    setSolutions]    = useState<SolutionSnapshot[]>([]);
  const [stats,        setStats]        = useState<RandomStats | null>(null);
  const [stopped,      setStopped]      = useState(false);
  const [lastCkpt,     setLastCkpt]     = useState<CheckpointData | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);

  // Local worker refs (used only when !USE_BACKEND)
  const workerRef      = useRef<Worker | null>(null);
  const baseAttempts   = useRef(0);
  const baseValidFound = useRef(0);

  // Backend mode refs
  const knownSolCountRef  = useRef(0);
  const sessionStartedRef = useRef(false); // true once user clicked Start this session

  // Terminate worker on unmount.
  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  // ── Gen-change effect ─────────────────────────────────────────────────────
  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(false);
    setSolutions([]);
    setStopped(false);
    setBackendError(null);
    sessionStartedRef.current = false;
    knownSolCountRef.current  = 0;

    if (USE_BACKEND) {
      setStats(null);
      setLastCkpt(null);
      return;
    }

    // Local mode: restore localStorage checkpoint.
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

  // ── Backend polling effect (only when USE_BACKEND) ────────────────────────
  useEffect(() => {
    if (!USE_BACKEND) return;

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${BACKEND_URL}/random-search-status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: BackendStatus = await res.json();

        if (cancelled) return;

        // Ignore data from a different gen.
        if (data.gen !== null && data.gen !== gen) return;

        setRunning(data.running);

        // Mark stopped only if the user had started this session and search ended.
        if (!data.running && sessionStartedRef.current && data.attempts > 0) {
          setStopped(true);
          sessionStartedRef.current = false;
        }

        if (data.attempts > 0 || data.running) {
          setStats({
            attempts:              data.attempts,
            validFound:            data.validFound,
            attemptsPerSecCurrent: data.attemptsPerSecCurrent,
            attemptsPerSecAvg:     data.attemptsPerSecAvg,
            uptime:                data.uptime,
            uiUpdates:             0,
            avgBatchSize:          0,
          });
        }

        // Fetch solutions only when the count grew.
        if (data.validFound > knownSolCountRef.current) {
          knownSolCountRef.current = data.validFound;
          const solRes = await fetch(`${BACKEND_URL}/random-search-solutions`);
          if (solRes.ok) {
            const solData: { solutions: SolutionSnapshot[] } = await solRes.json();
            setSolutions(solData.solutions.filter(s => s.generation === gen));
          }
        }

        setBackendError(null);
      } catch {
        if (!cancelled) setBackendError('Cannot reach backend. Check VITE_BACKEND_URL.');
      }
    };

    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [gen]);

  // ── Start handler ─────────────────────────────────────────────────────────
  const handleStart = useCallback(() => {
    if (USE_BACKEND) {
      setBackendError(null);
      sessionStartedRef.current = true;
      setStopped(false);
      fetch(`${BACKEND_URL}/start-random-search`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ gen }),
      })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          setRunning(true);
        })
        .catch(() => {
          sessionStartedRef.current = false;
          setBackendError('Failed to start. Is the backend deployed and running?');
        });
      return;
    }

    // ── Local worker start (unchanged) ──────────────────────────────────────
    workerRef.current?.terminate();
    setSolutions([]);
    setRunning(true);
    setStopped(false);

    const worker = new Worker(
      new URL('../solver/randomWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    const base   = baseAttempts.current;
    const baseVF = baseValidFound.current;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string } & Record<string, unknown>;

      if (msg.type === 'SOLUTION') {
        const sol = msg.solution as SolutionSnapshot;
        appendSolutions([sol]);
        setSolutions(prev => [...prev, sol]);
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
        const totalAttempts   = base   + (msg.attempts   as number);
        const totalValidFound = baseVF + (msg.validFound as number);
        const ckpt: CheckpointData = { attempts: totalAttempts, validFound: totalValidFound, timestamp: Date.now() };
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

    worker.onerror = () => {
      setRunning(false);
      workerRef.current = null;
    };

    worker.postMessage({ type: 'START', payload: { gen, topGraph, bottomGraph, baseAttempts: base } });
  }, [gen, topGraph, bottomGraph]);

  // ── Stop handler ──────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    if (USE_BACKEND) {
      fetch(`${BACKEND_URL}/stop-random-search`, { method: 'POST' })
        .catch(() => setBackendError('Failed to stop.'));
      return;
    }
    workerRef.current?.postMessage({ type: 'STOP' });
  }, []);

  // ── Clear handler ─────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    if (USE_BACKEND) {
      fetch(`${BACKEND_URL}/reset-random-search`, { method: 'POST' })
        .then(() => {
          setSolutions([]);
          setStats(null);
          setStopped(false);
          setBackendError(null);
          knownSolCountRef.current  = 0;
          sessionStartedRef.current = false;
        })
        .catch(() => setBackendError('Failed to reset backend.'));
      return;
    }
    clearCheckpoint(gen);
    baseAttempts.current   = 0;
    baseValidFound.current = 0;
    setSolutions([]);
    setStats(null);
    setStopped(false);
    setLastCkpt(null);
  }, [gen]);

  const hitRate = (stats && stats.attempts > 0)
    ? ((stats.validFound / stats.attempts) * 100).toFixed(3)
    : null;

  return (
    <div className="random-panel">
      {USE_BACKEND && (
        <p className="random-checkpoint" style={{ color: '#9999cc' }}>
          Mode: <strong>Backend</strong> — {BACKEND_URL}
        </p>
      )}

      <div className="random-controls">
        {!running ? (
          <button className="random-start-btn" onClick={handleStart}>
            Start Random Search
          </button>
        ) : (
          <button className="random-stop-btn" onClick={handleStop}>
            Stop
          </button>
        )}
        <button
          className="random-clear-btn"
          onClick={handleClear}
          disabled={running || (solutions.length === 0 && !stats)}
        >
          Clear
        </button>
      </div>

      {backendError && (
        <p className="random-stopped" style={{ color: '#e84040' }}>
          {backendError}
        </p>
      )}

      {stats && (
        <>
          {/* Primary stats */}
          <div className="random-stats">
            <div className="random-stat">
              <span className="random-stat-label">Attempts</span>
              <span className="random-stat-value">{formatCount(stats.attempts)}</span>
            </div>
            <div className="random-stat">
              <span className="random-stat-label">Valid found</span>
              <span className="random-stat-value random-stat-value--found">{stats.validFound}</span>
            </div>
            <div className="random-stat">
              <span className="random-stat-label">Rate (cur)</span>
              <span className="random-stat-value">{formatRate(stats.attemptsPerSecCurrent)}</span>
            </div>
            <div className="random-stat">
              <span className="random-stat-label">Rate (avg)</span>
              <span className="random-stat-value">{formatRate(stats.attemptsPerSecAvg)}</span>
            </div>
            {hitRate !== null && (
              <div className="random-stat">
                <span className="random-stat-label">Hit rate</span>
                <span className="random-stat-value">{hitRate}%</span>
              </div>
            )}
          </div>

          {/* Diagnostics (local mode only — backend doesn't emit these) */}
          {!USE_BACKEND && (
            <div className="random-diag">
              <span className="random-diag-title">Diagnostics</span>
              <div className="random-stats random-stats--diag">
                <div className="random-stat random-stat--sm">
                  <span className="random-stat-label">Uptime</span>
                  <span className="random-stat-value random-stat-value--dim">{formatUptime(stats.uptime)}</span>
                </div>
                <div className="random-stat random-stat--sm">
                  <span className="random-stat-label">UI updates</span>
                  <span className="random-stat-value random-stat-value--dim">{stats.uiUpdates}</span>
                </div>
                <div className="random-stat random-stat--sm">
                  <span className="random-stat-label">Avg batch</span>
                  <span className="random-stat-value random-stat-value--dim">{formatCount(stats.avgBatchSize)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Uptime in backend mode */}
          {USE_BACKEND && stats.uptime > 0 && (
            <div className="random-diag">
              <span className="random-diag-title">Diagnostics</span>
              <div className="random-stats random-stats--diag">
                <div className="random-stat random-stat--sm">
                  <span className="random-stat-label">Uptime</span>
                  <span className="random-stat-value random-stat-value--dim">{formatUptime(stats.uptime)}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Checkpoint display (local mode only) */}
      {!USE_BACKEND && lastCkpt && (
        <p className="random-checkpoint">
          Last checkpoint: {formatCount(lastCkpt.attempts)} attempts
          {' · '}{new Date(lastCkpt.timestamp).toLocaleTimeString()}
        </p>
      )}

      {stopped && !running && (
        <p className="random-stopped">
          Stopped — {solutions.length} solution{solutions.length !== 1 ? 's' : ''} collected.
        </p>
      )}

      {!stats && !running && !backendError && (
        <p className="random-starting">
          Press <em>Start Random Search</em> to begin sampling random configurations.
          {USE_BACKEND && ' (runs on server)'}
        </p>
      )}

      {solutions.length > 0 && (
        <div className="solution-grid">
          {solutions.map(sol => (
            <RandomSolutionCard
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

function RandomSolutionCard({
  solution,
  onLoad,
}: {
  solution: SolutionSnapshot;
  onLoad: () => void;
}) {
  return (
    <div className="solution-card">
      <div className="solution-card-header">
        <span className="solution-card-edges">{solution.connections.length} pairs</span>
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
