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
 * This is the canonical form used to decide rotation equivalence.
 *
 * ASSUMPTION: rotation-equivalence = "one is a cyclic shift of the other."
 * Reflection is intentionally NOT included here (that is Rule C's concern).
 * Adjust this function to change the equivalence definition.
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
  const seenPatterns = new Set<string>(
    existingCycles.map(c => canonicalRotation(c.colors).join(','))
  );

  const analyses: CycleAnalysis[] = [];
  let anyRotationViolation = false;
  let anyMirrorViolation   = false;

  for (const cycle of newCycles) {
    const colorSeq     = colorSequence(cycle);
    const normalizedSeq = canonicalRotation(colorSeq);
    const fingerprint  = normalizedSeq.join(',');
    const isEven       = cycle.nodes.length % 2 === 0;

    // Rule B: check rotation duplicate.
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
