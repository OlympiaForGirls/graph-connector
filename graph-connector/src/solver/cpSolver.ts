// cpSolver.ts — constraint-propagation DFS engine for bipartite perfect matchings.
//
// ── ARCHITECTURE NOTE ──────────────────────────────────────────────────────────
// This file is the replaceable solver backend.  The public entry point is
// matchingSearch.ts (runSearch), which dispatches here via runCPSolver().
// To swap in a stronger engine (SAT/WASM/server-side CP), implement the same
// CpSolverParams / CpSolverResult contract and update matchingSearch.ts only.
//
// ── WHY ADDITIONAL PRUNING ALONE EVENTUALLY FAILS ──────────────────────────────
// Gen 4 has N=24 frontier pairs.  The search has three fundamental costs:
//
//   1. "Find all" is intrinsically expensive.  If gen 4 has K valid solutions
//      any complete enumeration must visit ≥ K leaf nodes.  No pruning can
//      reduce work below the true solution count.
//
//   2. Domain propagation is O(N²) per DFS call.  At N=24 that is 576
//      feasibility checks per DFS node; each check runs findNewCycleColors
//      (O(paths)).  Over millions of DFS nodes this dominates.
//
//   3. Cycle rules are global constraints.  Rules B and C depend on the ENTIRE
//      partial matching so far, requiring graph traversal per check.  Unlike
//      simple CSP constraints (≤ 2 variables), these cannot be propagated with
//      arc-consistency alone.
//
// ── PATH TOWARD STRONGER SOLVERS ───────────────────────────────────────────────
// • SAT/DPLL with clause learning (CDCL): learns nogoods on backtrack, avoids
//   re-exploring equivalent subspaces.  Requires encoding Rules B+C as SAT clauses.
// • CP with AC-3: maintains arc-consistency efficiently.  Requires encoding
//   cycle rules as explicit finite-domain constraints.
// • Server-side or WASM solver: same algorithm but orders-of-magnitude faster
//   execution speed (no JS overhead, SIMD, multithreading).
// • For "find first 1": random restarts + restarts-with-no-goods are extremely
//   effective when solutions exist but the default search order misses them.
//
// ── KEY OPTIMISATIONS IN THIS FILE ────────────────────────────────────────────
//
// Two-tier domain computation (biggest single speedup):
//   isFeasible(…, FAST_CAP)   — cap=50, exits on first violation.
//     Used inside propagate() to COUNT feasible options for ALL remaining nodes.
//     Most infeasible options violate rules within the first few paths (short-
//     circuit).  Average cost ≈ 5–20 path explorations per infeasible option.
//   buildFeasibleEntry(…, adaptiveCap)  — cap adapts with depth, collects fps.
//     Used ONLY when actually committing: forced moves and branch choices.
//     Never called for options that will immediately be discarded.
//   Net effect: propagation scans are ≈ 20× cheaper than full domain computation.
//
// Unit propagation (forced moves):
//   Any remaining top node with exactly one feasible (bot,color) is committed
//   immediately.  Chains: each forced move may force another.  The stable
//   propagation state is reached before any recursive call.
//
// MCV branching:
//   Counts feasible options cheaply (FAST_CAP) for all remaining nodes, then
//   branches on the smallest domain.  Contradictions surface at minimum depth.
//
// Adaptive path cap:
//   At depth d (d cross-edges already committed), the cycle-search cap for
//   buildFeasibleEntry is max(FAST_CAP, MAX_PATHS - d×5).  At depth 0 we use
//   200 paths; at depth 30 the cap floors at 50.  Deep levels already have many
//   fingerprints in seenFingerprints so violations are found early anyway.
//
// O(N) memoisation key:
//   Fixed-position assignment array → join(), order-independent without sorting.

import type { Graph, CrossEdge, EdgeColor } from '../types/graph';
import type { SolutionSnapshot, ConnectionSnapshot } from '../types/solution';
import { buildUnifiedAdjList, findAllCycles } from '../utils/cycleDetection';
import { dihedralCanonical, hasMirrorSymmetry } from '../validation/cycleAnalysis';

const COLORS: EdgeColor[]     = ['red', 'green', 'blue'];
const FAST_CAP                = 50;    // propagation feasibility cap
const MAX_PATHS_PER_EDGE      = 200;   // full commit-time cap (depth-0 value)
const VALIDATE_MAX_PATHS      = 10_000;
const FULL_VALIDATE_NODE_LIMIT = 50;
const STOP_CHECK_INTERVAL     = 200;
const PROGRESS_INTERVAL_MS    = 200;
const PROGRESS_COUNT_INTERVAL = 5_000;

