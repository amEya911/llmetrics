export type HostApp = 'cursor' | 'antigravity' | 'unknown';

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
  createdAt: number;
  updatedAt: number;
  isComplete: boolean;
  blocks: Record<BlockType, ConversationSegment>;
}

export interface ConversationChat {
  id: string;
  title: string;
  subtitle?: string;
  createdAt: number;
  updatedAt: number;
  turns: ConversationTurn[];
  isEphemeral?: boolean;
}

export interface ConversationCollection {
  chats: ConversationChat[];
  selectedChatId?: string;
}

export interface MonitorSnapshot extends ConversationCollection {
  app: HostApp;
  appLabel: string;
}

export interface MonitorMessage {
  type: BlockType;
  content: string;
}

export interface MonitorStatus {
  status: 'connected' | 'disconnected' | 'monitoring';
  text: string;
}

export interface WebviewIncoming {
  command: 'ready';
}

export interface WebviewOutgoing {
  command: 'sync' | 'clear' | 'setStatus';
  snapshot?: MonitorSnapshot;
  status?: MonitorStatus['status'];
  text?: string;
}

export function cloneTurn(turn: ConversationTurn): ConversationTurn {
  return {
    ...turn,
    blocks: {
      'user-input': { ...turn.blocks['user-input'] },
      'agent-thinking': { ...turn.blocks['agent-thinking'] },
      'agent-output': { ...turn.blocks['agent-output'] },
    },
  };
}

export function cloneChat(chat: ConversationChat): ConversationChat {
  return {
    ...chat,
    turns: chat.turns.map((turn) => cloneTurn(turn)),
  };
}

export function cloneCollection(collection: ConversationCollection): ConversationCollection {
  return {
    chats: collection.chats.map((chat) => cloneChat(chat)),
    selectedChatId: collection.selectedChatId,
  };
}

export function cloneSnapshot(snapshot: MonitorSnapshot): MonitorSnapshot {
  return {
    ...cloneCollection(snapshot),
    app: snapshot.app,
    appLabel: snapshot.appLabel,
  };
}
