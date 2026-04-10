export type BlockType = 'user-input' | 'agent-thinking' | 'agent-output';

export const BLOCK_TYPES: readonly BlockType[] = [
  'user-input',
  'agent-thinking',
  'agent-output',
];

export interface ConversationSegment {
  content: string;
  isStreaming: boolean;
}

export interface ConversationTurn {
  id: string;
  source?: string;
  createdAt: number;
  updatedAt: number;
  isComplete: boolean;
  blocks: Record<BlockType, ConversationSegment>;
}

export interface MonitorMessage {
  type: BlockType;
  content: string;
  source?: string;
}

export interface MonitorStatus {
  status: 'connected' | 'disconnected' | 'monitoring';
  text: string;
}

export interface WebviewIncoming {
  command: 'ready';
}

export interface WebviewOutgoing {
  command: 'sync' | 'updateTurn' | 'clear' | 'setStatus';
  turns?: ConversationTurn[];
  turn?: ConversationTurn;
  status?: MonitorStatus['status'];
  text?: string;
}
