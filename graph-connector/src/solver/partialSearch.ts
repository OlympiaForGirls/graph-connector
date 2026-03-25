// partialSearch.ts — DFS for valid partial matchings of exactly `targetEdges` cross-edges.
//
// A partial matching is valid if every cross-edge added so far satisfies Rules A, B, C
// on the cycles produced up to that point (i.e., the same incremental checks the full
// solver performs, just stopped at depth = targetEdges instead of N).
//
// Duplicate avoidance: top nodes are chosen in strictly increasing index order
// (ti >= minTopIdx) so each unordered subset of top nodes is explored exactly once.

import type { Graph, EdgeColor } from '../types/graph';
import type { PartialPattern } from '../types/partial';
import { buildBaseAdj } from './cpSolver';
import { dihedralCanonical, hasMirrorSymmetry } from '../validation/cycleAnalysis';

const COLORS: EdgeColor[] = ['red', 'green', 'blue'];
const CYCLE_PATH_CAP = 200;
const STOP_CHECK_INTERVAL = 200;
const PROGRESS_INTERVAL_MS = 200;

type AdjEntry = { neighbor: string; color: EdgeColor };
type IncrAdj  = Map<string, AdjEntry[]>;

export interface PartialProgress {
  statesExplored: number;
  patternsFound:  number;
  stopped:  boolean;
  timedOut: boolean;
  done:     boolean;
}

export interface PartialResult {
  patterns: PartialPattern[];
  progress: PartialProgress;
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

/** Check and collect new fingerprints for an edge. Returns null if any rule is violated. */
function checkEdge(
  adj: IncrAdj, topId: string, botId: string,
  color: EdgeColor, seenFps: Set<string>,
): string[] | null {
  const seqs = findNewCycleColors(adj, topId, botId, color, CYCLE_PATH_CAP);
  const newFps: string[] = [];
  for (const seq of seqs) {
    const fp = dihedralCanonical(seq);
    if (seenFps.has(fp)) return null;
    if (seq.length % 2 === 0 && hasMirrorSymmetry(seq)) return null;
    newFps.push(fp);
  }
  return newFps;
}

export function runPartialSearch(
  gen:              number,
  topGraph:         Graph,
  bottomGraph:      Graph,
  targetEdges:      number,
  maxPatterns:      number,
  shouldStop:       () => boolean,
  onProgress:       (p: PartialProgress) => void,
  onPattern:        (p: PartialPattern) => void,
  safetyTimeLimitMs: number,
): PartialResult {
  const topFrontier = topGraph.nodes.filter(n => n.isFrontier);
  const botFrontier = bottomGraph.nodes.filter(n => n.isFrontier);
  const N = topFrontier.length;

  const adj = buildBaseAdj(topGraph, bottomGraph) as IncrAdj;

  // Compute parent colors for Rule A
  const parentColor = new Map<string, EdgeColor>();
  const frontierIds = new Set([...topFrontier, ...botFrontier].map(n => n.id));
  for (const e of topGraph.edges)    if (frontierIds.has(e.targetId)) parentColor.set(e.targetId, e.color);
  for (const e of bottomGraph.edges) if (frontierIds.has(e.targetId)) parentColor.set(e.targetId, e.color);

  const patterns:  PartialPattern[] = [];
  const seenFps    = new Set<string>();
  const usedTop    = new Set<string>();
  const usedBot    = new Set<string>();

  // Stack entries for backtracking
  interface Frame { ti: number; bi: number; ci: number; fps: string[] }
  const stack: Frame[] = [];

  let statesExplored = 0;
  let stopped  = false;
  let timedOut = false;
  let stepCount = 0;
  let lastEmit  = Date.now();
  const startTime = Date.now();

  function emitProgress(done = false) {
    onProgress({ statesExplored, patternsFound: patterns.length, stopped, timedOut, done });
  }

  function dfs(depth: number, minTopIdx: number): void {
    if (stopped || timedOut || patterns.length >= maxPatterns) return;

    stepCount++;
    if (stepCount % STOP_CHECK_INTERVAL === 0) {
      if (shouldStop()) { stopped = true; return; }
      if (Date.now() - startTime > safetyTimeLimitMs) { timedOut = true; return; }
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) { emitProgress(); lastEmit = now; }
    }

    if (depth === targetEdges) {
      // Emit partial pattern
      const connections = stack.map(f => ({
        from:  topFrontier[f.ti].id,
        to:    botFrontier[f.bi].id,
        color: COLORS[f.ci],
      }));
      const usedTopNodes = stack.map(f => topFrontier[f.ti].id);
      const usedBotNodes = stack.map(f => botFrontier[f.bi].id);
      const usedTopSet   = new Set(usedTopNodes);
      const usedBotSet   = new Set(usedBotNodes);
      const remainingTopNodes = topFrontier.filter(n => !usedTopSet.has(n.id)).map(n => n.id);
      const remainingBotNodes = botFrontier.filter(n => !usedBotSet.has(n.id)).map(n => n.id);

      const pat: PartialPattern = {
        id: `partial-${Date.now()}-${patterns.length}`,
        generation: gen,
        connections,
        usedTopNodes,
        usedBotNodes,
        remainingTopNodes,
        remainingBotNodes,
        timestamp: Date.now(),
      };
      patterns.push(pat);
      onPattern(pat);
      return;
    }

    for (let ti = minTopIdx; ti < N; ti++) {
      if (stopped || timedOut || patterns.length >= maxPatterns) break;
      if (usedTop.has(topFrontier[ti].id)) continue;
      const topId     = topFrontier[ti].id;
      const forbidTop = parentColor.get(topId);

      for (let bi = 0; bi < N; bi++) {
        if (stopped || timedOut || patterns.length >= maxPatterns) break;
        if (usedBot.has(botFrontier[bi].id)) continue;
        const botId     = botFrontier[bi].id;
        const forbidBot = parentColor.get(botId);

        for (let ci = 0; ci < COLORS.length; ci++) {
          if (stopped || timedOut || patterns.length >= maxPatterns) break;
          const color = COLORS[ci];
          if (color === forbidTop || color === forbidBot) continue;

          const fps = checkEdge(adj, topId, botId, color, seenFps);
          if (fps === null) continue;

          statesExplored++;

          // Commit
          for (const fp of fps) seenFps.add(fp);
          usedTop.add(topId);
          usedBot.add(botId);
          adjAddEdge(adj, topId, botId, color);
          stack.push({ ti, bi, ci, fps });

          dfs(depth + 1, ti + 1);

          // Undo
          stack.pop();
          adjRemoveEdge(adj, topId, botId, color);
          usedTop.delete(topId);
          usedBot.delete(botId);
          for (const fp of fps) seenFps.delete(fp);
        }
      }
    }
  }

  emitProgress();
  dfs(0, 0);

  const done = !stopped && !timedOut;
  emitProgress(done);

  return {
    patterns,
    progress: { statesExplored, patternsFound: patterns.length, stopped, timedOut, done },
  };
}
