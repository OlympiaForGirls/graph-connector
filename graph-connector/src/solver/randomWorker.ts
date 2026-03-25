// randomWorker.ts — Monte Carlo random graph search.
//
// Runs a time-sliced batch loop: generate random perfect matchings with random
// colors, validate each one incrementally, emit valid solutions.
//
// ── Performance design ────────────────────────────────────────────────────────
// • Pre-built tree adj (once per START): no Map rebuild on every attempt.
// • Adj add/remove (not clone-per-attempt): O(degree)=O(3) per op vs O(N) clone.
// • Pre-allocated pair/fp arrays: zero allocation in the hot path.
// • Time-based 10ms batches + setTimeout yield: STOP responds within ~10ms.
// • LCG RNG: faster than Math.random() for tight inner loops.
// • Rule A fast-prune in Phase 1: rejects impossible (top,bot) pairs before
//   touching the adj or running any cycle DFS.
// • CHECK_CAP=10,000: matches validateGraph.ts safety-net, catches long cycles
//   (cap 200 is insufficient for gen-4 graphs with many committed cross-edges).
//
// ── Message protocol ──────────────────────────────────────────────────────────
// main → worker: { type:'START', payload:{ gen, topGraph, bottomGraph } }
//                { type:'STOP' }
// worker → main: { type:'ACK' }
//                { type:'SOLUTION', solution: SolutionSnapshot }
//                { type:'PROGRESS', attempts, validFound, attemptsPerSec }
//                { type:'STOPPED', attempts, validFound }

import type { Graph, EdgeColor } from '../types/graph';
import type { SolutionSnapshot, ConnectionSnapshot } from '../types/solution';
import { dihedralCanonical, hasMirrorSymmetry } from '../validation/cycleAnalysis';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = self as any;

const COLORS: EdgeColor[] = ['red', 'green', 'blue'];
const BATCH_MS  = 10;     // run this many ms before yielding to the event loop
const INNER_N   = 50;     // inner iterations between performance.now() checks
const CHECK_CAP = 10_000; // max paths per edge in cycle DFS

// ── Adjacency list ───────────────────────────────────────────────────────────
// Pre-loaded with tree edges at START. Cross-edges are added/removed per attempt.
type AdjEntry = { neighbor: string; color: EdgeColor };
type Adj = Map<string, AdjEntry[]>;
let adj: Adj = new Map();

function adjAdd(a: string, b: string, c: EdgeColor) {
  adj.get(a)!.push({ neighbor: b, color: c });
  adj.get(b)!.push({ neighbor: a, color: c });
}
function adjRemove(a: string, b: string, c: EdgeColor) {
  const strip = (list: AdjEntry[], nb: string) => {
    const i = list.findIndex(e => e.neighbor === nb && e.color === c);
    if (i !== -1) list.splice(i, 1);
  };
  strip(adj.get(a)!, b);
  strip(adj.get(b)!, a);
}

// ── Incremental cycle finder ──────────────────────────────────────────────────
// Finds all simple paths from `to` back to `from` using the current adj
// (before the candidate edge is added). Prepends edgeColor to form cycle seqs.
function newCycles(from: string, to: string, edgeColor: EdgeColor): EdgeColor[][] {
  const out: EdgeColor[][] = [];
  const cols: EdgeColor[]  = [];
  const vis = new Set<string>([to]);
  function dfs(cur: string) {
    for (const { neighbor, color } of adj.get(cur) ?? []) {
      if (out.length >= CHECK_CAP) return;
      if (neighbor === from) { out.push([edgeColor, ...cols, color]); continue; }
      if (!vis.has(neighbor)) {
        vis.add(neighbor); cols.push(color);
        dfs(neighbor);
        cols.pop(); vis.delete(neighbor);
      }
    }
  }
  dfs(to);
  return out;
}

// ── LCG random integer in [0, n) ─────────────────────────────────────────────
let seed = 0;
function randInt(n: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return ((seed >>> 0) / 0x100000000 * n) | 0;
}

// ── Per-attempt state (pre-allocated, reused every attempt) ──────────────────
type Pair = { top: string; bot: string; color: EdgeColor };
let N       = 0;
let pairs:  Pair[];      // one slot per frontier pair, mutated each attempt
let perm:   number[];    // bot-node permutation (Fisher-Yates shuffled in-place)
let fpsBuf: string[][];  // fingerprints committed per edge (pre-allocated, cleared each use)
let fpSet:  Set<string>; // active fingerprints for current attempt

let topFrontier: Array<{ id: string }>;
let botFrontier: Array<{ id: string }>;
let parentColor: Map<string, EdgeColor>;

