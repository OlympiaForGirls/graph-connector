// searchWorker.js — Node.js worker_threads port of randomWorker.ts.
//
// Key optimization vs original: uses SharedArrayBuffer stop flag so the
// search loop NEVER yields to the event loop. The worker runs in a pure
// tight CPU loop and checks the stop flag every INNER_N iterations via
// Atomics.load() — zero setImmediate/setTimeout overhead.
//
// postMessage() in worker_threads is non-blocking (puts data on channel,
// parent processes it on its own event loop), so PROGRESS/SOLUTION/CHECKPOINT
// messages can be sent without yielding.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { performance }             = require('perf_hooks');
const { generateGraph }           = require('./graphGenerator.js');

// SharedArrayBuffer stop flag: stopFlag[0] = 0 → run, 1 → stop.
// Written by the parent thread via Atomics.store(); read here via Atomics.load().
const stopFlag = new Int32Array(workerData.stopBuf);

// ── Constants ─────────────────────────────────────────────────────────────────
const COLORS     = ['red', 'green', 'blue'];
const COLOR_CHAR = 'rgb';
const INNER_N    = 1_000;   // iterations between stop-flag checks and time reads
const CHECK_CAP  = 10_000;  // max cycle paths per edge (matches validateGraph.ts exactly)
const PROGRESS_MS         = 5_000;
const CHECKPOINT_INTERVAL = 20_000_000;

const MAX_NODES = 512;
const MAX_DEG   = 8;
const MAX_DEPTH = 256;

// ── Flat integer adjacency ────────────────────────────────────────────────────
const adjNb  = new Uint16Array(MAX_NODES * MAX_DEG);
const adjCo  = new Uint8Array (MAX_NODES * MAX_DEG);
const adjDeg = new Uint16Array(MAX_NODES);

function adjAddI(a, b, c) {
  const ia = adjDeg[a]++, ib = adjDeg[b]++;
  adjNb[a * MAX_DEG + ia] = b;  adjCo[a * MAX_DEG + ia] = c;
  adjNb[b * MAX_DEG + ib] = a;  adjCo[b * MAX_DEG + ib] = c;
}

