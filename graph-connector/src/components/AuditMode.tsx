// AuditMode.tsx — correctness audit comparing naive vs optimized solver.

import { useState, useRef, useCallback, useEffect } from 'react';
import type { Graph } from '../types/graph';
import type { SolutionSnapshot } from '../types/solution';

interface AuditStats {
  partialStatesExplored: number;
  completeMatchingsEvaluated: number;
}

interface AuditResult {
  naiveCount:   number;
  optCount:     number;
  matchCount:   number;
  missedByOpt:  SolutionSnapshot[];
  falseByOpt:   SolutionSnapshot[];
  naiveStats:   AuditStats;
  optStats:     AuditStats;
  optExhausted: boolean;
  optTimedOut:  boolean;
}

interface Props {
  gen: number;
  topGraph: Graph;
  bottomGraph: Graph;
}

export default function AuditMode({ gen, topGraph, bottomGraph }: Props) {
  const [status,  setStatus]  = useState<string>('');
  const [running, setRunning] = useState(false);
  const [result,  setResult]  = useState<AuditResult | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  // Terminate any in-flight worker when the component unmounts or gen changes.
  useEffect(() => {
    return () => { workerRef.current?.terminate(); };
  }, []);

  useEffect(() => {
    workerRef.current?.terminate();
    setRunning(false);
    setResult(null);
    setError(null);
    setStatus('');
  }, [gen]);

  const handleRun = useCallback(() => {
    if (running) return;
    setRunning(true);
    setResult(null);
    setError(null);
    setStatus('Starting audit…');

    workerRef.current?.terminate();
    const w = new Worker(
      new URL('../solver/auditWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = w;

    w.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ACK':        setStatus('Audit worker started.'); break;
        case 'STATUS':     setStatus(msg.message); break;
        case 'NAIVE_DONE': setStatus(`Naive done: ${msg.count} solutions found. Now running optimized solver…`); break;
        case 'OPT_DONE':   setStatus(`Optimized done: ${msg.count} solutions found. Comparing…`); break;
        case 'DONE':
          setResult(msg.result);
          setRunning(false);
          setStatus('');
          w.terminate();
          break;
        case 'ERROR':
          setError(msg.message);
          setRunning(false);
          setStatus('');
          w.terminate();
          break;
      }
    };

    w.postMessage({ type: 'START', payload: { gen, topGraph, bottomGraph } });
  }, [gen, topGraph, bottomGraph, running]);

  const handleStop = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(false);
    setStatus('Stopped by user.');
  }, []);

  const unsupported = gen > 2;

  return (
    <div className="audit-panel">
      <p className="audit-description">
        Runs the naive brute-force solver and the optimized CP solver and check.
        <br />
        <strong>Completeness bug</strong>: naive finds a solution the optimized solver missed.
        <br />
        <strong>Safety bug</strong>: optimized emits a solution the naive solver doesn't validate.
      </p>

      <div className="audit-controls">
        <button
          className="audit-run-btn"
          onClick={handleRun}
          disabled={running || unsupported}
        >
          {running ? 'Running…' : 'Run Audit'}
        </button>
        {running && (
          <button className="audit-stop-btn" onClick={handleStop}>Stop</button>
        )}
        {unsupported && (
          <span className="audit-gen-warn">Only available for gen ≤ 2 (naive solver is too slow for larger graphs)</span>
        )}
      </div>

      {status && <p className="audit-status">{status}</p>}
      {error  && <p className="audit-error">Error: {error}</p>}

      {result && (
        <div className="audit-result">
          {/* Verdict banner */}
          <div className={`audit-verdict ${
            result.missedByOpt.length === 0 && result.falseByOpt.length === 0
              ? 'audit-verdict--ok'
              : 'audit-verdict--fail'
          }`}>
            {result.missedByOpt.length === 0 && result.falseByOpt.length === 0
              ? `✓ Solvers agree — ${result.naiveCount} valid solution${result.naiveCount !== 1 ? 's' : ''}`
              : `✗ Discrepancy detected`}
          </div>

          {/* Summary table */}
          <table className="audit-table">
            <tbody>
              <tr>
                <td>Naive solutions</td>
                <td className="audit-td-num">{result.naiveCount}</td>
              </tr>
              <tr>
                <td>Optimized solutions</td>
                <td className="audit-td-num">
                  {result.optCount}
                  {result.optTimedOut  && <span className="audit-flag"> (timed out)</span>}
                  {!result.optExhausted && !result.optTimedOut && (
                    <span className="audit-flag"> (search not exhausted)</span>
                  )}
                </td>
              </tr>
              <tr>
                <td>Matching</td>
                <td className="audit-td-num">{result.matchCount}</td>
              </tr>
              <tr className={result.missedByOpt.length > 0 ? 'audit-row--bad' : ''}>
                <td>Missed by optimized <span className="audit-label-sub">(completeness bug)</span></td>
                <td className="audit-td-num">{result.missedByOpt.length}</td>
              </tr>
              <tr className={result.falseByOpt.length > 0 ? 'audit-row--bad' : ''}>
                <td>False positives in optimized <span className="audit-label-sub">(safety bug)</span></td>
                <td className="audit-td-num">{result.falseByOpt.length}</td>
              </tr>
            </tbody>
          </table>

          {/* Stats comparison */}
          <div className="audit-stats">
            <div className="audit-stats-col">
              <strong>Naive solver</strong>
              <p>Partial states explored: {result.naiveStats.partialStatesExplored.toLocaleString()}</p>
              <p>Complete matchings evaluated: {result.naiveStats.completeMatchingsEvaluated.toLocaleString()}</p>
            </div>
            <div className="audit-stats-col">
              <strong>Optimized solver</strong>
              <p>Partial states explored: {result.optStats.partialStatesExplored.toLocaleString()}</p>
              <p>Complete matchings evaluated: {result.optStats.completeMatchingsEvaluated.toLocaleString()}</p>
            </div>
          </div>

          {/* Discrepancy details */}
          {result.missedByOpt.length > 0 && (
            <div className="audit-discrepancy">
              <p className="audit-discrepancy-title">
                Solutions found by naive but not by optimized ({result.missedByOpt.length}):
              </p>
              {result.missedByOpt.slice(0, 5).map((sol, i) => (
                <div key={i} className="audit-sol-card">
                  {sol.connections.map((c, j) => (
                    <span key={j} className="audit-conn">
                      {c.from.replace(/^[^-]+-/, '')}→{c.to.replace(/^[^-]+-/, '')}:{c.color}
                    </span>
                  ))}
                </div>
              ))}
              {result.missedByOpt.length > 5 && (
                <p className="audit-more">…and {result.missedByOpt.length - 5} more</p>
              )}
            </div>
          )}

          {result.falseByOpt.length > 0 && (
            <div className="audit-discrepancy audit-discrepancy--false">
              <p className="audit-discrepancy-title">
                False positives in optimized ({result.falseByOpt.length}):
              </p>
              {result.falseByOpt.slice(0, 5).map((sol, i) => (
                <div key={i} className="audit-sol-card">
                  {sol.connections.map((c, j) => (
                    <span key={j} className="audit-conn">
                      {c.from.replace(/^[^-]+-/, '')}→{c.to.replace(/^[^-]+-/, '')}:{c.color}
                    </span>
                  ))}
                </div>
              ))}
              {result.falseByOpt.length > 5 && (
                <p className="audit-more">…and {result.falseByOpt.length - 5} more</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
