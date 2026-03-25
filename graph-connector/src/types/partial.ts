import type { ConnectionSnapshot } from './solution';

export interface PartialPattern {
  id: string;
  generation: number;
  connections: ConnectionSnapshot[];
  usedTopNodes: string[];
  usedBotNodes: string[];
  remainingTopNodes: string[];
  remainingBotNodes: string[];
  timestamp: number;
}
