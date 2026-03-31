// randomWorker.ts — Optimized Monte Carlo random graph search.
//
// Hot-path allocations eliminated vs original:
//   • Integer node indices: no string-keyed Map in hot path.
//   • Flat Uint16/Uint8Array adj: no Map<string,…> or AdjEntry objects per node.
//   • DFS vis as Uint8Array with mark/unmark: no `new Set()` per edge.
//   • Cycle built into pre-allocated cycleBuf/revBuf: no EdgeColor[][] ever created.
//   • checkCycle() inline: Rule B+C without any slice/spread/reverse allocation.
//     Fingerprint string built once per cycle (unavoidable), zero intermediate arrays.
//   • parentColorI as Uint8Array: no Map<string,EdgeColor> lookup in hot path.
//   • pairsTop/Bot/Col as typed arrays: no Pair[] object allocation.
//   • Progress throttled to 250ms: ~4× fewer React re-renders vs 10ms.
//
// Correctness identical to original: CHECK_CAP=10_000, Rule A+B+C.
//
// Message protocol:
//   main → worker:  { type:'START', payload:{ gen, topGraph, bottomGraph } }
//                   { type:'STOP' }
//   worker → main:  { type:'ACK' }
//                   { type:'SOLUTION', solution: SolutionSnapshot }
//                   { type:'PROGRESS', attempts, validFound,
//                       attemptsPerSecCurrent, attemptsPerSecAvg,
//                       uptime, uiUpdates, avgBatchSize }
//                   { type:'STOPPED', attempts, validFound }

import type { Graph, EdgeColor } from '../types/graph';
import type { SolutionSnapshot, ConnectionSnapshot } from '../types/solution';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = self as any;

// ── Constants ────────────────────────────────────────────────────────────────
const COLORS: EdgeColor[]  = ['red', 'green', 'blue'];
const COLOR_CHAR           = 'rgb'; // int 0/1/2 → char for fp strings
const BATCH_MS             = 100;   // ms per time-slice before yielding (longer = fewer setTimeout round-trips)
const INNER_N              = 200;   // inner iters between perf.now() checks (fewer clock calls)
const CHECK_CAP            = 10_000;// max cycles per edge (matches validateGraph.ts)
const PROGRESS_MS          = 60_000;// 1 minute between PROGRESS postMessages

const MAX_NODES = 512;
const MAX_DEG   = 8;   // max adj degree per node (tree-leaf: 1 tree + 1 cross edge)
const MAX_DEPTH = 256; // max DFS path depth

// ── Flat integer adjacency ───────────────────────────────────────────────────
// adjNb[n*MAX_DEG + i] = integer index of i-th neighbor of node n
// adjCo[n*MAX_DEG + i] = color (0/1/2) of that edge
// adjDeg[n]            = current degree of node n
const adjNb  = new Uint16Array(MAX_NODES * MAX_DEG);
const adjCo  = new Uint8Array (MAX_NODES * MAX_DEG);
const adjDeg = new Uint16Array(MAX_NODES);

function adjAddI(a: number, b: number, c: number): void {
  const ia = adjDeg[a]++, ib = adjDeg[b]++;
  adjNb[a * MAX_DEG + ia] = b;  adjCo[a * MAX_DEG + ia] = c;
  adjNb[b * MAX_DEG + ib] = a;  adjCo[b * MAX_DEG + ib] = c;
}

function adjRemoveI(a: number, b: number, c: number): void {
  // Swap-with-last removal (no gap left in array).
  const baseA = a * MAX_DEG, dA = --adjDeg[a];
  for (let i = 0; i <= dA; i++) {
    if (adjNb[baseA + i] === b && adjCo[baseA + i] === c) {
      adjNb[baseA + i] = adjNb[baseA + dA];
      adjCo[baseA + i] = adjCo[baseA + dA];
      break;
    }
  }
  const baseB = b * MAX_DEG, dB = --adjDeg[b];
  for (let i = 0; i <= dB; i++) {
    if (adjNb[baseB + i] === a && adjCo[baseB + i] === c) {
      adjNb[baseB + i] = adjNb[baseB + dB];
      adjCo[baseB + i] = adjCo[baseB + dB];
      break;
    }
  }
}

