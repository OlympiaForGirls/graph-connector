// solutions.ts — localStorage persistence for solution snapshots.
// Key: "graph-solutions". Deduplicates by sorted connection fingerprint + generation.

import type { SolutionSnapshot, ConnectionSnapshot } from '../types/solution';

const STORAGE_KEY = 'graph-solutions';

export function loadSolutions(): SolutionSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SolutionSnapshot[]) : [];
  } catch {
    return [];
  }
}

export function saveSolutions(solutions: SolutionSnapshot[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(solutions));
}

/** Appends a solution only if it isn't already stored (by connection fingerprint). */
export function appendSolution(solution: SolutionSnapshot): void {
  const existing = loadSolutions();
  const key = connectionKey(solution.connections);
  const isDupe = existing.some(
    s => s.generation === solution.generation && connectionKey(s.connections) === key,
  );
  if (!isDupe) saveSolutions([...existing, solution]);
}

/**
 * Batch-appends multiple solutions in one localStorage read + one write.
 * Much cheaper than calling appendSolution() in a loop (which would do
 * N reads and N writes for N solutions).
 */
export function appendSolutions(newSolutions: SolutionSnapshot[]): void {
  if (newSolutions.length === 0) return;
  const existing  = loadSolutions();
  const seenKeys  = new Set(
    existing.map(s => `${s.generation}:${connectionKey(s.connections)}`),
  );
  const toAdd = newSolutions.filter(
    s => !seenKeys.has(`${s.generation}:${connectionKey(s.connections)}`),
  );
  if (toAdd.length > 0) saveSolutions([...existing, ...toAdd]);
}

export function clearSolutionsForGen(generation: number): void {
  saveSolutions(loadSolutions().filter(s => s.generation !== generation));
}

function connectionKey(connections: ConnectionSnapshot[]): string {
  return connections
    .map(c => `${c.from}\x00${c.to}\x00${c.color}`)
    .sort()
    .join('|');
}
