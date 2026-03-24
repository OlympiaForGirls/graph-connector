// GenSelector: stepper control for choosing how many generations to generate.
// Keeps state in the parent; this component is purely presentational.

import { MIN_GEN, MAX_GEN, frontierCount, totalNodeCount } from '../generation/graphGenerator';

interface GenSelectorProps {
  value: number;
  onChange: (gen: number) => void;
}

export default function GenSelector({ value, onChange }: GenSelectorProps) {
  return (
    <div className="gen-selector">
      <span className="gen-selector-label">Generations:</span>
      <div className="gen-selector-controls">
        <button
          className="gen-btn"
          onClick={() => onChange(Math.max(MIN_GEN, value - 1))}
          disabled={value <= MIN_GEN}
        >−</button>
        <span className="gen-value">{value}</span>
        <button
          className="gen-btn"
          onClick={() => onChange(Math.min(MAX_GEN, value + 1))}
          disabled={value >= MAX_GEN}
        >+</button>
      </div>
      <span className="gen-info">
        {frontierCount(value)} frontier nodes · {totalNodeCount(value)} total nodes per graph
      </span>
    </div>
  );
}