// ── DFS scratch (pre-allocated, reused every edge) ───────────────────────────
// No allocations in the DFS hot path. dfsVis mark/unmark is done via backtracking,
// so it remains consistent even on early exit (dfsBad=true unwinds cleanly).
const dfsVis   = new Uint8Array(MAX_NODES); // 1 = on current path, 0 = not
const colStack = new Uint8Array(MAX_DEPTH); // color at each DFS depth
const cycleBuf = new Uint8Array(MAX_DEPTH); // assembled cycle colors
const revBuf   = new Uint8Array(MAX_DEPTH); // reversed cycle (for canonical/mirror)

let dfsFrom      = 0;
let dfsEdgeColor = 0;  // color int of the candidate edge (prepended to cycle)
let dfsCycCount  = 0;  // cycles found so far this edge (capped at CHECK_CAP)
let dfsBad       = false;
let dfsDepth     = 0;
let curFpBuf: string[]; // points to fpsBuf[i] for the current edge

// ── minRotation: index of lexicographically smallest rotation (O(L²), no alloc) ──
function minRotation(arr: Uint8Array, len: number): number {
  let best = 0;
  outer:
  for (let r = 1; r < len; r++) {
    for (let k = 0; k < len; k++) {
      const a = arr[(r    + k) % len];
      const b = arr[(best + k) % len];
      if (a < b) { best = r; continue outer; }
      if (a > b) continue outer;
    }
  }
  return best;
}

// ── checkCycle: inline Rule B + C, no intermediate arrays ───────────────────
// cycleBuf[0..clen-1] must be filled before calling.
// Returns: non-empty fingerprint string = cycle is valid and new.
//          '' (empty string) = Rule B or C violation → dfsBad should be set.
function checkCycle(clen: number): string {
  // Build reversed cycle in revBuf.
  for (let i = 0; i < clen; i++) revBuf[i] = cycleBuf[clen - 1 - i];

  // Dihedral canonical = min rotation of (cycleBuf, revBuf).
  const fwdOff = minRotation(cycleBuf, clen);
  const revOff = minRotation(revBuf,   clen);

  // Determine which (fwd@fwdOff or rev@revOff) is lexicographically smaller.
  let useRev = false;
  for (let k = 0; k < clen; k++) {
    const a = revBuf[(revOff + k) % clen];
    const b = cycleBuf[(fwdOff + k) % clen];
    if (a < b) { useRev = true;  break; }
    if (a > b) { useRev = false; break; }
  }
  const src = useRev ? revBuf  : cycleBuf;
  const off = useRev ? revOff  : fwdOff;

  // Build fingerprint string: one char per color, no intermediate arrays.
  let fp = '';
  for (let i = 0; i < clen; i++) fp += COLOR_CHAR[src[(off + i) % clen]];

  // Rule B: dihedral duplicate?
  if (fpSet.has(fp)) return '';

  // Rule C: even-length + mirror-symmetric?
  // Mirror symmetry: canonicalRotation(fwd) === canonicalRotation(rev).
  // fwdOff IS minRotation(cycleBuf) and revOff IS minRotation(revBuf), so
  // we just compare them directly.
  if (clen % 2 === 0) {
    let mirror = true;
    for (let k = 0; k < clen; k++) {
      if (cycleBuf[(fwdOff + k) % clen] !== revBuf[(revOff + k) % clen]) {
        mirror = false;
        break;
      }
    }
    if (mirror) return '';
  }

  return fp;
}

