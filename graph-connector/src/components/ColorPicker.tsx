// ColorPicker: lets the user choose the color for the next cross-edge.
// Purely presentational — receives value and onChange from the parent.

import type { EdgeColor } from '../types/graph';
import { EDGE_COLORS } from './GraphView';

const COLORS: EdgeColor[] = ['red', 'green', 'blue'];

interface ColorPickerProps {
  value: EdgeColor;
  onChange: (c: EdgeColor) => void;
}

export default function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div className="color-picker">
      <span className="color-picker-label">Next edge color:</span>
      <div className="color-picker-btns">
        {COLORS.map(c => (
          <button
            key={c}
            className={`color-btn${value === c ? ' color-btn--active' : ''}`}
            onClick={() => onChange(c)}
            title={c}
            style={{ '--btn-clr': EDGE_COLORS[c] } as React.CSSProperties}
          >
            <span className="color-btn-swatch" />
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
