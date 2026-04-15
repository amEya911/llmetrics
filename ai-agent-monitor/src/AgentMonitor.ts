import * as vscode from 'vscode';
import { ConversationStoreWatcher } from './ConversationStoreWatcher';
import { buildDashboardSnapshot, createDefaultBudgets } from './dashboard';
import {
  buildAppStoragePathCandidates,
  firstExistingPath,
  formatError,
  readMergedSqliteKeyMap,
} from './stateSqlite';
import {
  BLOCK_TYPES,
  BlockType,
  cloneCollection,
  cloneSnapshot,
  cloneTurn,
  ConversationChat,
  ConversationCollection,
  ConversationSegment,
  ConversationTurn,
  HostApp,
  ModelConfidence,
  MonitorMessage,
  MonitorSnapshot,
  MonitorStatus,
  SavedPrompt,
  SourceSnapshot,
  WebviewIncoming,
} from './types';

const PROMPT_LIBRARY_KEY = 'aiAgentMonitor.promptLibrary';
const BUDGET_SETTINGS_KEY = 'aiAgentMonitor.budgetSettings';
const CURSOR_APP_STATE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

const SOURCE_LABELS: Record<'cursor' | 'antigravity' | 'manual', string> = {
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  manual: 'Manual API',
};

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

interface CursorModelState {
  model?: string;
  confidence: ModelConfidence;
}

interface SourceAttentionState {
  requestSeq: number;
  selectedChatKey?: string;
  selectedChatUpdatedAt: number;
  promptCount: number;
  latestUserTurnSignature?: string;
  lastEngagedAt: number;
}

interface CollectionAttention {
  chat: ConversationChat;
  key: string;
  promptCount: number;
  latestUserTurnSignature?: string;
}