// ── DFS: finds all simple paths from `to` back to `from` ────────────────────
// For each path found, builds the cycle inline and calls checkCycle.
// Sets dfsBad=true and returns immediately on violation.
// Backtracking correctly restores dfsVis even on early exit.
function dfs(cur: number): void {
  if (dfsBad || dfsCycCount >= CHECK_CAP) return;
  const base = cur * MAX_DEG;
  const deg  = adjDeg[cur];
  for (let i = 0; i < deg; i++) {
    if (dfsBad || dfsCycCount >= CHECK_CAP) return;
    const nb  = adjNb[base + i];
    const col = adjCo[base + i];

    if (nb === dfsFrom) {
      // Cycle: [dfsEdgeColor, colStack[0..dfsDepth-1], col]
      dfsCycCount++;
      const clen = dfsDepth + 2;
      cycleBuf[0] = dfsEdgeColor;
      for (let j = 0; j < dfsDepth; j++) cycleBuf[j + 1] = colStack[j];
      cycleBuf[dfsDepth + 1] = col;
      const fp = checkCycle(clen);
      if (fp === '') { dfsBad = true; return; }
      curFpBuf.push(fp);
      continue;
    }

    if (!dfsVis[nb]) {
      dfsVis[nb] = 1;
      colStack[dfsDepth++] = col;
      dfs(nb);
      dfsDepth--;
      dfsVis[nb] = 0; // always executed on backtrack (even after dfsBad unwind)
      if (dfsBad) return;
    }
  }
}

// ── LCG RNG (faster than Math.random() for tight loops) ──────────────────────
let seed = 0;
function randInt(n: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return ((seed >>> 0) / 0x100000000 * n) | 0;
}

// ── Per-attempt state (typed arrays, zero allocation in hot path) ─────────────
let N            = 0;
let pairsTop:    Uint16Array;  // top node index for each pair
let pairsBot:    Uint16Array;  // bot node index for each pair
let pairsCol:    Uint8Array;   // color (0/1/2) for each pair
let perm:        Uint16Array;  // bot permutation (shuffled in-place)
let fpsBuf:      string[][];   // fps per edge (pre-allocated inner arrays)
let fpSet:       Set<string>;  // active fps for current attempt

let topFrontierIdx: Uint16Array; // integer indices of top frontier nodes
let botFrontierIdx: Uint16Array; // integer indices of bot frontier nodes
let parentColorI:   Uint8Array;  // 255=no constraint, 0/1/2=red/green/blue
let nodeIdxToId:    string[];    // integer index → node ID string

