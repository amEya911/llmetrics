import * as vscode from 'vscode';
import { ConversationStoreWatcher } from './ConversationStoreWatcher';
import { NetworkInterceptor } from './NetworkInterceptor';
import {
  BLOCK_TYPES,
  BlockType,
  cloneChat,
  cloneCollection,
  cloneSnapshot,
  cloneTurn,
  ConversationChat,
  ConversationCollection,
  ConversationSegment,
  ConversationTurn,
  HostApp,
  MonitorMessage,
  MonitorSnapshot,
  MonitorStatus,
} from './types';

function createEmptySegment(): ConversationSegment {
  return {
    content: '',
    isStreaming: false,
  };
}

function createEmptyBlocks(): Record<BlockType, ConversationSegment> {
  return {
    'user-input': createEmptySegment(),
    'agent-thinking': createEmptySegment(),
    'agent-output': createEmptySegment(),
  };
}

export class AgentMonitor implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;
  private readonly storeWatcher: ConversationStoreWatcher;
  private readonly hostApp: HostApp;
  private readonly appLabel: string;
  private readonly runtimeChats = new Map<string, ConversationChat>();
  private readonly networkInterceptor?: NetworkInterceptor;

  private storeCollection: ConversationCollection = { chats: [] };
  private status: MonitorStatus = {
    status: 'monitoring',
    text: 'Listening for AI conversations...',
  };
  private chatCounter = 0;
  private turnCounter = 0;
  private activeRuntimeChatId?: string;
  private activeRuntimeTurnId?: string;

  private readonly _onSnapshotChanged = new vscode.EventEmitter<MonitorSnapshot>();
  readonly onSnapshotChanged = this._onSnapshotChanged.event;

  private readonly _onStatusChanged = new vscode.EventEmitter<MonitorStatus>();
  readonly onStatusChanged = this._onStatusChanged.event;

  constructor() {
    this.output = vscode.window.createOutputChannel('AI Agent Monitor');
    this.output.appendLine('AI Agent Monitor activated.');

    const host = detectHostApp();
    this.hostApp = host.app;
    this.appLabel = host.label;
    this.output.appendLine(`[host] Running inside ${this.appLabel}.`);

    this.storeWatcher = new ConversationStoreWatcher({
      onCollectionCaptured: (collection) => {
        this.storeCollection = cloneCollection(collection);
        this.emitSnapshot();
      },
    }, this.output, this.hostApp);
    this.disposables.push(this.storeWatcher);
    this.storeWatcher.start();

    if (this.hostApp === 'antigravity') {
      this.networkInterceptor = new NetworkInterceptor();
      this.disposables.push(this.networkInterceptor);
      this.setupAntigravityNetworkFallback(this.networkInterceptor);
      this.networkInterceptor.start();
      this.setStatus('monitoring', 'Antigravity chat capture enabled.');
    } else if (this.hostApp === 'cursor') {
      this.setStatus('monitoring', 'Cursor chat capture enabled.');
    } else {
      this.setStatus('monitoring', 'Chat capture enabled.');
    }
  }

  pushMessage(message: MonitorMessage): ConversationTurn {
    const chat = this.ensureRuntimeChat(this.getPreferredChatId() ?? this.createEphemeralChatId(), {
      title: 'Manual Capture',
      isEphemeral: true,
    });

    const turn = message.type === 'user-input'
      ? this.createRuntimeTurn(chat)
      : this.getLastOpenRuntimeTurn(chat) ?? this.createRuntimeTurn(chat);

    this.setBlockContent(chat, turn.id, message.type, message.content);

    if (message.type === 'agent-output') {
      this.finalizeTurn(chat, turn.id);
    }

    this.emitSnapshot();
    return cloneTurn(this.mustGetTurn(chat, turn.id));
  }

  clearBlocks(): void {
    this.runtimeChats.clear();
    this.activeRuntimeChatId = undefined;
    this.activeRuntimeTurnId = undefined;
    this.chatCounter = 0;
    this.turnCounter = 0;
    this.storeCollection = { chats: [] };
    this.storeWatcher.resetBaseline();
    this.emitSnapshot();
  }

  getSnapshot(): MonitorSnapshot {
    return cloneSnapshot(this.buildSnapshot());
  }

  getStatus(): MonitorStatus {
    return { ...this.status };
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this._onSnapshotChanged.dispose();
    this._onStatusChanged.dispose();
    this.output.dispose();
  }

  private setupAntigravityNetworkFallback(interceptor: NetworkInterceptor): void {
    this.disposables.push(
      interceptor.onUserMessage(({ content }) => {
        this.finishActiveRuntimeTurn();

        const chatId = this.resolveRuntimeChatIdForPrompt(content);
        const chat = this.ensureRuntimeChat(chatId, {
          title: snippetForTitle(content) ?? 'New chat',
          subtitle: snippetForSubtitle(content),
          isEphemeral: chatId.startsWith('live:'),
        });

        const turn = this.createRuntimeTurn(chat);
        this.activeRuntimeChatId = chat.id;
        this.activeRuntimeTurnId = turn.id;
        this.setBlockContent(chat, turn.id, 'user-input', content);
        this.setStatus('connected', 'Capturing Antigravity conversation...');
        this.emitSnapshot();
      })
    );

    this.disposables.push(
      interceptor.onAiResponseStart(() => {
        const turn = this.getOrCreateActiveRuntimeTurn();
        const chat = this.mustGetRuntimeChat(turn.chatId);
        this.startBlock(chat, turn.turnId, 'agent-output');
        this.setStatus('connected', 'Streaming Antigravity response...');
        this.emitSnapshot();
      })
    );

    this.disposables.push(
      interceptor.onAiResponseChunk(({ content }) => {
        if (!content) {
          return;
        }

        const turn = this.getOrCreateActiveRuntimeTurn();
        const chat = this.mustGetRuntimeChat(turn.chatId);
        this.appendToBlock(chat, turn.turnId, 'agent-output', content);
        this.emitSnapshot();
      })
    );

    this.disposables.push(
      interceptor.onAiResponseEnd(() => {
        this.finishActiveRuntimeTurn();
        this.setStatus('monitoring', 'Waiting for the next Antigravity conversation...');
        this.emitSnapshot();
      })
    );
  }

  private buildSnapshot(): MonitorSnapshot {
    const storeChats = this.storeCollection.chats.map((chat) => cloneChat(chat));
    const mergedById = new Map<string, ConversationChat>();

    for (const chat of storeChats) {
      mergedById.set(chat.id, chat);
    }

    for (const runtimeChat of this.runtimeChats.values()) {
      const existing = mergedById.get(runtimeChat.id);
      if (!existing) {
        mergedById.set(runtimeChat.id, cloneChat(runtimeChat));
        continue;
      }

      mergedById.set(runtimeChat.id, this.mergeChat(existing, runtimeChat));
    }

    const storeOrder = new Map<string, number>();
    storeChats.forEach((chat, index) => {
      storeOrder.set(chat.id, index);
    });

    const runtimeOnlyChats = [...this.runtimeChats.values()]
      .filter((chat) => !storeOrder.has(chat.id))
      .map((chat) => mergedById.get(chat.id)!)
      .sort((left, right) => right.updatedAt - left.updatedAt);

    const mergedChats = [
      ...runtimeOnlyChats,
      ...storeChats.map((chat) => mergedById.get(chat.id) ?? chat),
    ];

    return {
      app: this.hostApp,
      appLabel: this.appLabel,
      chats: mergedChats,
      selectedChatId: this.resolveSelectedChatId(mergedChats),
    };
  }

  private mergeChat(storeChat: ConversationChat, runtimeChat: ConversationChat): ConversationChat {
    const mergedTurns = storeChat.turns.map((turn) => cloneTurn(turn));

    for (const runtimeTurn of runtimeChat.turns) {
      const duplicateIndex = mergedTurns.findIndex((storeTurn) => turnsLikelyMatch(storeTurn, runtimeTurn));
      if (duplicateIndex === -1) {
        mergedTurns.push(cloneTurn(runtimeTurn));
        continue;
      }

      mergedTurns[duplicateIndex] = mergeTurns(mergedTurns[duplicateIndex], runtimeTurn);
    }

    mergedTurns.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }

      return left.id.localeCompare(right.id);
    });

    const latestTurn = mergedTurns[mergedTurns.length - 1];

    return {
      ...cloneChat(storeChat),
      subtitle: storeChat.subtitle
        ?? runtimeChat.subtitle
        ?? snippetForSubtitle(latestTurn?.blocks['agent-output'].content)
        ?? snippetForSubtitle(latestTurn?.blocks['user-input'].content),
      updatedAt: Math.max(storeChat.updatedAt, runtimeChat.updatedAt),
      turns: mergedTurns,
    };
  }

  private resolveSelectedChatId(chats: ConversationChat[]): string | undefined {
    const preferred = this.storeCollection.selectedChatId;
    if (preferred && chats.some((chat) => chat.id === preferred)) {
      return preferred;
    }

    if (this.activeRuntimeChatId && chats.some((chat) => chat.id === this.activeRuntimeChatId)) {
      return this.activeRuntimeChatId;
    }

    return chats[0]?.id;
  }

  private resolveRuntimeChatIdForPrompt(content: string): string {
    const preferred = this.getPreferredChatId();
    if (preferred) {
      return preferred;
    }

    const normalizedPrompt = normalizeComparableText(content);
    for (const chat of this.storeCollection.chats) {
      const normalizedTitle = normalizeComparableText(chat.title);
      if (!normalizedTitle) {
        continue;
      }

      if (normalizedTitle === normalizedPrompt || normalizedPrompt.startsWith(normalizedTitle)) {
        return chat.id;
      }
    }

    return this.createEphemeralChatId();
  }

  private getPreferredChatId(): string | undefined {
    if (this.storeCollection.selectedChatId) {
      return this.storeCollection.selectedChatId;
    }

    if (this.storeCollection.chats.length === 1) {
      return this.storeCollection.chats[0].id;
    }

    return undefined;
  }

  private createEphemeralChatId(): string {
    return `live:${++this.chatCounter}`;
  }

  private ensureRuntimeChat(
    chatId: string,
    options: { title: string; subtitle?: string; isEphemeral?: boolean }
  ): ConversationChat {
    const existing = this.runtimeChats.get(chatId);
    if (existing) {
      if (!existing.title && options.title) {
        existing.title = options.title;
      }
      if (!existing.subtitle && options.subtitle) {
        existing.subtitle = options.subtitle;
      }
      return existing;
    }

    const storeChat = this.storeCollection.chats.find((chat) => chat.id === chatId);
    const now = Date.now();
    const next: ConversationChat = {
      id: chatId,
      title: storeChat?.title ?? options.title,
      subtitle: storeChat?.subtitle ?? options.subtitle,
      createdAt: now,
      updatedAt: now,
      turns: [],
      isEphemeral: options.isEphemeral,
    };

    this.runtimeChats.set(chatId, next);
    return next;
  }

  private createRuntimeTurn(chat: ConversationChat): ConversationTurn {
    const now = Date.now();
    const turn: ConversationTurn = {
      id: `runtime:${++this.turnCounter}`,
      createdAt: now,
      updatedAt: now,
      isComplete: false,
      blocks: createEmptyBlocks(),
    };

    chat.turns.push(turn);
    chat.updatedAt = now;
    return turn;
  }

  private getOrCreateActiveRuntimeTurn(): { chatId: string; turnId: string } {
    if (this.activeRuntimeChatId && this.activeRuntimeTurnId) {
      const chat = this.runtimeChats.get(this.activeRuntimeChatId);
      const turn = chat?.turns.find((candidate) => candidate.id === this.activeRuntimeTurnId);
      if (chat && turn) {
        return {
          chatId: chat.id,
          turnId: turn.id,
        };
      }
    }

    const chat = this.ensureRuntimeChat(this.getPreferredChatId() ?? this.createEphemeralChatId(), {
      title: 'Live Capture',
      isEphemeral: true,
    });
    const turn = this.createRuntimeTurn(chat);
    this.activeRuntimeChatId = chat.id;
    this.activeRuntimeTurnId = turn.id;
    return {
      chatId: chat.id,
      turnId: turn.id,
    };
  }

  private finishActiveRuntimeTurn(): void {
    if (!this.activeRuntimeChatId || !this.activeRuntimeTurnId) {
      return;
    }

    const chat = this.runtimeChats.get(this.activeRuntimeChatId);
    if (chat) {
      this.finalizeTurn(chat, this.activeRuntimeTurnId);
    }

    this.activeRuntimeChatId = undefined;
    this.activeRuntimeTurnId = undefined;
  }

  private getLastOpenRuntimeTurn(chat: ConversationChat): ConversationTurn | undefined {
    for (let index = chat.turns.length - 1; index >= 0; index -= 1) {
      const turn = chat.turns[index];
      if (!turn.isComplete) {
        return turn;
      }
    }

    return undefined;
  }

  private mustGetRuntimeChat(chatId: string): ConversationChat {
    const chat = this.runtimeChats.get(chatId);
    if (!chat) {
      throw new Error(`Unknown runtime chat: ${chatId}`);
    }

    return chat;
  }

  private mustGetTurn(chat: ConversationChat, turnId: string): ConversationTurn {
    const turn = chat.turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      throw new Error(`Unknown conversation turn: ${turnId}`);
    }

    return turn;
  }

  private setBlockContent(chat: ConversationChat, turnId: string, blockType: BlockType, content: string): void {
    const turn = this.mustGetTurn(chat, turnId);
    turn.blocks[blockType].content = content;
    turn.blocks[blockType].isStreaming = false;
    if (blockType === 'agent-output') {
      chat.subtitle = snippetForSubtitle(content) ?? chat.subtitle;
    } else if (blockType === 'user-input' && !chat.subtitle) {
      chat.subtitle = snippetForSubtitle(content);
    }
    this.touchTurn(chat, turn);
  }

  private startBlock(chat: ConversationChat, turnId: string, blockType: BlockType): void {
    const turn = this.mustGetTurn(chat, turnId);
    turn.blocks[blockType].isStreaming = true;
    this.touchTurn(chat, turn);
  }

  private appendToBlock(chat: ConversationChat, turnId: string, blockType: BlockType, content: string): void {
    const turn = this.mustGetTurn(chat, turnId);
    const block = turn.blocks[blockType];
    if (!block.isStreaming) {
      block.isStreaming = true;
    }
    block.content += content;
    if (blockType === 'agent-output') {
      chat.subtitle = snippetForSubtitle(block.content) ?? chat.subtitle;
    }
    this.touchTurn(chat, turn);
  }

  private finalizeTurn(chat: ConversationChat, turnId: string): void {
    const turn = this.mustGetTurn(chat, turnId);
    for (const blockType of BLOCK_TYPES) {
      turn.blocks[blockType].isStreaming = false;
    }
    turn.isComplete = Boolean(turn.blocks['agent-output'].content);
    this.touchTurn(chat, turn);
  }

  private touchTurn(chat: ConversationChat, turn: ConversationTurn): void {
    turn.updatedAt = Date.now();
    chat.updatedAt = turn.updatedAt;
  }

  private emitSnapshot(): void {
    this._onSnapshotChanged.fire(this.getSnapshot());
  }

  private setStatus(status: MonitorStatus['status'], text: string): void {
    this.status = { status, text };
    this._onStatusChanged.fire({ ...this.status });
  }
}

