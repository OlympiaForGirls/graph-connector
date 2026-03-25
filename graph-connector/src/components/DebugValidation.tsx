// DebugValidation.tsx — shows the result of the fast incremental graph validation.

import type { GraphValidationResult } from '../validation/validateGraph';
import type { CrossEdge, EdgeColor } from '../types/graph';
import { EDGE_COLORS } from './GraphView';

interface Props {
  result: GraphValidationResult;
  crossEdges: CrossEdge[];
}

function ColorSeq({ seq, label }: { seq: EdgeColor[]; label: string }) {
  return (
    <div className="dbg-seq-row">
      <span className="dbg-seq-label">{label}</span>
      <span className="dbg-color-seq">
        {seq.map((c, i) => (
          <span key={i} className="dbg-dot" style={{ background: EDGE_COLORS[c] }} title={c} />
        ))}
      </span>
      <span className="dbg-seq-text">[{seq.join(', ')}]</span>
    </div>
  );
}

export default function DebugValidation({ result, crossEdges }: Props) {
  if (result.totalEdges === 0) {
    return <p className="dbg-verdict-line dbg-verdict-line--ok">✓ No cross-edges — nothing to validate.</p>;
  }

  if (result.valid) {
    return (
      <p className="dbg-verdict-line dbg-verdict-line--ok">
        ✓ Valid — {result.checkedEdges} cross-edge{result.checkedEdges !== 1 ? 's' : ''} checked, no violations.
      </p>
    );
  }

  const i    = result.violatingEdgeIndex!;
  const edge = crossEdges[i];
  const isMirror   = result.violationReason === 'mirror';
  const isRotation = result.violationReason === 'rotation';

  return (
    <div className="dbg-fail-block">
      <p className="dbg-verdict-line dbg-verdict-line--fail">
        ✗ Invalid — violation on edge #{i + 1} of {result.totalEdges}
      </p>

      {/* Offending edge */}
      {edge && (
        <div className="dbg-fail-edge">
          <span className="dbg-fail-dot" style={{ background: EDGE_COLORS[edge.color] }} />
          <span className="dbg-fail-label">
            {edge.topNodeId.replace(/^[^-]+-/, '')} → {edge.bottomNodeId.replace(/^[^-]+-/, '')}
          </span>
          <span className="dbg-fail-reason">
            {isMirror   ? 'even-length cycle with mirror symmetry (Rule C)' : ''}
            {isRotation ? 'rotation-equivalent cycle already exists (Rule B)' : ''}
          </span>
        </div>
      )}

      {/* Violating cycle detail */}
      {result.violatingCycleSeq && (
        <div className="dbg-cycle-detail">
          <p className="dbg-cycle-detail-title">
            {isMirror ? 'Mirror-symmetric cycle:' : 'Duplicate cycle (new):'}
          </p>
          <ColorSeq seq={result.violatingCycleSeq}    label="Sequence" />
          <ColorSeq seq={result.violatingCanonical!}  label="Canonical" />
          <ColorSeq seq={result.violatingReversed!}   label="Reversed" />
          <ColorSeq seq={result.violatingRevCanonical!} label="Rev. canonical" />
          {isMirror && (
            <p className="dbg-mirror-note">
              Mirror symmetry: canonical = rev. canonical →{' '}
              [{result.violatingCanonical!.join(', ')}]
            </p>
          )}
        </div>
      )}

      {/* For rotation violations: show the earlier cycle too */}
      {isRotation && result.earlierCycleSeq && (
        <div className="dbg-cycle-detail dbg-cycle-detail--earlier">
          <p className="dbg-cycle-detail-title">Earlier cycle with same fingerprint:</p>
          <ColorSeq seq={result.earlierCycleSeq}                    label="Sequence" />
          <ColorSeq seq={[...result.earlierCycleSeq].reverse()}     label="Reversed" />
          <p className="dbg-mirror-note">
            Shared fingerprint: {result.duplicateFingerprint}
          </p>
        </div>
      )}
    </div>
  );
}