export class AgentMonitor implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;
  private readonly sourceWatchers = new Map<'cursor' | 'antigravity', ConversationStoreWatcher>();
  private readonly extensionContext: vscode.ExtensionContext;
  private readonly hostApp: HostApp;
  private readonly appLabel: string;

  private readonly runtimeChats = new Map<string, ConversationChat>();
  private readonly sourceCollections = new Map<'cursor' | 'antigravity', ConversationCollection>();
  private readonly sourceAttention = new Map<'cursor' | 'antigravity', SourceAttentionState>();

  private status: MonitorStatus = {
    status: 'monitoring',
    text: 'Building the AI analytics dashboard...',
  };

  private promptLibrary: SavedPrompt[];
  private budgets = createDefaultBudgets();
  private chatCounter = 0;
  private turnCounter = 0;
  private activeRuntimeChatId?: string;
  private activeRuntimeTurnId?: string;
  private activeChatKey?: string;
  private activeChatEngagedAt = 0;
  private lastAlertIds = new Set<string>();

  private readonly _onSnapshotChanged = new vscode.EventEmitter<MonitorSnapshot>();
  readonly onSnapshotChanged = this._onSnapshotChanged.event;

  private readonly _onStatusChanged = new vscode.EventEmitter<MonitorStatus>();
  readonly onStatusChanged = this._onStatusChanged.event;

  constructor(context: vscode.ExtensionContext) {
    this.extensionContext = context;
    this.output = vscode.window.createOutputChannel('AI Token Analytics');
    this.output.appendLine('AI Token Analytics dashboard activated.');

    const host = detectHostApp();
    this.hostApp = host.app;
    this.appLabel = host.label;
    this.output.appendLine(`[host] Running inside ${this.appLabel}.`);

    this.promptLibrary = loadPromptLibrary(context.globalState.get<unknown>(PROMPT_LIBRARY_KEY));
    this.budgets = sanitizeBudgetSettings(context.globalState.get<unknown>(BUDGET_SETTINGS_KEY));

    this.startWatcher('cursor');
    this.startWatcher('antigravity');

    this.setStatus('monitoring', 'Tracking live AI usage across Cursor and Antigravity...');
  }

  pushMessage(message: MonitorMessage): ConversationTurn {
    const chat = this.ensureRuntimeChat(this.activeRuntimeChatId ?? this.createRuntimeChatId(), {
      title: message.sourceLabel ? `${message.sourceLabel} session` : 'Manual capture',
      sourceLabel: message.sourceLabel ?? SOURCE_LABELS.manual,
      model: message.model,
    });

    const turn = message.type === 'user-input'
      ? this.createRuntimeTurn(chat)
      : this.getLastOpenRuntimeTurn(chat) ?? this.createRuntimeTurn(chat);

    this.setBlockContent(chat, turn.id, message.type, message.content);
    if (message.model) {
      chat.model = message.model;
      chat.modelConfidence = 'exact';
    }

    if (message.type === 'agent-output') {
      this.finalizeTurn(chat, turn.id);
    }

    this.activeRuntimeChatId = chat.id;
    this.activeRuntimeTurnId = turn.id;
    this.activeChatKey = `manual:${chat.id}`;
    this.activeChatEngagedAt = Date.now();
    this.emitSnapshot();
    return cloneTurn(this.mustGetTurn(chat, turn.id));
  }

  clearBlocks(): void {
    this.runtimeChats.clear();
    this.sourceCollections.clear();
    this.chatCounter = 0;
    this.turnCounter = 0;
    this.activeRuntimeChatId = undefined;
    this.activeRuntimeTurnId = undefined;
    this.activeChatKey = undefined;
    this.activeChatEngagedAt = 0;

    for (const sourceId of ['cursor', 'antigravity'] as const) {
      const previous = this.sourceAttention.get(sourceId);
      this.sourceAttention.set(sourceId, {
        requestSeq: previous?.requestSeq ?? 0,
        selectedChatUpdatedAt: 0,
        promptCount: 0,
        lastEngagedAt: 0,
      });
    }

    for (const watcher of this.sourceWatchers.values()) {
      watcher.resetBaseline();
    }

    this.emitSnapshot();
  }

  getSnapshot(): MonitorSnapshot {
    return cloneSnapshot(this.buildSnapshot());
  }

  getStatus(): MonitorStatus {
    return { ...this.status };
  }

  handleWebviewMessage(message: WebviewIncoming): void {
    switch (message.command) {
      case 'ready':
        return;
      case 'savePrompt':
        this.savePromptFromTurn(message);
        return;
      case 'copyPrompt':
        void this.copyPrompt(message.promptId);
        return;
      case 'deletePrompt':
        this.deletePrompt(message.promptId);
        return;
      case 'markPromptUsed':
        this.markPromptUsed(message.promptId);
        return;
      case 'updateBudgets':
        this.updateBudgets(message.budgets);
        return;
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this._onSnapshotChanged.dispose();
    this._onStatusChanged.dispose();
    this.output.dispose();
  }

  private startWatcher(sourceId: 'cursor' | 'antigravity'): void {
    const existing = this.sourceAttention.get(sourceId);
    this.sourceAttention.set(sourceId, {
      requestSeq: existing?.requestSeq ?? 0,
      selectedChatUpdatedAt: existing?.selectedChatUpdatedAt ?? 0,
      promptCount: existing?.promptCount ?? 0,
      lastEngagedAt: existing?.lastEngagedAt ?? 0,
      selectedChatKey: existing?.selectedChatKey,
      latestUserTurnSignature: existing?.latestUserTurnSignature,
    });

    const watcher = new ConversationStoreWatcher({
      onCollectionCaptured: (collection) => {
        void this.handleSourceCollection(sourceId, collection);
      },
    }, this.output, sourceId);

    this.sourceWatchers.set(sourceId, watcher);
    this.disposables.push(watcher);
    watcher.start();
  }

  private async handleSourceCollection(
    sourceId: 'cursor' | 'antigravity',
    collection: ConversationCollection
  ): Promise<void> {
    const nextRequestSeq = (this.sourceAttention.get(sourceId)?.requestSeq ?? 0) + 1;
    this.sourceAttention.set(sourceId, {
      ...(this.sourceAttention.get(sourceId) ?? {
        selectedChatUpdatedAt: 0,
        promptCount: 0,
        lastEngagedAt: 0,
      }),
      requestSeq: nextRequestSeq,
    });

    const decorated = await this.decorateCollection(sourceId, collection);
    const latestState = this.sourceAttention.get(sourceId);
    if (!latestState || latestState.requestSeq !== nextRequestSeq) {
      return;
    }

    this.sourceCollections.set(sourceId, cloneCollection(decorated));
    this.updateActiveChatLock(sourceId, decorated);
    this.emitSnapshot();
  }

  private async decorateCollection(
    sourceId: 'cursor' | 'antigravity',
    collection: ConversationCollection
  ): Promise<ConversationCollection> {
    const next = cloneCollection(collection);
    const cursorModelState = sourceId === 'cursor'
      ? await this.readCursorModelState()
      : undefined;

    next.chats = next.chats.map((chat) => {
      const model = sourceId === 'cursor'
        ? cursorModelState?.model
        : chat.model;

      return {
        ...chat,
        sourceId,
        sourceLabel: SOURCE_LABELS[sourceId],
        model: model ?? chat.model,
        modelConfidence: sourceId === 'cursor'
          ? cursorModelState?.confidence ?? chat.modelConfidence ?? 'unknown'
          : chat.modelConfidence ?? (chat.model ? 'inferred' : 'unknown'),
      };
    });

    return next;
  }

  private buildSnapshot(): MonitorSnapshot {
    return buildDashboardSnapshot({
      app: this.hostApp,
      appLabel: this.appLabel,
      sources: this.buildSourceSnapshots(),
      activeChatKey: this.activeChatKey,
      promptLibrary: this.promptLibrary,
      budgets: this.budgets,
    });
  }

  private buildSourceSnapshots(): SourceSnapshot[] {
    const sources: SourceSnapshot[] = [];

    for (const sourceId of ['cursor', 'antigravity'] as const) {
      const collection = this.sourceCollections.get(sourceId);
      if (!collection) {
        continue;
      }

      sources.push({
        id: sourceId,
        label: SOURCE_LABELS[sourceId],
        chats: collection.chats.map((chat) => ({ ...chat })),
        selectedChatId: collection.selectedChatId,
      });
    }

    if (this.runtimeChats.size > 0) {
      const chats = [...this.runtimeChats.values()]
        .map((chat) => ({ ...chat }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
      sources.push({
        id: 'manual',
        label: SOURCE_LABELS.manual,
        chats,
        selectedChatId: chats[0]?.id,
      });
    }

    return sources;
  }

  private async readCursorModelState(): Promise<CursorModelState> {
    const dbPath = await firstExistingPath(
      buildAppStoragePathCandidates('Cursor', 'User', 'globalStorage', 'state.vscdb')
    );
    const values = dbPath
      ? await readMergedSqliteKeyMap(dbPath, [CURSOR_APP_STATE_KEY])
      : {};
    const raw = values[CURSOR_APP_STATE_KEY];

    let state: CursorModelState = {
      model: 'Auto',
      confidence: 'inferred',
    };

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as any;
        const configuredModel = parsed?.aiSettings?.modelConfig?.composer?.modelName
          ?? parsed?.aiSettings?.composerModel;
        if (typeof configuredModel === 'string' && configuredModel.trim()) {
          state = {
            model: configuredModel === 'default' ? 'Auto' : configuredModel,
            confidence: configuredModel === 'default' ? 'inferred' : 'exact',
          };
        }
      } catch (error) {
        this.output.appendLine(`[cursor] Failed to parse model state: ${formatError(error)}`);
      }
    }

    return state;
  }

  private savePromptFromTurn(message: WebviewIncoming): void {
    if (!message.sourceId || !message.chatId || !message.turnId) {
      return;
    }

    const turnContext = this.findTurn(message.sourceId, message.chatId, message.turnId);
    if (!turnContext) {
      return;
    }

    const promptText = turnContext.turn.blocks['user-input'].content.trim();
    if (!promptText) {
      return;
    }

    const title = message.title?.trim() || summarizeForTitle(promptText);
    const tags = [...new Set((message.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
    const now = Date.now();

    this.promptLibrary = [
      {
        id: `prompt:${now}:${Math.random().toString(16).slice(2, 8)}`,
        title,
        content: promptText,
        tags,
        createdAt: now,
        updatedAt: now,
        sourceId: message.sourceId,
        sourceLabel: turnContext.chat.sourceLabel,
        model: turnContext.turn.model ?? turnContext.chat.model,
        useCount: 0,
        efficiencyScore: turnContext.turn.assessment?.score,
      },
      ...this.promptLibrary,
    ];

    void this.extensionContext.globalState.update(PROMPT_LIBRARY_KEY, this.promptLibrary);
    this.emitSnapshot();
  }

  private async copyPrompt(promptId: string | undefined): Promise<void> {
    if (!promptId) {
      return;
    }

    const prompt = this.promptLibrary.find((candidate) => candidate.id === promptId);
    if (!prompt) {
      return;
    }

    await vscode.env.clipboard.writeText(prompt.content);
    this.markPromptUsed(promptId);
  }

  private deletePrompt(promptId: string | undefined): void {
    if (!promptId) {
      return;
    }

    this.promptLibrary = this.promptLibrary.filter((prompt) => prompt.id !== promptId);
    void this.extensionContext.globalState.update(PROMPT_LIBRARY_KEY, this.promptLibrary);
    this.emitSnapshot();
  }

  private markPromptUsed(promptId: string | undefined): void {
    if (!promptId) {
      return;
    }

    const now = Date.now();
    this.promptLibrary = this.promptLibrary.map((prompt) => {
      if (prompt.id !== promptId) {
        return prompt;
      }

      return {
        ...prompt,
        useCount: prompt.useCount + 1,
        lastUsedAt: now,
        updatedAt: now,
      };
    });

    void this.extensionContext.globalState.update(PROMPT_LIBRARY_KEY, this.promptLibrary);
    this.emitSnapshot();
  }

  private updateBudgets(nextBudgets: unknown): void {
    this.budgets = sanitizeBudgetSettings(nextBudgets);
    void this.extensionContext.globalState.update(BUDGET_SETTINGS_KEY, this.budgets);
    this.emitSnapshot();
  }

  private findTurn(sourceId: 'cursor' | 'antigravity' | 'manual', chatId: string, turnId: string): {
    chat: ConversationChat;
    turn: ConversationTurn;
  } | undefined {
    const source = this.buildSourceSnapshots().find((candidate) => candidate.id === sourceId);
    const chat = source?.chats.find((candidate) => candidate.id === chatId);
    const turn = chat?.turns.find((candidate) => candidate.id === turnId);

    if (!chat || !turn) {
      return undefined;
    }

    return { chat, turn };
  }

  private ensureRuntimeChat(
    chatId: string,
    options: { title: string; sourceLabel: string; model?: string }
  ): ConversationChat {
    const existing = this.runtimeChats.get(chatId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const next: ConversationChat = {
      id: chatId,
      title: options.title,
      createdAt: now,
      updatedAt: now,
      turns: [],
      isEphemeral: true,
      sourceId: 'manual',
      sourceLabel: options.sourceLabel,
      model: options.model,
      modelConfidence: options.model ? 'exact' : 'unknown',
    };

    this.runtimeChats.set(chatId, next);
    return next;
  }

  private createRuntimeChatId(): string {
    return `manual-chat:${++this.chatCounter}`;
  }

  private createRuntimeTurn(chat: ConversationChat): ConversationTurn {
    const now = Date.now();
    const turn: ConversationTurn = {
      id: `runtime-turn:${++this.turnCounter}`,
      createdAt: now,
      updatedAt: now,
      isComplete: false,
      blocks: createEmptyBlocks(),
    };

    chat.turns.push(turn);
    chat.updatedAt = now;
    return turn;
  }

  private getLastOpenRuntimeTurn(chat: ConversationChat): ConversationTurn | undefined {
    for (let index = chat.turns.length - 1; index >= 0; index -= 1) {
      if (!chat.turns[index].isComplete) {
        return chat.turns[index];
      }
    }

    return undefined;
  }

  private mustGetTurn(chat: ConversationChat, turnId: string): ConversationTurn {
    const turn = chat.turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      throw new Error(`Unknown turn: ${turnId}`);
    }

    return turn;
  }

  private setBlockContent(chat: ConversationChat, turnId: string, blockType: BlockType, content: string): void {
    const turn = this.mustGetTurn(chat, turnId);
    turn.blocks[blockType].content = content;
    turn.blocks[blockType].isStreaming = false;

    if (blockType === 'agent-output') {
      chat.subtitle = summarizeForSubtitle(content) ?? chat.subtitle;
    } else if (blockType === 'user-input' && !chat.subtitle) {
      chat.subtitle = summarizeForSubtitle(content);
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
    const snapshot = this.getSnapshot();
    this.notifyBudgetAlerts(snapshot);
    this._onSnapshotChanged.fire(snapshot);
  }

  private notifyBudgetAlerts(snapshot: MonitorSnapshot): void {
    const nextAlertIds = new Set(snapshot.alerts.map((alert) => alert.id));
    for (const alert of snapshot.alerts) {
      if ((alert.level === 'warn' || alert.level === 'critical') && !this.lastAlertIds.has(alert.id)) {
        void vscode.window.showWarningMessage(`${alert.title}: ${alert.detail}`);
      }
    }
    this.lastAlertIds = nextAlertIds;
  }

  private setStatus(status: MonitorStatus['status'], text: string): void {
    this.status = { status, text };
    this._onStatusChanged.fire({ ...this.status });
  }

  private updateActiveChatLock(
    sourceId: 'cursor' | 'antigravity',
    collection: ConversationCollection
  ): void {
    const attention = extractCollectionAttention(sourceId, collection);
    const previous = this.sourceAttention.get(sourceId) ?? {
      requestSeq: 0,
      selectedChatUpdatedAt: 0,
      promptCount: 0,
      lastEngagedAt: 0,
    };

    if (!attention) {
      this.sourceAttention.set(sourceId, {
        ...previous,
        selectedChatKey: undefined,
        selectedChatUpdatedAt: 0,
        promptCount: 0,
        latestUserTurnSignature: undefined,
      });
      this.reconcileActiveChatLock();
      return;
    }

    const selectionChanged = previous.selectedChatKey !== undefined && previous.selectedChatKey !== attention.key;
    const promptChanged = previous.selectedChatKey === attention.key
      && (
        attention.promptCount > previous.promptCount
        || (
          attention.latestUserTurnSignature !== undefined
          && attention.latestUserTurnSignature !== previous.latestUserTurnSignature
        )
      );
    const streamUpdated = attention.chat.updatedAt > previous.selectedChatUpdatedAt;

    const nextState: SourceAttentionState = {
      requestSeq: previous.requestSeq,
      selectedChatKey: attention.key,
      selectedChatUpdatedAt: attention.chat.updatedAt,
      promptCount: attention.promptCount,
      latestUserTurnSignature: attention.latestUserTurnSignature,
      lastEngagedAt: previous.lastEngagedAt,
    };

    if (selectionChanged || promptChanged) {
      nextState.lastEngagedAt = Date.now();
    } else if (!previous.selectedChatKey) {
      nextState.lastEngagedAt = attention.chat.updatedAt;
    }

    this.sourceAttention.set(sourceId, nextState);

    if (!this.activeChatKey) {
      this.activeChatKey = attention.key;
      this.activeChatEngagedAt = nextState.lastEngagedAt || attention.chat.updatedAt;
      return;
    }

    if (this.activeChatKey === attention.key) {
      this.activeChatEngagedAt = Math.max(
        this.activeChatEngagedAt,
        nextState.lastEngagedAt,
        attention.chat.updatedAt
      );
      return;
    }

    if (selectionChanged || promptChanged) {
      if (nextState.lastEngagedAt >= this.activeChatEngagedAt) {
        this.activeChatKey = attention.key;
        this.activeChatEngagedAt = nextState.lastEngagedAt;
      }
      return;
    }

    if (nextState.lastEngagedAt > this.activeChatEngagedAt) {
      this.activeChatKey = attention.key;
      this.activeChatEngagedAt = nextState.lastEngagedAt;
      return;
    }

    const activeSourceId = extractSourceId(this.activeChatKey);
    if (activeSourceId === sourceId && streamUpdated) {
      this.activeChatKey = attention.key;
      this.activeChatEngagedAt = Math.max(this.activeChatEngagedAt, attention.chat.updatedAt);
      return;
    }

    this.reconcileActiveChatLock();
  }

  private reconcileActiveChatLock(): void {
    const allSnapshots = this.buildSourceSnapshots();

    if (this.activeChatKey && snapshotContainsChat(allSnapshots, this.activeChatKey)) {
      return;
    }

    let bestCandidate: { key: string; engagedAt: number; updatedAt: number } | undefined;
    for (const sourceId of ['cursor', 'antigravity'] as const) {
      const state = this.sourceAttention.get(sourceId);
      if (!state?.selectedChatKey) {
        continue;
      }

      const chat = findChatByKey(allSnapshots, state.selectedChatKey);
      if (!chat) {
        continue;
      }

      const candidate = {
        key: state.selectedChatKey,
        engagedAt: state.lastEngagedAt,
        updatedAt: chat.updatedAt,
      };

      if (
        !bestCandidate
        || candidate.engagedAt > bestCandidate.engagedAt
        || (
          candidate.engagedAt === bestCandidate.engagedAt
          && candidate.updatedAt > bestCandidate.updatedAt
        )
      ) {
        bestCandidate = candidate;
      }
    }

    if (bestCandidate) {
      this.activeChatKey = bestCandidate.key;
      this.activeChatEngagedAt = Math.max(bestCandidate.engagedAt, bestCandidate.updatedAt);
      return;
    }

    const fallback = allSnapshots
      .flatMap((source) => source.chats.map((chat) => ({
        key: toChatKey(source.id, chat.id),
        updatedAt: chat.updatedAt,
      })))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];

    this.activeChatKey = fallback?.key;
    this.activeChatEngagedAt = fallback?.updatedAt ?? 0;
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

  return { app: 'unknown', label: vscode.env.appName || 'VS Code' };
}

function summarizeForTitle(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return 'Saved prompt';
  }

  return singleLine.length <= 64
    ? singleLine
    : `${singleLine.slice(0, 61).trimEnd()}...`;
}

function summarizeForSubtitle(value?: string): string | undefined {
  const singleLine = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return undefined;
  }

  return singleLine.length <= 110
    ? singleLine
    : `${singleLine.slice(0, 107).trimEnd()}...`;
}

function loadPromptLibrary(rawValue: unknown): SavedPrompt[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }

    const prompt = candidate as Partial<SavedPrompt>;
    if (typeof prompt.id !== 'string' || typeof prompt.title !== 'string' || typeof prompt.content !== 'string') {
      return [];
    }

    return [{
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
      tags: Array.isArray(prompt.tags) ? prompt.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      createdAt: toFiniteNumber(prompt.createdAt) ?? Date.now(),
      updatedAt: toFiniteNumber(prompt.updatedAt) ?? toFiniteNumber(prompt.createdAt) ?? Date.now(),
      sourceId: prompt.sourceId === 'cursor' || prompt.sourceId === 'antigravity' || prompt.sourceId === 'manual'
        ? prompt.sourceId
        : undefined,
      sourceLabel: typeof prompt.sourceLabel === 'string' ? prompt.sourceLabel : undefined,
      model: typeof prompt.model === 'string' ? prompt.model : undefined,
      useCount: toFiniteNumber(prompt.useCount) ?? 0,
      lastUsedAt: toFiniteNumber(prompt.lastUsedAt),
      efficiencyScore: toFiniteNumber(prompt.efficiencyScore),
    }];
  });
}

