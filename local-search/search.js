// search.js — Local random graph search runner.
//
// Runs the exact same algorithm as the browser worker (CHECK_CAP=10,000,
// Rules A + B + C, integer adjacency, pre-allocated DFS buffers, LCG RNG).
// No browser, no Render, no backend required.
//
// Usage:
//   node search.js --gen 2             start fresh for generation 2
//   node search.js --gen 2 --resume    resume from saved checkpoint
//   node search.js --gen 3             start fresh for generation 3
//
// Output files (in ./output/):
//   solutions-gen{N}.json    valid solutions — import these into the Vercel UI
//   checkpoint-gen{N}.json   progress checkpoint (used by --resume)
//
// Press Ctrl+C at any time to stop. Progress is saved automatically.
'use strict';

const fs              = require('fs');
const path            = require('path');
const { performance } = require('perf_hooks');
const { generateGraph } = require('./graphGenerator.js');

// ── Parse command-line arguments ──────────────────────────────────────────────
const args   = process.argv.slice(2);
const genIdx = args.indexOf('--gen');
const GEN    = genIdx >= 0 ? parseInt(args[genIdx + 1], 10) : 2;
const RESUME = args.includes('--resume');

if (isNaN(GEN) || GEN < 1 || GEN > 10) {
  console.error('Error: --gen must be a number from 1 to 10.');
  console.error('Usage: node search.js --gen 2 [--resume]');
  process.exit(1);
}

// ── Output files ──────────────────────────────────────────────────────────────
const OUT_DIR         = path.join(__dirname, 'output');
const CHECKPOINT_FILE = path.join(OUT_DIR, `checkpoint-gen${GEN}.json`);
const SOLUTIONS_FILE  = path.join(OUT_DIR, `solutions-gen${GEN}.json`);

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Constants (must match browser worker exactly) ─────────────────────────────
const COLORS     = ['red', 'green', 'blue'];
const COLOR_CHAR = 'rgb';           // int 0/1/2 → char used in fingerprint strings
const INNER_N    = 1_000;           // iterations between stop-flag checks and time reads
const CHECK_CAP  = 10_000;          // max cycle paths per edge — matches validateGraph.ts
const CHECKPOINT_INTERVAL = 20_000_000;
const STATUS_INTERVAL_MS  = 5 * 60 * 1000; // 5-minute heartbeat

const MAX_NODES = 512;
const MAX_DEG   = 8;
const MAX_DEPTH = 256;

// ── Flat integer adjacency (no Map, no object allocation in hot path) ─────────
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

// ── Pre-allocated DFS scratch (reused every attempt — no heap alloc in loop) ──
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

// O(L²) — finds index of lexicographically smallest rotation, no allocation.
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

// Rule B + C inline check — returns fingerprint string or '' on violation.
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

  // Rule B: dihedral duplicate?
  if (fpSet.has(fp)) return '';

  // Rule C: even-length AND mirror-symmetric?
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

// DFS: finds all simple paths from `to` back to `from`, validates each cycle.
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

// ── LCG RNG (faster than Math.random() in tight loops) ────────────────────────
let seed = 0;
function randInt(n) {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return ((seed >>> 0) / 0x100000000 * n) | 0;
}

// ── Per-attempt typed arrays ───────────────────────────────────────────────────
let N = 0;
let pairsTop, pairsBot, pairsCol, perm, fpsBuf;
let topFrontierIdx, botFrontierIdx, parentColorI, nodeIdxToId;

