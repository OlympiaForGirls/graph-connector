// RandomSearch.tsx — Monte Carlo random graph search UI.
//
// Continuously generates random perfect matchings with random colors,
// validates each one, and emits valid solutions until stopped.

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Graph } from '../types/graph';
import type { ConnectionSnapshot, SolutionSnapshot } from '../types/solution';
import { appendSolutions } from '../storage/solutions';
import { EDGE_COLORS } from './GraphView';

interface Props {
  gen:          number;
  topGraph:     Graph;
  bottomGraph:  Graph;
  onLoadSolution: (connections: ConnectionSnapshot[]) => void;
}

interface RandomStats {
  attempts:       number;
  validFound:     number;
  attemptsPerSec: number;
}

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

export default function RandomSearch({
  gen, topGraph, bottomGraph, onLoadSolution,
}: Props) {
  const [running,   setRunning]   = useState(false);
  const [solutions, setSolutions] = useState<SolutionSnapshot[]>([]);
  const [stats,     setStats]     = useState<RandomStats | null>(null);
  const [stopped,   setStopped]   = useState(false);

  const workerRef = useRef<Worker | null>(null);

  // Terminate worker on unmount.
  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  // Reset when gen changes.
  useEffect(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(false);
    setSolutions([]);
    setStats(null);
    setStopped(false);
  }, [gen]);

  const handleStart = useCallback(() => {
    workerRef.current?.terminate();

    setSolutions([]);
    setStats({ attempts: 0, validFound: 0, attemptsPerSec: 0 });
    setRunning(true);
    setStopped(false);

    const worker = new Worker(
      new URL('../solver/randomWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string } & Record<string, unknown>;

      if (msg.type === 'SOLUTION') {
        const sol = msg.solution as SolutionSnapshot;
        appendSolutions([sol]);
        setSolutions(prev => [...prev, sol]);
      } else if (msg.type === 'PROGRESS') {
        setStats({
          attempts:       msg.attempts       as number,
          validFound:     msg.validFound     as number,
          attemptsPerSec: msg.attemptsPerSec as number,
        });
      } else if (msg.type === 'STOPPED') {
        setStats(prev => prev ? {
          ...prev,
          attempts:   msg.attempts   as number,
          validFound: msg.validFound as number,
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

    worker.postMessage({
      type: 'START',
      payload: { gen, topGraph, bottomGraph },
    });
  }, [gen, topGraph, bottomGraph]);

  const handleStop = useCallback(() => {
    if (!workerRef.current) return;
    workerRef.current.postMessage({ type: 'STOP' });
    // Worker will reply with STOPPED; running will be cleared then.
  }, []);

  const handleClear = useCallback(() => {
    setSolutions([]);
    setStats(null);
    setStopped(false);
  }, []);

  const hitRate = (stats && stats.attempts > 0)
    ? ((stats.validFound / stats.attempts) * 100).toFixed(3)
    : null;

  return (
    <div className="random-panel">
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

      {stats && (
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
            <span className="random-stat-label">Rate</span>
            <span className="random-stat-value">{formatRate(stats.attemptsPerSec)}</span>
          </div>
          {hitRate !== null && (
            <div className="random-stat">
              <span className="random-stat-label">Hit rate</span>
              <span className="random-stat-value">{hitRate}%</span>
            </div>
          )}
        </div>
      )}

      {stopped && !running && (
        <p className="random-stopped">Stopped — {solutions.length} solution{solutions.length !== 1 ? 's' : ''} collected.</p>
      )}

      {!stats && !running && (
        <p className="random-starting">Press <em>Start Random Search</em> to begin sampling random configurations.</p>
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