function sanitizeBudgetSettings(rawValue: unknown) {
  const defaults = createDefaultBudgets();
  if (!rawValue || typeof rawValue !== 'object') {
    return defaults;
  }

  const value = rawValue as Record<string, unknown>;
  return {
    dailyCostUsd: toNullableBudgetNumber(value.dailyCostUsd),
    monthlyCostUsd: toNullableBudgetNumber(value.monthlyCostUsd),
    dailyTokens: toNullableBudgetNumber(value.dailyTokens),
    monthlyTokens: toNullableBudgetNumber(value.monthlyTokens),
  };
}

function toNullableBudgetNumber(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return null;
  }

  return parsed;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function extractCollectionAttention(
  sourceId: 'cursor' | 'antigravity',
  collection: ConversationCollection
): CollectionAttention | undefined {
  const chat = collection.chats.find((candidate) => candidate.id === collection.selectedChatId)
    ?? collection.chats[0];
  if (!chat) {
    return undefined;
  }

  let promptCount = 0;
  let latestUserTurn: ConversationTurn | undefined;
  for (const turn of chat.turns) {
    if (!turn.blocks['user-input'].content.trim()) {
      continue;
    }

    promptCount += 1;
    if (!latestUserTurn || turn.updatedAt >= latestUserTurn.updatedAt) {
      latestUserTurn = turn;
    }
  }

  return {
    chat,
    key: toChatKey(sourceId, chat.id),
    promptCount,
    latestUserTurnSignature: latestUserTurn
      ? `${latestUserTurn.id}:${normalizeComparableText(latestUserTurn.blocks['user-input'].content).slice(0, 240)}`
      : undefined,
  };
}

function snapshotContainsChat(sources: SourceSnapshot[], chatKey: string): boolean {
  return Boolean(findChatByKey(sources, chatKey));
}

function findChatByKey(sources: SourceSnapshot[], chatKey: string): ConversationChat | undefined {
  const sourceId = extractSourceId(chatKey);
  const chatId = extractChatId(chatKey);
  return sources.find((source) => source.id === sourceId)?.chats.find((chat) => chat.id === chatId);
}

function toChatKey(sourceId: string, chatId: string): string {
  return `${sourceId}:${chatId}`;
}

function extractSourceId(chatKey: string): string {
  const separatorIndex = chatKey.indexOf(':');
  return separatorIndex === -1 ? chatKey : chatKey.slice(0, separatorIndex);
}

function extractChatId(chatKey: string): string {
  const separatorIndex = chatKey.indexOf(':');
  return separatorIndex === -1 ? '' : chatKey.slice(separatorIndex + 1);
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