function shuffle() {
  for (let i = N - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
}

// One random attempt: Phase 1 (matching + Rule A), Phase 2 (Rules B + C).
// Returns true = valid, adj has all N cross-edges committed.
// Returns false = invalid, adj restored to tree-only state.
function tryOne() {
  shuffle();

  // Phase 1: assign random matching, pick colors via bitmask (Rule A).
  for (let i = 0; i < N; i++) {
    const topIdx = topFrontierIdx[i];
    const botIdx = botFrontierIdx[perm[i]];
    const ft = parentColorI[topIdx]; // 255 = no constraint
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

  // Phase 2: incremental cycle validation (Rules B + C).
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

// Canonical dedup key for solutions (sorted, order-independent).
function solutionKey() {
  const parts = new Array(N);
  for (let i = 0; i < N; i++) {
    parts[i] = `${nodeIdxToId[pairsTop[i]]}|${nodeIdxToId[pairsBot[i]]}|${COLORS[pairsCol[i]]}`;
  }
  return parts.sort().join('~');
}

// ── File I/O ──────────────────────────────────────────────────────────────────
function loadSolutionsFile() {
  try {
    if (fs.existsSync(SOLUTIONS_FILE))
      return JSON.parse(fs.readFileSync(SOLUTIONS_FILE, 'utf8'));
  } catch { /* ignore */ }
  return [];
}

function saveSolutionsFile(solutions) {
  fs.writeFileSync(SOLUTIONS_FILE, JSON.stringify(solutions, null, 2));
}

function loadCheckpointFile() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE))
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

function saveCheckpointFile(attempts, validFound) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    gen: GEN, attempts, validFound, timestamp: Date.now(),
  }));
}

// ── Formatters for console output ─────────────────────────────────────────────
function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtRate(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M/s`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k/s`;
  return `${n}/s`;
}