function adjRemoveI(a, b, c) {
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

// ── DFS scratch (pre-allocated) ───────────────────────────────────────────────
const dfsVis   = new Uint8Array(MAX_NODES);
const colStack = new Uint8Array(MAX_DEPTH);
const cycleBuf = new Uint8Array(MAX_DEPTH);
const revBuf   = new Uint8Array(MAX_DEPTH);

let dfsFrom      = 0;
let dfsEdgeColor = 0;
let dfsCycCount  = 0;
let dfsBad       = false;
let dfsDepth     = 0;
let curFpBuf;
let fpSet;

function minRotation(arr, len) {
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

function checkCycle(clen) {
  for (let i = 0; i < clen; i++) revBuf[i] = cycleBuf[clen - 1 - i];

  const fwdOff = minRotation(cycleBuf, clen);
  const revOff = minRotation(revBuf,   clen);

  let useRev = false;
  for (let k = 0; k < clen; k++) {
    const a = revBuf  [(revOff + k) % clen];
    const b = cycleBuf[(fwdOff + k) % clen];
    if (a < b) { useRev = true;  break; }
    if (a > b) { useRev = false; break; }
  }
  const src = useRev ? revBuf  : cycleBuf;
  const off = useRev ? revOff  : fwdOff;

  let fp = '';
  for (let i = 0; i < clen; i++) fp += COLOR_CHAR[src[(off + i) % clen]];

  if (fpSet.has(fp)) return '';

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

function dfs(cur) {
  if (dfsBad || dfsCycCount >= CHECK_CAP) return;
  const base = cur * MAX_DEG;
  const deg  = adjDeg[cur];
  for (let i = 0; i < deg; i++) {
    if (dfsBad || dfsCycCount >= CHECK_CAP) return;
    const nb  = adjNb[base + i];
    const col = adjCo[base + i];

    if (nb === dfsFrom) {
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
      dfsVis[nb] = 0;
      if (dfsBad) return;
    }
  }
}

// ── LCG RNG ───────────────────────────────────────────────────────────────────
let seed = 0;
function randInt(n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return ((seed >>> 0) / 0x100000000 * n) | 0;
}

// ── Per-attempt state ─────────────────────────────────────────────────────────
let N = 0;
let pairsTop, pairsBot, pairsCol, perm, fpsBuf;
let topFrontierIdx, botFrontierIdx, parentColorI, nodeIdxToId;

function shuffle() {
  for (let i = N - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
}

function tryOne() {
  shuffle();

  for (let i = 0; i < N; i++) {
    const topIdx = topFrontierIdx[i];
    const botIdx = botFrontierIdx[perm[i]];
    const ft = parentColorI[topIdx];
    const fb = parentColorI[botIdx];
    let mask = 0b111;
    if (ft !== 255) mask &= ~(1 << ft);
    if (fb !== 255) mask &= ~(1 << fb);
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

  fpSet.clear();
  for (let i = 0; i < N; i++) {
    const top = pairsTop[i], bot = pairsBot[i], col = pairsCol[i];

    dfsVis[bot]  = 1;
    dfsFrom      = top;
    dfsEdgeColor = col;
    dfsCycCount  = 0;
    dfsBad       = false;
    dfsDepth     = 0;
    curFpBuf     = fpsBuf[i];
    curFpBuf.length = 0;

    dfs(bot);
    dfsVis[bot] = 0;

    if (dfsBad) {
      for (let j = i - 1; j >= 0; j--) adjRemoveI(pairsTop[j], pairsBot[j], pairsCol[j]);
      return false;
    }

    for (const fp of fpsBuf[i]) fpSet.add(fp);
    adjAddI(top, bot, col);
  }
  return true;
}

function undoAll() {
  for (let i = N - 1; i >= 0; i--) adjRemoveI(pairsTop[i], pairsBot[i], pairsCol[i]);
}

function solutionKey() {
  const parts = new Array(N);
  for (let i = 0; i < N; i++) {
    parts[i] = `${nodeIdxToId[pairsTop[i]]}|${nodeIdxToId[pairsBot[i]]}|${COLORS[pairsCol[i]]}`;
  }
  return parts.sort().join('~');
}

// ── Search state ──────────────────────────────────────────────────────────────
let attempts  = 0;
let validFound = 0;
let seenKeys;
let gen = 0;
let startTime        = 0;
let lastProgressTime = 0;
let nextCheckpoint   = CHECKPOINT_INTERVAL;

// ── Tight search loop — no event-loop yield ───────────────────────────────────
// Runs synchronously forever until stopFlag[0] becomes non-zero.
// Progress/checkpoint/solution messages are sent inline (non-blocking in worker_threads).
function runSearch() {
  while (true) {
    // Inner block: INNER_N attempts between stop-flag checks and time reads.
    const blockStart      = performance.now();
    const blockStartAtpts = attempts;

    for (let i = 0; i < INNER_N; i++) {
      attempts++;

      if (attempts === nextCheckpoint) {
        nextCheckpoint += CHECKPOINT_INTERVAL;
        parentPort.postMessage({ type: 'CHECKPOINT', attempts, validFound });
      }

      if (!tryOne()) continue;

      const key = solutionKey();
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        validFound++;
        const connections = [];
        for (let j = 0; j < N; j++) {
          connections.push({
            from:  nodeIdxToId[pairsTop[j]],
            to:    nodeIdxToId[pairsBot[j]],
            color: COLORS[pairsCol[j]],
          });
        }
        parentPort.postMessage({
          type: 'SOLUTION',
          key,
          solution: {
            id:         `rand-${Date.now()}-${validFound}`,
            generation: gen,
            connections,
            timestamp:  Date.now(),
          },
        });
      }

      undoAll();
    }

    // ── Check stop flag (written by parent via Atomics.store) ─────────────────
    if (Atomics.load(stopFlag, 0) !== 0) {
      parentPort.postMessage({ type: 'STOPPED', attempts, validFound });
      return;
    }

    // ── Progress update ───────────────────────────────────────────────────────
    const now     = performance.now();
    const elapsed = (now - startTime) / 1000;
    if (now - lastProgressTime >= PROGRESS_MS) {
      lastProgressTime = now;
      const blockElap  = (now - blockStart) / 1000;
      const blockDelta = attempts - blockStartAtpts;
      parentPort.postMessage({
        type:                    'PROGRESS',
        attempts,
        validFound,
        attemptsPerSecCurrent:   blockElap > 0 ? Math.round(blockDelta / blockElap) : 0,
        attemptsPerSecAvg:       elapsed   > 0.5 ? Math.round(attempts / elapsed)   : 0,
        uptime:                  elapsed,
      });
    }
  }
}

// ── Worker entry point ────────────────────────────────────────────────────────
parentPort.on('message', (msg) => {
  if (msg.type !== 'START') return;

  const { gen: g, baseAttempts = 0 } = msg;

  gen            = g;
  attempts       = 0;
  validFound     = 0;
  seenKeys       = new Set();
  startTime      = performance.now();
  lastProgressTime = 0;
  nextCheckpoint = (Math.floor(baseAttempts / CHECKPOINT_INTERVAL) + 1) * CHECKPOINT_INTERVAL - baseAttempts;
  if (nextCheckpoint <= 0) nextCheckpoint = CHECKPOINT_INTERVAL;
  seed = (Date.now() ^ (Math.random() * 0x80000000 | 0)) | 0;

  // Build graphs from gen number.
  const topGraph    = generateGraph(gen, 'top');
  const bottomGraph = generateGraph(gen, 'bot');

  const allNodes = [...topGraph.nodes, ...bottomGraph.nodes];
  const idToIdx  = new Map();
  nodeIdxToId    = [];
  for (const n of allNodes) {
    idToIdx.set(n.id, nodeIdxToId.length);
    nodeIdxToId.push(n.id);
  }
  const nodeCount = nodeIdxToId.length;

  parentColorI = new Uint8Array(nodeCount).fill(255);
  const colorToInt = { red: 0, green: 1, blue: 2 };

  for (const e of topGraph.edges) {
    const tid = idToIdx.get(e.targetId);
    const node = topGraph.nodes.find(n => n.id === e.targetId);
    if (tid !== undefined && node && node.isFrontier) parentColorI[tid] = colorToInt[e.color];
  }
  for (const e of bottomGraph.edges) {
    const tid = idToIdx.get(e.targetId);
    const node = bottomGraph.nodes.find(n => n.id === e.targetId);
    if (tid !== undefined && node && node.isFrontier) parentColorI[tid] = colorToInt[e.color];
  }

  adjDeg.fill(0, 0, nodeCount);
  for (const e of topGraph.edges)    adjAddI(idToIdx.get(e.sourceId), idToIdx.get(e.targetId), colorToInt[e.color]);
  for (const e of bottomGraph.edges) adjAddI(idToIdx.get(e.sourceId), idToIdx.get(e.targetId), colorToInt[e.color]);

  const topFront = topGraph.nodes.filter(n => n.isFrontier);
  const botFront = bottomGraph.nodes.filter(n => n.isFrontier);
  N = topFront.length;

  if (N === 0 || N !== botFront.length) {
    parentPort.postMessage({ type: 'STOPPED', attempts: 0, validFound: 0 });
    return;
  }

  topFrontierIdx = new Uint16Array(N);
  botFrontierIdx = new Uint16Array(N);
  for (let i = 0; i < N; i++) topFrontierIdx[i] = idToIdx.get(topFront[i].id);
  for (let i = 0; i < N; i++) botFrontierIdx[i] = idToIdx.get(botFront[i].id);

  pairsTop = new Uint16Array(N);
  pairsBot = new Uint16Array(N);
  pairsCol = new Uint8Array(N);
  perm     = Uint16Array.from({ length: N }, (_, i) => i);
  fpsBuf   = Array.from({ length: N }, () => []);
  fpSet    = new Set();

  runSearch(); // synchronous — runs until stopFlag is set
});