function detectHostApp(): { app: HostApp; label: string } {
  const candidates = [
    vscode.env.appName,
    process.env.VSCODE_CWD,
    process.execPath,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());

  if (candidates.some((value) => value.includes('cursor'))) {
    return { app: 'cursor', label: 'Cursor' };
  }

  if (candidates.some((value) => value.includes('antigravity'))) {
    return { app: 'antigravity', label: 'Antigravity' };
  }

  return { app: 'unknown', label: vscode.env.appName || 'AI Sidebar' };
}

function mergeTurns(storeTurn: ConversationTurn, runtimeTurn: ConversationTurn): ConversationTurn {
  const next = cloneTurn(storeTurn);
  next.updatedAt = Math.max(storeTurn.updatedAt, runtimeTurn.updatedAt);
  next.isComplete = storeTurn.isComplete || runtimeTurn.isComplete;

  for (const blockType of BLOCK_TYPES) {
    const storeBlock = next.blocks[blockType];
    const runtimeBlock = runtimeTurn.blocks[blockType];

    if (!storeBlock.content && runtimeBlock.content) {
      storeBlock.content = runtimeBlock.content;
    } else if (runtimeBlock.isStreaming && runtimeBlock.content.length > storeBlock.content.length) {
      storeBlock.content = runtimeBlock.content;
    }

    storeBlock.isStreaming = storeBlock.isStreaming || runtimeBlock.isStreaming;
  }

  return next;
}

function turnsLikelyMatch(left: ConversationTurn, right: ConversationTurn): boolean {
  const leftUser = normalizeComparableText(left.blocks['user-input'].content);
  const rightUser = normalizeComparableText(right.blocks['user-input'].content);
  if (leftUser && rightUser && leftUser === rightUser) {
    return true;
  }

  const leftOutput = normalizeComparableText(left.blocks['agent-output'].content);
  const rightOutput = normalizeComparableText(right.blocks['agent-output'].content);
  if (leftOutput && rightOutput && leftOutput === rightOutput) {
    return true;
  }

  return Math.abs(left.createdAt - right.createdAt) < 4000 && Boolean(leftUser || leftOutput);
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function snippetForTitle(value?: string): string | undefined {
  const line = (value ?? '').split('\n')[0]?.trim();
  if (!line) {
    return undefined;
  }

  return line.length <= 80
    ? line
    : `${line.slice(0, 77).trimEnd()}...`;
}

function snippetForSubtitle(value?: string): string | undefined {
  const line = (value ?? '').split('\n')[0]?.replace(/\s+/g, ' ').trim();
  if (!line) {
    return undefined;
  }

  return line.length <= 110
    ? line
    : `${line.slice(0, 107).trimEnd()}...`;
}
