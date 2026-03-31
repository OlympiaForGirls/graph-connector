// server.js — Express API for the graph-connector random search backend.
//
// Endpoints:
//   POST /start-random-search  { gen: number }  → starts (or resumes) the search
//   POST /stop-random-search                     → gracefully stops the worker
//   POST /reset-random-search                    → stop + clear all state + delete files
//   GET  /random-search-status                   → current stats
//   GET  /random-search-solutions                → all found solutions for current gen
//   GET  /health                                 → liveness check
'use strict';

const express      = require('express');
const cors         = require('cors');
const { Worker }   = require('worker_threads');
const fs           = require('fs');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Data directory (for file-based persistence) ────────────────────────────────
const DATA_DIR        = path.join(__dirname, 'data');
const CHECKPOINT_FILE = path.join(DATA_DIR, 'checkpoint.json');
const SOLUTIONS_FILE  = path.join(DATA_DIR, 'solutions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Shared state ───────────────────────────────────────────────────────────────
const state = {
  running:               false,
  gen:                   null,
  baseAttempts:          0,     // attempts before this worker run started
  attempts:              0,     // total attempts (baseAttempts + worker-local)
  validFound:            0,
  attemptsPerSecCurrent: 0,
  attemptsPerSecAvg:     0,
  uptime:                0,
  solutions:             [],    // SolutionSnapshot objects (with internal `key` field)
  seenKeys:              new Set(),
};

let workerThread = null;

// ── Persistence ────────────────────────────────────────────────────────────────
function loadPersisted() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const ckpt = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      state.gen      = ckpt.gen      ?? null;
      state.attempts = ckpt.attempts ?? 0;
      console.log(`Restored checkpoint: gen=${state.gen}, attempts=${state.attempts}`);
    }
  } catch (e) {
    console.error('Checkpoint load error:', e.message);
  }
  try {
    if (fs.existsSync(SOLUTIONS_FILE)) {
      const sols = JSON.parse(fs.readFileSync(SOLUTIONS_FILE, 'utf8'));
      state.solutions  = Array.isArray(sols) ? sols : [];
      state.validFound = state.solutions.length;
      for (const s of state.solutions) {
        if (s.key) state.seenKeys.add(s.key);
      }
      console.log(`Restored ${state.solutions.length} solutions`);
    }
  } catch (e) {
    console.error('Solutions load error:', e.message);
  }
}

function saveCheckpoint() {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
      gen:       state.gen,
      attempts:  state.attempts,
      timestamp: Date.now(),
    }));
  } catch (e) {
    console.error('Checkpoint save error:', e.message);
  }
}

function saveSolutions() {
  try {
    fs.writeFileSync(SOLUTIONS_FILE, JSON.stringify(state.solutions));
  } catch (e) {
    console.error('Solutions save error:', e.message);
  }
}

// Load persisted state before accepting requests.
loadPersisted();

// ── Worker lifecycle ───────────────────────────────────────────────────────────
function startWorker(gen) {
  // Terminate any existing worker first.
  if (workerThread) {
    workerThread.terminate();
    workerThread = null;
  }

  state.running = true;
  state.gen     = gen;

  workerThread = new Worker(path.join(__dirname, 'searchWorker.js'));

  workerThread.on('message', (msg) => {
    if (msg.type === 'PROGRESS') {
      state.attempts              = state.baseAttempts + msg.attempts;
      state.attemptsPerSecCurrent = msg.attemptsPerSecCurrent;
      state.attemptsPerSecAvg     = msg.attemptsPerSecAvg;
      state.uptime                = msg.uptime;

    } else if (msg.type === 'SOLUTION') {
      if (!state.seenKeys.has(msg.key)) {
        state.seenKeys.add(msg.key);
        state.validFound++;
        // Store the key internally for dedup on reload; keep it off the client response.
        state.solutions.push({ ...msg.solution, key: msg.key });
        saveSolutions();
      }

    } else if (msg.type === 'CHECKPOINT') {
      state.attempts = state.baseAttempts + msg.attempts;
      saveCheckpoint();

    } else if (msg.type === 'STOPPED') {
      state.attempts = state.baseAttempts + msg.attempts;
      state.running  = false;
      workerThread   = null;
      saveCheckpoint();
    }
  });

  workerThread.on('error', (err) => {
    console.error('Worker error:', err);
    state.running = false;
    workerThread  = null;
  });

  workerThread.on('exit', (code) => {
    if (code !== 0) {
      console.error('Worker exited unexpectedly with code', code);
      state.running = false;
      workerThread  = null;
    }
  });

  workerThread.postMessage({ type: 'START', gen, baseAttempts: state.baseAttempts });
}

// ── API routes ─────────────────────────────────────────────────────────────────

// POST /start-random-search
// Body: { gen: number }
// Starts the search. If the same gen is already running, does nothing.
// If a different gen is requested, clears existing state and starts fresh.
app.post('/start-random-search', (req, res) => {
  const { gen } = req.body ?? {};

  if (typeof gen !== 'number' || !Number.isInteger(gen) || gen < 1 || gen > 10) {
    return res.status(400).json({ error: 'gen must be an integer between 1 and 10' });
  }

  if (state.running && state.gen === gen) {
    return res.json({ ok: true, message: 'Already running' });
  }

  if (state.gen !== gen) {
    // Different gen → reset everything.
    state.solutions  = [];
    state.seenKeys   = new Set();
    state.attempts   = 0;
    state.validFound = 0;
    state.baseAttempts = 0;
    saveSolutions();
  } else {
    // Same gen, continuing after a stop → carry forward persisted attempts.
    state.baseAttempts = state.attempts;
  }

  startWorker(gen);
  res.json({ ok: true });
});

// POST /stop-random-search
// Sends STOP to the worker. The worker finishes its current batch then stops.
app.post('/stop-random-search', (_req, res) => {
  if (workerThread) {
    workerThread.postMessage({ type: 'STOP' });
  } else {
    state.running = false;
  }
  res.json({ ok: true });
});

// POST /reset-random-search
// Stops search and wipes all state and files. Useful for the Clear button.
app.post('/reset-random-search', (_req, res) => {
  if (workerThread) {
    workerThread.terminate();
    workerThread = null;
  }
  state.running        = false;
  state.gen            = null;
  state.attempts       = 0;
  state.baseAttempts   = 0;
  state.validFound     = 0;
  state.solutions      = [];
  state.seenKeys       = new Set();
  state.attemptsPerSecCurrent = 0;
  state.attemptsPerSecAvg     = 0;
  state.uptime                = 0;

  try { fs.unlinkSync(CHECKPOINT_FILE); } catch { /* file may not exist */ }
  saveSolutions(); // writes empty array

  res.json({ ok: true });
});

// GET /random-search-status
// Returns current search statistics. Polled by the frontend every few seconds.
app.get('/random-search-status', (_req, res) => {
  res.json({
    running:               state.running,
    gen:                   state.gen,
    attempts:              state.attempts,
    validFound:            state.validFound,
    attemptsPerSecCurrent: state.attemptsPerSecCurrent,
    attemptsPerSecAvg:     state.attemptsPerSecAvg,
    uptime:                state.uptime,
  });
});

// GET /random-search-solutions
// Returns all solutions for the current gen (without the internal `key` field).
app.get('/random-search-solutions', (_req, res) => {
  const client = state.solutions.map(({ key: _k, ...sol }) => sol);
  res.json({ solutions: client });
});

// GET /health
// Used by Render for health checks and uptime monitoring.
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Start server ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Graph-connector backend listening on port ${PORT}`);
});