// ── Incremental adjacency list ────────────────────────────────────────────────
type AdjEntry = { neighbor: string; color: EdgeColor };
type IncrAdj  = Map<string, AdjEntry[]>;

export function buildBaseAdj(topGraph: Graph, bottomGraph: Graph): IncrAdj {
  const adj: IncrAdj = new Map();
  for (const n of topGraph.nodes)    adj.set(n.id, []);
  for (const n of bottomGraph.nodes) adj.set(n.id, []);
  for (const e of topGraph.edges)    adjAddEdge(adj, e.sourceId, e.targetId, e.color);
  for (const e of bottomGraph.edges) adjAddEdge(adj, e.sourceId, e.targetId, e.color);
  return adj;
}

function adjAddEdge(adj: IncrAdj, a: string, b: string, color: EdgeColor) {
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a)!.push({ neighbor: b, color });
  adj.get(b)!.push({ neighbor: a, color });
}

function adjRemoveEdge(adj: IncrAdj, a: string, b: string, color: EdgeColor) {
  const strip = (arr: AdjEntry[], tgt: string) => {
    const i = arr.findIndex(e => e.neighbor === tgt && e.color === color);
    if (i !== -1) arr.splice(i, 1);
  };
  const la = adj.get(a); if (la) strip(la, b);
  const lb = adj.get(b); if (lb) strip(lb, a);
}

// ── New-cycle finder ──────────────────────────────────────────────────────────
function findNewCycleColors(
  adj: IncrAdj, edgeFrom: string, edgeTo: string,
  edgeColor: EdgeColor, maxPaths: number,
): EdgeColor[][] {
  const results: EdgeColor[][] = [];
  const pathColors: EdgeColor[] = [];
  const visited = new Set<string>([edgeTo]);
  function inner(cur: string): void {
    for (const { neighbor, color } of adj.get(cur) ?? []) {
      if (results.length >= maxPaths) return;
      if (neighbor === edgeFrom) { results.push([edgeColor, ...pathColors, color]); continue; }
      if (!visited.has(neighbor)) {
        visited.add(neighbor); pathColors.push(color);
        inner(neighbor);
        pathColors.pop(); visited.delete(neighbor);
      }
    }
  }
  inner(edgeTo);
  return results;
}

// ── Base-case safety-net validator ────────────────────────────────────────────
function validateCompleteMatching(
  topGraph: Graph, bottomGraph: Graph, edges: CrossEdge[],
): boolean {
  const totalNodes = topGraph.nodes.length + bottomGraph.nodes.length;
  if (totalNodes <= FULL_VALIDATE_NODE_LIMIT) {
    const adj    = buildUnifiedAdjList(topGraph, bottomGraph, edges);
    const cycles = findAllCycles(adj);
    const seen   = new Set<string>();
    for (const c of cycles) {
      const fp = dihedralCanonical(c.colors);
      if (seen.has(fp)) return false;
      seen.add(fp);
    }
    for (const c of cycles) {
      if (c.nodes.length % 2 === 0 && hasMirrorSymmetry(c.colors)) return false;
    }
    return true;
  }
  // Large graph: incremental replay with high path cap.
  const adj: IncrAdj = new Map();
  for (const n of topGraph.nodes)    adj.set(n.id, []);
  for (const n of bottomGraph.nodes) adj.set(n.id, []);
  for (const e of topGraph.edges)    adjAddEdge(adj, e.sourceId, e.targetId, e.color);
  for (const e of bottomGraph.edges) adjAddEdge(adj, e.sourceId, e.targetId, e.color);
  const seenFps = new Set<string>();
  for (const edge of edges) {
    const seqs = findNewCycleColors(adj, edge.topNodeId, edge.bottomNodeId, edge.color, VALIDATE_MAX_PATHS);
    for (const seq of seqs) {
      const fp = dihedralCanonical(seq);
      if (seenFps.has(fp)) return false;
      if (seq.length % 2 === 0 && hasMirrorSymmetry(seq)) return false;
      seenFps.add(fp);
    }
    adjAddEdge(adj, edge.topNodeId, edge.bottomNodeId, edge.color);
  }
  return true;
}

// ── Two-tier feasibility ──────────────────────────────────────────────────────

/**
 * FAST feasibility check — uses FAST_CAP and exits on the first violation.
 * Never gives false negatives (if infeasible, returns false).
 * May give false positives (says feasible, but full cap would find a violation).
 * Used in propagate() to count options cheaply for ALL remaining nodes.
 */