function fmtTime(sec) {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log(`  Graph Random Search — Generation ${GEN}`);
  console.log('══════════════════════════════════════════════');

  // ── Build graphs ───────────────────────────────────────────────────────────
  const topGraph    = generateGraph(GEN, 'top');
  const bottomGraph = generateGraph(GEN, 'bot');

  const allNodes = [...topGraph.nodes, ...bottomGraph.nodes];
  const idToIdx  = new Map();
  nodeIdxToId    = [];
  for (const n of allNodes) {
    idToIdx.set(n.id, nodeIdxToId.length);
    nodeIdxToId.push(n.id);
  }
  const nodeCount = nodeIdxToId.length;

  // parentColorI: Rule A constraint per frontier node (255 = no constraint).
  parentColorI = new Uint8Array(nodeCount).fill(255);
  const colorToInt = { red: 0, green: 1, blue: 2 };

  for (const e of topGraph.edges) {
    const tid  = idToIdx.get(e.targetId);
    const node = topGraph.nodes.find(n => n.id === e.targetId);
    if (tid !== undefined && node && node.isFrontier) parentColorI[tid] = colorToInt[e.color];
  }
  for (const e of bottomGraph.edges) {
    const tid  = idToIdx.get(e.targetId);
    const node = bottomGraph.nodes.find(n => n.id === e.targetId);
    if (tid !== undefined && node && node.isFrontier) parentColorI[tid] = colorToInt[e.color];
  }

  // Build adjacency from tree edges only (cross-edges added per attempt).
  adjDeg.fill(0, 0, nodeCount);
  for (const e of topGraph.edges)
    adjAddI(idToIdx.get(e.sourceId), idToIdx.get(e.targetId), colorToInt[e.color]);
  for (const e of bottomGraph.edges)
    adjAddI(idToIdx.get(e.sourceId), idToIdx.get(e.targetId), colorToInt[e.color]);

  const topFront = topGraph.nodes.filter(n => n.isFrontier);
  const botFront = bottomGraph.nodes.filter(n => n.isFrontier);
  N = topFront.length;

  if (N === 0 || N !== botFront.length) {
    console.error(`Error: frontier count mismatch (top=${N}, bot=${botFront.length})`);
    process.exit(1);
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

  // ── Load existing solutions (for dedup) ────────────────────────────────────
  const solutions = loadSolutionsFile();
  const seenKeys  = new Set(solutions.map(s =>
    s.connections.map(c => `${c.from}|${c.to}|${c.color}`).sort().join('~')
  ));

  // ── Load checkpoint if resuming ────────────────────────────────────────────
  let baseAttempts = 0;
  if (RESUME) {
    const ckpt = loadCheckpointFile();
    if (ckpt && ckpt.gen === GEN) {
      baseAttempts = ckpt.attempts ?? 0;
      console.log(`Resuming from checkpoint: ${fmt(baseAttempts)} attempts, ${solutions.length} solutions found`);
    } else {
      console.log('No checkpoint found for this gen, starting fresh.');
    }
  } else {
    console.log(`Starting fresh. ${solutions.length} solutions already in file.`);
  }

  const topFrontierCount = topFront.length;
  console.log(`Frontier nodes: ${topFrontierCount} top, ${botFront.length} bottom`);
  console.log(`Output: ${SOLUTIONS_FILE}`);
  console.log('Press Ctrl+C to stop and save progress.');
  console.log('');

  // ── Randomise seed ─────────────────────────────────────────────────────────
  seed = (Date.now() ^ (Math.random() * 0x80000000 | 0)) | 0;

  // ── Search state ───────────────────────────────────────────────────────────
  let attempts         = 0;
  let validFound       = solutions.length;
  let stopped          = false;
  const startTime      = performance.now();
  let lastStatusTime = startTime; // tracks 5-minute heartbeat
  let nextCheckpoint   = (Math.floor(baseAttempts / CHECKPOINT_INTERVAL) + 1)
                         * CHECKPOINT_INTERVAL - baseAttempts;
  if (nextCheckpoint <= 0) nextCheckpoint = CHECKPOINT_INTERVAL;

  // ── Graceful shutdown on Ctrl+C ────────────────────────────────────────────
  process.on('SIGINT', () => {
    stopped = true; // picked up at the next INNER_N boundary
  });

  // ── Tight search loop ──────────────────────────────────────────────────────
  while (!stopped) {
    const blockStart      = performance.now();
    const blockStartAtpts = attempts;

    for (let i = 0; i < INNER_N; i++) {
      attempts++;

      // Checkpoint
      if (attempts === nextCheckpoint) {
        nextCheckpoint += CHECKPOINT_INTERVAL;
        saveCheckpointFile(baseAttempts + attempts, validFound);
        console.log(`  [checkpoint] ${fmt(baseAttempts + attempts)} attempts saved`);
      }

      if (!tryOne()) continue;

      // Valid solution found
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
        const sol = {
          id:          `rand-${Date.now()}-${validFound}`,
          generation:  GEN,
          connections,
          timestamp:   Date.now(),
        };
        solutions.push(sol);
        saveSolutionsFile(solutions);
        console.log(`  ✓ Solution #${validFound} found! (${fmt(baseAttempts + attempts)} attempts)`);
      }

      undoAll();
    }

    // ── 5-minute heartbeat: status line + checkpoint save ────────────────────
    const now     = performance.now();
    const elapsed = (now - startTime) / 1000;
    if (now - lastStatusTime >= STATUS_INTERVAL_MS) {
      lastStatusTime = now;
      const total   = baseAttempts + attempts;
      const avgRate = elapsed > 0.5 ? Math.round(attempts / elapsed) : 0;
      const hh = String(Math.floor(elapsed / 3600)).padStart(2, '0');
      const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
      const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
      saveCheckpointFile(total, validFound);
      console.log(`5min update -> ${fmt(total)} attempts | ${fmtRate(avgRate)} avg | ${validFound} valid | ${hh}:${mm}:${ss} runtime`);
    }
  }

  // ── Stopped ────────────────────────────────────────────────────────────────
  const total   = baseAttempts + attempts;
  const elapsed = (performance.now() - startTime) / 1000;
  saveCheckpointFile(total, validFound);
  saveSolutionsFile(solutions);

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  Stopped.');
  console.log(`  Total attempts : ${fmt(total)}`);
  console.log(`  Valid found    : ${validFound}`);
  console.log(`  Time           : ${fmtTime(elapsed)}`);
  console.log(`  Solutions file : ${SOLUTIONS_FILE}`);
  console.log('══════════════════════════════════════════════');
  console.log('');
  console.log('To import into the UI:');
  console.log('  1. Open the Vercel site');
  console.log('  2. Go to Random Search tab');
  console.log('  3. Click "Import Solutions JSON"');
  console.log(`  4. Select: ${SOLUTIONS_FILE}`);
  console.log('');
  process.exit(0);
}

main();