// In-place Fisher-Yates shuffle of perm[]
function shuffle() {
  for (let i = N - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
}

// ── One random attempt ────────────────────────────────────────────────────────
// Phase 1: assign random matching + colors (Rule A pre-prune only).
// Phase 2: incremental cycle validation.
// Returns true if valid (adj now has all N cross-edges added).
// Returns false if invalid (adj restored to tree-only state).
function tryOne(): boolean {
  shuffle();

  // Phase 1 — random assignment
  for (let i = 0; i < N; i++) {
    const topId = topFrontier[i].id;
    const botId = botFrontier[perm[i]].id;
    const ft    = parentColor.get(topId);
    const fb    = parentColor.get(botId);
    // Random start, step through if blocked by Rule A (parent-edge color conflict)
    let c = randInt(3);
    let ok = false;
    for (let t = 0; t < 3; t++, c = (c + 1) % 3) {
      if (COLORS[c] !== ft && COLORS[c] !== fb) { ok = true; break; }
    }
    if (!ok) return false; // no valid color — skip (no adj mutation needed)
    pairs[i].top   = topId;
    pairs[i].bot   = botId;
    pairs[i].color = COLORS[c];
  }

  // Phase 2 — incremental cycle validation
  fpSet.clear();
  for (let i = 0; i < N; i++) {
    const { top, bot, color } = pairs[i];
    const seqs = newCycles(top, bot, color);

    fpsBuf[i].length = 0;
    let bad = false;
    for (const seq of seqs) {
      const fp = dihedralCanonical(seq);
      if (fpSet.has(fp)) { bad = true; break; }
      if (seq.length % 2 === 0 && hasMirrorSymmetry(seq)) { bad = true; break; }
      fpsBuf[i].push(fp);
    }

    if (bad) {
      // Undo edges 0..i-1 from adj (edge i was never added)
      for (let j = i - 1; j >= 0; j--) adjRemove(pairs[j].top, pairs[j].bot, pairs[j].color);
      return false;
    }

    for (const fp of fpsBuf[i]) fpSet.add(fp);
    adjAdd(top, bot, color);
  }
  return true; // adj has all N cross-edges committed
}

// Remove all N cross-edges after a valid attempt.
function undoAll() {
  for (let i = N - 1; i >= 0; i--) adjRemove(pairs[i].top, pairs[i].bot, pairs[i].color);
}

// ── Solution dedup key ────────────────────────────────────────────────────────
// Sorted so the key is order-independent (matching the audit worker's approach).
function solutionKey(): string {
  return pairs.map(p => `${p.top}|${p.bot}|${p.color}`).sort().join('~');
}

// ── Search state ──────────────────────────────────────────────────────────────
let stopped    = false;
let attempts   = 0;
let validFound = 0;
let seenKeys:  Set<string>;
let gen        = 0;
let startTime  = 0;

// ── Batch runner ──────────────────────────────────────────────────────────────
function runBatch() {
  if (stopped) {
    ctx.postMessage({ type: 'STOPPED', attempts, validFound });
    return;
  }

  const t0 = performance.now();
  outer:
  while (performance.now() - t0 < BATCH_MS) {
    for (let i = 0; i < INNER_N; i++) {
      if (stopped) break outer;
      attempts++;

      if (!tryOne()) continue;

      // Valid solution — check dedup
      const key = solutionKey();
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        validFound++;
        const connections: ConnectionSnapshot[] = pairs.map(p => ({
          from: p.top, to: p.bot, color: p.color,
        }));
        const snap: SolutionSnapshot = {
          id:          `rand-${Date.now()}-${validFound}`,
          generation:  gen,
          connections,
          timestamp:   Date.now(),
        };
        ctx.postMessage({ type: 'SOLUTION', solution: snap });
      }

      undoAll(); // restore adj to tree-only for next attempt
    }
  }

  const elapsed = (performance.now() - startTime) / 1000;
  ctx.postMessage({
    type:            'PROGRESS',
    attempts,
    validFound,
    attemptsPerSec:  elapsed > 0.5 ? Math.round(attempts / elapsed) : 0,
  });

  setTimeout(runBatch, 0); // yield to event loop (allows STOP to be processed)
}

// ── Worker entry point ────────────────────────────────────────────────────────
ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; payload?: any };

  if (msg.type === 'STOP') {
    stopped = true;
    return;
  }

  if (msg.type !== 'START') return;

  const { gen: g, topGraph, bottomGraph } = msg.payload as {
    gen: number; topGraph: Graph; bottomGraph: Graph;
  };

  gen       = g;
  stopped   = false;
  attempts  = 0;
  validFound = 0;
  seenKeys  = new Set();
  startTime = performance.now();
  seed      = (Date.now() ^ (Math.random() * 0x80000000 | 0)) | 0;

  topFrontier = topGraph.nodes.filter(n => n.isFrontier);
  botFrontier = bottomGraph.nodes.filter(n => n.isFrontier);
  N           = topFrontier.length;

  // Build parent colors (Rule A: frontier node's parent-edge color is forbidden)
  parentColor = new Map();
  const fids = new Set([...topFrontier, ...botFrontier].map(n => n.id));
  for (const e of topGraph.edges)    if (fids.has(e.targetId)) parentColor.set(e.targetId, e.color);
  for (const e of bottomGraph.edges) if (fids.has(e.targetId)) parentColor.set(e.targetId, e.color);

  // Build tree-only adj (cross-edges added/removed per attempt during search)
  adj = new Map();
  for (const n of topGraph.nodes)    adj.set(n.id, []);
  for (const n of bottomGraph.nodes) adj.set(n.id, []);
  for (const e of topGraph.edges)    adjAdd(e.sourceId, e.targetId, e.color);
  for (const e of bottomGraph.edges) adjAdd(e.sourceId, e.targetId, e.color);

  // Pre-allocate per-attempt buffers (reused every iteration)
  perm   = Array.from({ length: N }, (_, i) => i);
  pairs  = Array.from({ length: N }, () => ({ top: '', bot: '', color: 'red' as EdgeColor }));
  fpsBuf = Array.from({ length: N }, () => []);
  fpSet  = new Set();

  ctx.postMessage({ type: 'ACK' });

  if (N === 0 || N !== botFrontier.length) {
    ctx.postMessage({ type: 'STOPPED', attempts: 0, validFound: 0 });
    return;
  }

  setTimeout(runBatch, 0);
};
