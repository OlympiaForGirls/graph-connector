import type { EdgeColor } from './graph';

export interface ConnectionSnapshot {
  from: string;
  to: string;
  color: EdgeColor;
}

export interface SolutionSnapshot {
  id: string;
  generation: number;
  connections: ConnectionSnapshot[];
  timestamp: number;
}
