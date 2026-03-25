// partials.ts — localStorage persistence for partial matching patterns.
// Key: "graph-partials".

import type { PartialPattern } from '../types/partial';
import type { ConnectionSnapshot } from '../types/solution';

const STORAGE_KEY = 'graph-partials';

export function loadPartials(): PartialPattern[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PartialPattern[]) : [];
  } catch {
    return [];
  }
}

export function savePartials(partials: PartialPattern[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(partials));
}

export function appendPartials(newPartials: PartialPattern[]): void {
  if (newPartials.length === 0) return;
  const existing = loadPartials();
  const seenKeys = new Set(
    existing.map(p => `${p.generation}:${connectionKey(p.connections)}`),
  );
  const toAdd = newPartials.filter(
    p => !seenKeys.has(`${p.generation}:${connectionKey(p.connections)}`),
  );
  if (toAdd.length > 0) savePartials([...existing, ...toAdd]);
}

export function clearPartialsForGen(generation: number): void {
  savePartials(loadPartials().filter(p => p.generation !== generation));
}

function connectionKey(connections: ConnectionSnapshot[]): string {
  return connections
    .map(c => `${c.from}\x00${c.to}\x00${c.color}`)
    .sort()
    .join('|');
}