function isFeasible(
  adj: IncrAdj, topId: string, botId: string,
  color: EdgeColor, seenFps: Set<string>,
): boolean {
  const seqs = findNewCycleColors(adj, topId, botId, color, FAST_CAP);
  for (const seq of seqs) {
    const fp = dihedralCanonical(seq);
    if (seenFps.has(fp)) return false;
    if (seq.length % 2 === 0 && hasMirrorSymmetry(seq)) return false;
  }
  return true;
}

/**
 * FULL feasibility check — uses an adaptive cap, returns the new fingerprints
 * to register in seenFingerprints on commit, or null on any violation.
 * Called only when actually committing an assignment (forced or branch).
 * Cap decreases with depth so deep-level work stays bounded.
 */
function buildFeasibleEntry(
  adj: IncrAdj, topId: string, botId: string,
  color: EdgeColor, seenFps: Set<string>,
  depth: number,
): readonly string[] | null {
  const cap  = Math.max(FAST_CAP, MAX_PATHS_PER_EDGE - depth * 5);
  const seqs = findNewCycleColors(adj, topId, botId, color, cap);
  const newFps: string[] = [];
  for (const seq of seqs) {
    const fp = dihedralCanonical(seq);
    if (seenFps.has(fp)) return null;
    if (seq.length % 2 === 0 && hasMirrorSymmetry(seq)) return null;
    newFps.push(fp);
  }
  return newFps;
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface CpSolverParams {
  gen:          number;
  topGraph:     Graph;
  bottomGraph:  Graph;
  /** Pre-filtered frontier nodes. */
  topFrontier:  Graph['nodes'];
  /**
   * Pre-filtered frontier nodes, possibly shuffled for restart diversity.
   * All bot node IDs are still the authoritative IDs used in the final solution.
   */
  botFrontier:  Graph['nodes'];
  /** Parent-edge colour for each frontier node (forbidden on any cross-edge). */
  parentColor:  Map<string, EdgeColor>;
  /** Pre-built adjacency list from tree edges.  MUTATED during search; restored on backtrack. */
  adj:          IncrAdj;
  maxSolutions: number;
  shouldStop:   () => boolean;
  onProgress:   (p: CpProgress) => void;
  onSolution:   (s: SolutionSnapshot) => void;
  startTime:    number;
  timeLimitMs:  number;
  /**
   * Cross-edges already committed before the search starts (complete-from-partial).
   * The solver adds them to adj and seeds seenFingerprints from their cycles so
   * the DFS can see paths through them when evaluating new cycle rules.
   * Also prepended to currentEdges inside validateCompleteMatching.
   */
  fixedCrossEdges?: CrossEdge[];
  /** @deprecated Use fixedCrossEdges instead — it handles both adj and fingerprints. */
  initialSeenFingerprints?: ReadonlySet<string>;
}

export interface CpProgress {
  partialStatesExplored:      number;
  completeMatchingsEvaluated: number;
  validSolutionsFound:        number;
  stopped:   boolean;
  timedOut:  boolean;
}

export interface CpSolverResult {
  solutions:                  SolutionSnapshot[];
  partialStatesExplored:      number;
  completeMatchingsEvaluated: number;
  stopped:   boolean;
  timedOut:  boolean;
  /** True iff the search fully exhausted all possibilities within the time limit. */
  exhausted: boolean;
}

// ── Solver implementation ─────────────────────────────────────────────────────
export function runCPSolver(p: CpSolverParams): CpSolverResult {
  const {
    gen, topGraph, bottomGraph, topFrontier, botFrontier, parentColor,
    adj, maxSolutions, shouldStop, onProgress, onSolution, startTime, timeLimitMs,
    fixedCrossEdges, initialSeenFingerprints,
  } = p;
  const N = topFrontier.length;

  // ── Backtracking state ────────────────────────────────────────
  const currentEdges:    CrossEdge[]  = [];
  const usedBotIds       = new Set<string>();
  const seenFingerprints = new Set<string>();
  const badStates        = new Set<string>();
  const solutions:       SolutionSnapshot[] = [];
  // Legacy fingerprint seeding (deprecated — use fixedCrossEdges instead).
  if (initialSeenFingerprints) {
    for (const fp of initialSeenFingerprints) seenFingerprints.add(fp);
  }

  // Pre-commit fixed cross-edges (complete-from-partial):
  //   1. Find cycles created by each fixed edge (adj must NOT contain it yet).
  //   2. Seed seenFingerprints with those cycle fingerprints.
  //   3. Add the edge to adj so subsequent cycle checks can traverse it.
  if (fixedCrossEdges?.length) {
    for (const e of fixedCrossEdges) {
      const seqs = findNewCycleColors(adj, e.topNodeId, e.bottomNodeId, e.color, VALIDATE_MAX_PATHS);
      for (const seq of seqs) seenFingerprints.add(dihedralCanonical(seq));
      adjAddEdge(adj, e.topNodeId, e.bottomNodeId, e.color);
    }
  }

  let partialStatesExplored      = 0;
  let completeMatchingsEvaluated = 0;
  let stopped   = false;
  let timedOut  = false;
  let stepCount = 0;
  let lastEmit  = startTime;

  function emitProgress() {
    onProgress({
      partialStatesExplored, completeMatchingsEvaluated,
      validSolutionsFound: solutions.length, stopped, timedOut,
    });
  }

  // ── Memoisation key (O(N) join, no sort, order-independent) ───
  // assignment[i] = botIdx * 3 + colorIdx, or -1 when unassigned.
  const assignment = new Int8Array(N).fill(-1);
  function partialKey(): string { return assignment.join(','); }

  // remaining[i] === 1 while topFrontier[i] is unassigned.
  const remaining = new Uint8Array(N).fill(1);

  // ── Commit / undo helpers ──────────────────────────────────────
  interface CommitEntry { ti: number; bi: number; ci: number; fps: readonly string[] }

  function commit(e: CommitEntry): void {
    const color = COLORS[e.ci];
    assignment[e.ti] = e.bi * 3 + e.ci;
    adjAddEdge(adj, topFrontier[e.ti].id, botFrontier[e.bi].id, color);
    currentEdges.push({ id: `s${e.ti}`, topNodeId: topFrontier[e.ti].id, bottomNodeId: botFrontier[e.bi].id, color });
    usedBotIds.add(botFrontier[e.bi].id);
    remaining[e.ti] = 0;
    for (const fp of e.fps) seenFingerprints.add(fp);
  }

  function undo(e: CommitEntry): void {
    const color = COLORS[e.ci];
    for (const fp of e.fps) seenFingerprints.delete(fp);
    remaining[e.ti]  = 1;
    usedBotIds.delete(botFrontier[e.bi].id);
    currentEdges.pop();
    adjRemoveEdge(adj, topFrontier[e.ti].id, botFrontier[e.bi].id, color);
    assignment[e.ti] = -1;
  }

  function undoAll(stack: CommitEntry[]): void {
    for (let i = stack.length - 1; i >= 0; i--) undo(stack[i]);
  }

  // ── Unit propagation ───────────────────────────────────────────
  // Scans remaining top nodes with the FAST_CAP check (cheap counting).
  // Forced moves (domain size == 1 by fast cap) are committed with the full-cap
  // check to collect fps.  Contradiction is returned whenever:
  //   • fast-cap count == 0 for any node (truly no feasible option), or
  //   • fast-cap count == 1 but full-cap check fails (fast cap was too lenient).
  // Both cases are sound: no valid solution exists from this state.
  function propagate(forcedStack: CommitEntry[]): 'ok' | 'contradiction' {
    let changed = true;
    while (changed) {
      changed = false;
      for (let ti = 0; ti < N; ti++) {
        if (!remaining[ti]) continue;
        const topId     = topFrontier[ti].id;
        const forbidTop = parentColor.get(topId);
        let feasible = 0;
        let fBi = -1, fCi = -1;

        outer:
        for (let bi = 0; bi < N; bi++) {
          if (usedBotIds.has(botFrontier[bi].id)) continue;
          const botId     = botFrontier[bi].id;
          const forbidBot = parentColor.get(botId);
          for (let ci = 0; ci < COLORS.length; ci++) {
            const color = COLORS[ci];
            if (color === forbidTop || color === forbidBot) continue;   // Rule A
            if (!isFeasible(adj, topId, botId, color, seenFingerprints)) continue;
            feasible++;
            fBi = bi; fCi = ci;
            if (feasible > 1) break outer;   // not forced — stop counting
          }
        }

        if (feasible === 0) return 'contradiction';
        if (feasible === 1) {
          // Forced: commit with full cap to collect fps.
          const fps = buildFeasibleEntry(
            adj, topId, botFrontier[fBi].id, COLORS[fCi],
            seenFingerprints, currentEdges.length,
          );
          if (fps === null) return 'contradiction';  // full cap found a violation the fast cap missed
          const e: CommitEntry = { ti, bi: fBi, ci: fCi, fps };
          commit(e);
          forcedStack.push(e);
          partialStatesExplored++;
          changed = true;
          break;   // restart scan — usedBotIds / seenFingerprints changed
        }
      }
    }
    return 'ok';
  }

  // ── DFS ───────────────────────────────────────────────────────
  function dfs(): void {
    if (stopped || timedOut || solutions.length >= maxSolutions) return;

    stepCount++;
    if (stepCount % STOP_CHECK_INTERVAL === 0) {
      if (shouldStop()) { stopped = true; return; }
      if (Date.now() - startTime > timeLimitMs) { timedOut = true; return; }
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) { emitProgress(); lastEmit = now; }
    }

    const key = partialKey();
    if (badStates.has(key)) return;

    // ── Propagate forced moves ────────────────────────────────
    const forced: CommitEntry[] = [];
    if (propagate(forced) === 'contradiction') { undoAll(forced); return; }

    // ── MCV selection (cheap FAST_CAP counting for all nodes) ──
    // Also serves as forward check: count == 0 from fast-cap is a true empty domain.
    let bestTi = -1, bestCount = Infinity;

    for (let ti = 0; ti < N; ti++) {
      if (!remaining[ti]) continue;
      const topId     = topFrontier[ti].id;
      const forbidTop = parentColor.get(topId);
      let count = 0;
      for (let bi = 0; bi < N; bi++) {
        if (usedBotIds.has(botFrontier[bi].id)) continue;
        const forbidBot = parentColor.get(botFrontier[bi].id);
        for (let ci = 0; ci < COLORS.length; ci++) {
          const color = COLORS[ci];
          if (color === forbidTop || color === forbidBot) continue;
          if (isFeasible(adj, topId, botFrontier[bi].id, color, seenFingerprints)) count++;
        }
      }
      if (count === 0) { undoAll(forced); return; }   // forward check
      if (count < bestCount) { bestCount = count; bestTi = ti; }
    }

    // ── Base case ─────────────────────────────────────────────
    if (bestTi === -1) {
      completeMatchingsEvaluated++;
      if (validateCompleteMatching(topGraph, bottomGraph, [...(fixedCrossEdges ?? []), ...currentEdges])) {
        const connections: ConnectionSnapshot[] = currentEdges.map(e => ({
          from: e.topNodeId, to: e.bottomNodeId, color: e.color,
        }));
        const snap: SolutionSnapshot = {
          id: `sol-${Date.now()}-${solutions.length}`,
          generation: gen, connections, timestamp: Date.now(),
        };
        solutions.push(snap);
        onSolution(snap);
      }
      undoAll(forced);
      return;
    }

    // Progress
    if (
      partialStatesExplored === 1 ||
      partialStatesExplored % PROGRESS_COUNT_INTERVAL === 0 ||
      Date.now() - lastEmit >= PROGRESS_INTERVAL_MS
    ) { emitProgress(); lastEmit = Date.now(); }

    // ── Branch on most-constrained variable ──────────────────
    // Build the full domain (full-cap) only for the selected node.
    const prevSol    = solutions.length;
    const topId      = topFrontier[bestTi].id;
    const forbidTop  = parentColor.get(topId);
    const depth      = currentEdges.length;
    remaining[bestTi] = 0;

    for (let bi = 0; bi < N; bi++) {
      if (stopped || timedOut || solutions.length >= maxSolutions) break;
      if (usedBotIds.has(botFrontier[bi].id)) continue;
      const botId     = botFrontier[bi].id;
      const forbidBot = parentColor.get(botId);
      for (let ci = 0; ci < COLORS.length; ci++) {
        if (stopped || timedOut || solutions.length >= maxSolutions) break;
        const color = COLORS[ci];
        if (color === forbidTop || color === forbidBot) continue;
        // Full cap for actual commit — collects fps needed by seenFingerprints.
        const fps = buildFeasibleEntry(adj, topId, botId, color, seenFingerprints, depth);
        if (fps === null) continue;
        partialStatesExplored++;
        const entry: CommitEntry = { ti: bestTi, bi, ci, fps };
        commit(entry);
        dfs();
        undo(entry);
      }
    }

    remaining[bestTi] = 1;
    if (solutions.length === prevSol && !stopped && !timedOut) badStates.add(key);
    undoAll(forced);
  }

  emitProgress();
  dfs();

  return {
    solutions,
    partialStatesExplored,
    completeMatchingsEvaluated,
    stopped,
    timedOut,
    exhausted: !stopped && !timedOut && solutions.length < maxSolutions,
  };
}
