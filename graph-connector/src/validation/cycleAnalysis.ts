// cycleAnalysis.ts — color-sequence normalization, rotation equivalence, mirror symmetry.
//
// ASSUMPTION (Rule B — Rotation equivalence):
//   The canonical form of a color sequence is the lexicographically smallest
//   cyclic rotation of that sequence. Two sequences are rotation-equivalent iff
//   their canonical forms are identical strings.
//   To change what counts as "same," edit canonicalRotation.
//
// ASSUMPTION (Rule C — Mirror symmetry, even cycles only):
//   Only cycles whose edge count is even are checked for mirror symmetry.
//   A sequence has mirror symmetry if its reversal is a cyclic rotation of itself.
//   Implementation: canonicalRotation(reverse(seq)) === canonicalRotation(seq).
//   To remove the even-length restriction or change the symmetry definition,
//   edit hasMirrorSymmetry and the caller in analyzeCycles.

import type { EdgeColor } from '../types/graph';
import type { Cycle } from '../utils/cycleDetection';

// ── Sequence extraction ───────────────────────────────────────

/** Extracts the ordered edge-color sequence from a Cycle. */
export function colorSequence(cycle: Cycle): EdgeColor[] {
  return [...cycle.colors];
}

// ── Canonical rotation (Rule B) ───────────────────────────────

/**
 * Returns the lexicographically smallest cyclic rotation of `seq`.
 * Forward rotations ONLY — used by hasMirrorSymmetry (Rule C) and for display.
 * For Rule B duplicate detection use dihedralCanonical instead.
 */
export function canonicalRotation(seq: EdgeColor[]): EdgeColor[] {
  if (seq.length === 0) return [];
  let best = seq;
  for (let i = 1; i < seq.length; i++) {
    const rot = [...seq.slice(i), ...seq.slice(0, i)];
    if (rot.join(',') < best.join(',')) best = rot;
  }
  return best;
}

/**
 * Returns the lexicographically smallest element among all cyclic rotations of
 * `seq` AND all cyclic rotations of the reversed sequence.
 *
 * This is the dihedral canonical form: two sequences map to the same string iff
 * one can be obtained from the other by cyclic rotation OR reversal (i.e., they
 * represent the same undirected cycle traversed in either direction).
 *
 * ASSUMPTION for Rule B: a cycle traversed clockwise equals the same cycle
 * traversed counterclockwise — only the edge SET and relative order matter,
 * not the direction of traversal.
 */
export function dihedralCanonical(seq: EdgeColor[]): string {
  if (seq.length === 0) return '';
  const rev = [...seq].reverse();
  let best = seq.join(',');
  for (let i = 1; i < seq.length; i++) {
    const fwd = [...seq.slice(i), ...seq.slice(0, i)].join(',');
    if (fwd < best) best = fwd;
    const bwd = [...rev.slice(i), ...rev.slice(0, i)].join(',');
    if (bwd < best) best = bwd;
  }
  // also compare rotation-0 of rev
  const rev0 = rev.join(',');
  if (rev0 < best) best = rev0;
  return best;
}

/** Returns true iff two color sequences are rotationally equivalent (Rule B). */
export function areRotationEquivalent(a: EdgeColor[], b: EdgeColor[]): boolean {
  if (a.length !== b.length) return false;
  return canonicalRotation(a).join(',') === canonicalRotation(b).join(',');
}

// ── Mirror symmetry (Rule C) ──────────────────────────────────

/**
 * Returns true if `seq` has mirror symmetry: reverse(seq) is a cyclic
 * rotation of seq.
 *
 * ASSUMPTION: checked by comparing canonicalRotation(seq) to
 * canonicalRotation(reverse(seq)). If equal → mirror-symmetric.
 *
 * The even-length gate (Rule C says "only even-length cycles") is enforced
 * by the caller (analyzeCycles), not here, so this function can be reused.
 */
export function hasMirrorSymmetry(seq: EdgeColor[]): boolean {
  const rev = [...seq].reverse();
  return canonicalRotation(seq).join(',') === canonicalRotation(rev).join(',');
}

// ── Per-cycle analysis ────────────────────────────────────────

export interface CycleAnalysis {
  cycle: Cycle;
  colorSeq: EdgeColor[];
  /** Canonical (lexicographically smallest) rotation — the "fingerprint." */
  normalizedSeq: EdgeColor[];
  isEven: boolean;
  /** Mirror symmetry detected (only meaningful when isEven is true). */
  isMirrorSymmetric: boolean;
  /** True if this cycle's color pattern duplicates an earlier cycle's. */
  rejectedForRotation: boolean;
  /** True if this cycle is even AND mirror-symmetric. */
  rejectedForMirror: boolean;
}

/**
 * Analyzes `newCycles` (cycles created by the current move) against
 * `existingCycles` (cycles that existed before the move).
 *
 * For each new cycle:
 *   - Compute normalized color sequence.
 *   - Check rotation equivalence against all existing + previously seen new cycles.
 *   - Check mirror symmetry (only for even-length cycles).
 *
 * Does NOT mutate inputs. Returns a summary plus per-cycle detail.
 */
export function analyzeCycles(
  existingCycles: Cycle[],
  newCycles: Cycle[],
): {
  analyses: CycleAnalysis[];
  anyRotationViolation: boolean;
  anyMirrorViolation: boolean;
} {
  // Seed the seen-patterns set with all existing cycle color fingerprints.
  // Uses dihedralCanonical so that a cycle traversed in reverse is treated
  // as the same pattern (Rule B: rotation OR reflection equivalence).
  const seenPatterns = new Set<string>(
    existingCycles.map(c => dihedralCanonical(c.colors))
  );

  const analyses: CycleAnalysis[] = [];
  let anyRotationViolation = false;
  let anyMirrorViolation   = false;

  for (const cycle of newCycles) {
    const colorSeq      = colorSequence(cycle);
    const normalizedSeq = canonicalRotation(colorSeq);   // forward-only, for display
    const fingerprint   = dihedralCanonical(colorSeq);   // dihedral, for Rule B check
    const isEven        = cycle.nodes.length % 2 === 0;

    // Rule B: check rotation/reflection duplicate.
    const rejectedForRotation = seenPatterns.has(fingerprint);
    // Register this pattern so subsequent new cycles are checked against it too.
    seenPatterns.add(fingerprint);

    // Rule C: mirror symmetry for even cycles only.
    const isMirrorSymmetric = isEven && hasMirrorSymmetry(colorSeq);
    const rejectedForMirror  = isMirrorSymmetric; // even + mirror → rejected

    if (rejectedForRotation) anyRotationViolation = true;
    if (rejectedForMirror)   anyMirrorViolation   = true;

    analyses.push({
      cycle,
      colorSeq,
      normalizedSeq,
      isEven,
      isMirrorSymmetric,
      rejectedForRotation,
      rejectedForMirror,
    });
  }

  return { analyses, anyRotationViolation, anyMirrorViolation };
}