// In-place Fisher-Yates shuffle of perm[0..N-1].
function shuffle(): void {
  for (let i = N - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
}

// ── One random attempt ────────────────────────────────────────────────────────
// Phase 1: assign random bipartite matching + colors (Rule A pre-prune only).
// Phase 2: incremental cycle validation (Rule B + C).
// Returns true = valid (adj now has all N cross-edges added).
// Returns false = invalid (adj restored to tree-only state).
function tryOne(): boolean {
  shuffle();

  // Phase 1 — random assignment with Rule A
  // Valid colors = {0,1,2} minus parent-edge colors of top and bot.
  // Since each node blocks at most 1 color, the valid mask always has ≥1 bit set.
  for (let i = 0; i < N; i++) {
    const topIdx = topFrontierIdx[i];
    const botIdx = botFrontierIdx[perm[i]];
    const ft = parentColorI[topIdx]; // 255=none, 0/1/2
    const fb = parentColorI[botIdx];
    // Build a 3-bit valid mask, then pick uniformly from the set bits.
    let mask = 0b111;
    if (ft !== 255) mask &= ~(1 << ft);
    if (fb !== 255) mask &= ~(1 << fb);
    // Count valid colors (always 1, 2, or 3).
    const cnt = (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1);
    let pick = randInt(cnt);
    let c = 0;
    for (let v = 0; v < 3; v++) {
      if (mask & (1 << v)) { if (pick === 0) { c = v; break; } pick--; }
    }
    pairsTop[i] = topIdx;
    pairsBot[i] = botIdx;
    pairsCol[i] = c;
  }

  // Phase 2 — incremental validation
  fpSet.clear();
  for (let i = 0; i < N; i++) {
    const top = pairsTop[i], bot = pairsBot[i], col = pairsCol[i];

    // Run DFS to find all new cycles and validate them inline.
    dfsVis[bot] = 1; // mark starting node (`to`)
    dfsFrom      = top;
    dfsEdgeColor = col;
    dfsCycCount  = 0;
    dfsBad       = false;
    dfsDepth     = 0;
    curFpBuf     = fpsBuf[i];
    curFpBuf.length = 0;

    dfs(bot);

    dfsVis[bot] = 0; // unmark starting node

    if (dfsBad) {
      // Undo adj mutations for edges 0..i-1 (edge i was never added).
      for (let j = i - 1; j >= 0; j--) adjRemoveI(pairsTop[j], pairsBot[j], pairsCol[j]);
      return false;
    }

    // Commit this edge's fingerprints to the global set.
    for (const fp of fpsBuf[i]) fpSet.add(fp);
    adjAddI(top, bot, col);
  }
  return true; // all N cross-edges are now in adj
}

// Remove all N cross-edges after a valid attempt.
function undoAll(): void {
  for (let i = N - 1; i >= 0; i--) adjRemoveI(pairsTop[i], pairsBot[i], pairsCol[i]);
}

// Solution dedup key: sorted canonical strings (order-independent).
function solutionKey(): string {
  const parts = new Array<string>(N);
  for (let i = 0; i < N; i++) {
    parts[i] = `${nodeIdxToId[pairsTop[i]]}|${nodeIdxToId[pairsBot[i]]}|${COLORS[pairsCol[i]]}`;
  }
  return parts.sort().join('~');
}

// ── Search state ──────────────────────────────────────────────────────────────
let stopped     = false;
let attempts    = 0;
let validFound  = 0;
let seenKeys:   Set<string>;
let gen         = 0;
let startTime   = 0;

// Metrics
let lastProgressTime = 0;
let uiUpdates        = 0;
let batchCount       = 0;

// Checkpoint: send CHECKPOINT when (baseAttempts + attempts) hits a 20M multiple.
// nextCheckpoint is the local-attempts value at which the next boundary is crossed.
const CHECKPOINT_INTERVAL = 20_000_000;
let nextCheckpoint = CHECKPOINT_INTERVAL; // reset at START

// ── Batch runner ──────────────────────────────────────────────────────────────
function runBatch(): void {
  if (stopped) {
    ctx.postMessage({ type: 'STOPPED', attempts, validFound });
    return;
  }

  const batchStart      = performance.now();
  const batchStartAtpts = attempts;

  outer:
  while (performance.now() - batchStart < BATCH_MS) {
    for (let i = 0; i < INNER_N; i++) {
      if (stopped) break outer;
      attempts++;

      // Checkpoint: fires when total (base + local) crosses a 20M multiple.
      if (attempts === nextCheckpoint) {
        nextCheckpoint += CHECKPOINT_INTERVAL;
        ctx.postMessage({ type: 'CHECKPOINT', attempts, validFound });
      }

      if (!tryOne()) continue;

      // Valid — dedup check
      const key = solutionKey();
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        validFound++;
        const connections: ConnectionSnapshot[] = [];
        for (let j = 0; j < N; j++) {
          connections.push({ from: nodeIdxToId[pairsTop[j]], to: nodeIdxToId[pairsBot[j]], color: COLORS[pairsCol[j]] });
        }
        const snap: SolutionSnapshot = {
          id:         `rand-${Date.now()}-${validFound}`,
          generation: gen,
          connections,
          timestamp:  Date.now(),
        };
        ctx.postMessage({ type: 'SOLUTION', solution: snap });
      }

      undoAll();
    }
  }

  batchCount++;
  const now        = performance.now();
  const elapsed    = (now - startTime) / 1000;
  const batchElap  = (now - batchStart) / 1000;
  const batchDelta = attempts - batchStartAtpts;

  if (now - lastProgressTime >= PROGRESS_MS) {
    lastProgressTime = now;
    uiUpdates++;
    ctx.postMessage({
      type:                    'PROGRESS',
      attempts,
      validFound,
      attemptsPerSecCurrent:   batchElap > 0 ? Math.round(batchDelta / batchElap) : 0,
      attemptsPerSecAvg:       elapsed   > 0.5 ? Math.round(attempts / elapsed) : 0,
      uptime:                  elapsed,
      uiUpdates,
      avgBatchSize:            Math.round(attempts / batchCount),
    });
  }

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

  const { gen: g, topGraph, bottomGraph, baseAttempts = 0 } = msg.payload as {
    gen: number; topGraph: Graph; bottomGraph: Graph; baseAttempts?: number;
  };

  gen        = g;
  stopped    = false;
  attempts   = 0;
  validFound = 0;
  seenKeys   = new Set();
  startTime  = performance.now();
  lastProgressTime = 0;
  uiUpdates        = 0;
  batchCount       = 0;
  // First checkpoint: at the local-attempts value that brings the total to the
  // next 20M multiple above baseAttempts.
  nextCheckpoint = (Math.floor(baseAttempts / CHECKPOINT_INTERVAL) + 1) * CHECKPOINT_INTERVAL - baseAttempts;
  seed = (Date.now() ^ (Math.random() * 0x80000000 | 0)) | 0;

  // Build integer node index mapping.
  const allNodes = [...topGraph.nodes, ...bottomGraph.nodes];
  const idToIdx  = new Map<string, number>();
  nodeIdxToId    = [];
  for (const n of allNodes) {
    idToIdx.set(n.id, nodeIdxToId.length);
    nodeIdxToId.push(n.id);
  }
  const nodeCount = nodeIdxToId.length;

  // Build parentColorI (Rule A: frontier node's single tree parent-edge color).
  parentColorI = new Uint8Array(nodeCount).fill(255); // 255 = no constraint
  const colorToInt: Record<string, number> = { red: 0, green: 1, blue: 2 };
  const frontierIds = new Set<number>();
  for (const n of topGraph.nodes)    if (n.isFrontier) frontierIds.add(idToIdx.get(n.id)!);
  for (const n of bottomGraph.nodes) if (n.isFrontier) frontierIds.add(idToIdx.get(n.id)!);
  for (const e of topGraph.edges) {
    const tid = idToIdx.get(e.targetId);
    if (tid !== undefined && frontierIds.has(tid)) parentColorI[tid] = colorToInt[e.color];
  }
  for (const e of bottomGraph.edges) {
    const tid = idToIdx.get(e.targetId);
    if (tid !== undefined && frontierIds.has(tid)) parentColorI[tid] = colorToInt[e.color];
  }

  // Build integer adjacency (tree edges only; cross-edges added per attempt).
  adjDeg.fill(0, 0, nodeCount);
  for (const e of topGraph.edges) {
    adjAddI(idToIdx.get(e.sourceId)!, idToIdx.get(e.targetId)!, colorToInt[e.color]);
  }
  for (const e of bottomGraph.edges) {
    adjAddI(idToIdx.get(e.sourceId)!, idToIdx.get(e.targetId)!, colorToInt[e.color]);
  }

  // Frontier index arrays.
  const topFront = topGraph.nodes.filter(n => n.isFrontier);
  const botFront = bottomGraph.nodes.filter(n => n.isFrontier);
  N = topFront.length;

  topFrontierIdx = new Uint16Array(N);
  botFrontierIdx = new Uint16Array(N);
  for (let i = 0; i < N; i++) topFrontierIdx[i] = idToIdx.get(topFront[i].id)!;
  for (let i = 0; i < N; i++) botFrontierIdx[i] = idToIdx.get(botFront[i].id)!;

  // Pre-allocated per-attempt buffers.
  pairsTop = new Uint16Array(N);
  pairsBot = new Uint16Array(N);
  pairsCol = new Uint8Array(N);
  perm     = Uint16Array.from({ length: N }, (_, i) => i);
  fpsBuf   = Array.from({ length: N }, () => [] as string[]);
  fpSet    = new Set();

  ctx.postMessage({ type: 'ACK' });

  if (N === 0 || N !== botFront.length) {
    ctx.postMessage({ type: 'STOPPED', attempts: 0, validFound: 0 });
    return;
  }

  setTimeout(runBatch, 0);
};
