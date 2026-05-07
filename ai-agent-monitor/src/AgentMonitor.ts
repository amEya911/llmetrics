import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConversationStoreWatcher } from './ConversationStoreWatcher';
import {
  AntigravityLanguageServerCollector,
  AntigravityTurnUpdateEvent,
} from './AntigravityLanguageServerCollector';
import { CursorSiblingNetworkBridge } from './CursorSiblingNetworkBridge';
import { NetworkInterceptor } from './NetworkInterceptor';
import {
  buildDashboardSnapshot,
  createDefaultBudgets,
  createPersistedSessionSummary,
} from './dashboard';
import {
  analyzeChatWithGroq,
  generateFullSessionAnalysis,
  getAnalysisProviderState,
  renderFullSessionAnalysisHtml,
} from './groqClient';
import {
  buildAppStoragePathCandidates,
  extractCursorActiveComposerIds,
  firstExistingPath,
  formatError,
  readMergedSqliteKeyMap,
} from './stateSqlite';
import {
  BLOCK_TYPES,
  BlockType,
  CapturedTokenUsage,
  cloneChat,
  cloneCollection,
  cloneSnapshot,
  cloneTurn,
  CoachInsight,
  ConversationChat,
  ConversationCollection,
  ConversationSegment,
  ConversationTurn,
  HostApp,
  InterceptedRequestType,
  ModelConfidence,
  MonitorMessage,
    MonitorSnapshot,
    MonitorStatus,
    PersistedSessionSummary,
    SavedPrompt,
    SessionAnalysisState,
    SourceSnapshot,
    WebviewIncoming,
  } from './types';

const PROMPT_LIBRARY_KEY = 'aiAgentMonitor.promptLibrary';
const BUDGET_SETTINGS_KEY = 'aiAgentMonitor.budgetSettings';
const SESSION_SUMMARIES_KEY = 'aiAgentMonitor.sessionSummaries';
const CURSOR_APP_STATE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
const LIVE_TURN_SETTLE_MS = 10_000;
const CURSOR_PROVISIONAL_CHAT_GRACE_MS = 45_000;
const CURSOR_SELECTION_REFRESH_ATTEMPTS = 5;
const CURSOR_SELECTION_REFRESH_DELAY_MS = 160;
const CURSOR_TAB_SELECTION_POLL_MS = 250;
const ANTIGRAVITY_SELECTION_LOCK_MS = 2 * 60_000;
const ANTIGRAVITY_LATE_UPDATE_GRACE_MS = 60_000;

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
    'agent-subagent': createEmptySegment(),
    'agent-editor': createEmptySegment(),
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

interface AntigravityRequestBinding {
  chatId: string;
  turnId: string;
  requestType: InterceptedRequestType;
  liveTurnKey: string;
  childTurnId?: string;
}

interface CursorRequestBinding {
  chatId: string;
  chatConfidence: 'explicit' | 'selection';
  selectionSource: CursorSelectionSource;
  turnId: string;
  requestType: InterceptedRequestType;
  liveTurnKey: string;
  childTurnId?: string;
}

type CursorSelectionSource =
  | 'explicit'
  | 'tab'
  | 'provisional-tab'
  | 'pinned'
  | 'store'
  | 'open-turn'
  | 'ephemeral';

interface CursorTabSelection {
  chatId?: string;
  isNewChat: boolean;
  label?: string;
}

interface LiveTurnState {
  sourceId: 'cursor' | 'antigravity';
  chatKey: string;
  chatId: string;
  turnId: string;
  pendingRequestIds: Set<string>;
  settleHandle?: NodeJS.Timeout;
}

interface CursorInterceptedTurnStart {
  requestId: string;
  provider: string;
  prompt: string;
  requestType: InterceptedRequestType;
  model?: string;
  modelConfidence: ModelConfidence;
  chatId?: string;
  startedAt: number;
}

interface CursorInterceptedTurnChunk {
  requestId: string;
  provider: string;
  requestType: InterceptedRequestType;
  kind: 'agent-thinking' | 'agent-output';
  content: string;
}

interface CursorInterceptedTurnComplete extends CursorInterceptedTurnStart {
  completedAt: number;
  thinking: string;
  output: string;
}

export class AgentMonitor implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;
  private readonly sourceWatchers = new Map<'cursor' | 'antigravity', ConversationStoreWatcher>();
  private readonly extensionContext: vscode.ExtensionContext;
  private readonly hostApp: HostApp;
  private readonly appLabel: string;
  private cursorDiagnosticLogPath?: string;
  private cursorDiagnosticWrite: Promise<void> = Promise.resolve();
  private cursorTabSelectionPollHandle?: NodeJS.Timeout;

  private readonly runtimeChats = new Map<string, ConversationChat>();
  private readonly cursorLiveChats = new Map<string, ConversationChat>();
  private readonly cursorRequestBindings = new Map<string, CursorRequestBinding>();
  private readonly antigravityLiveChats = new Map<string, ConversationChat>();
  private readonly antigravityRequestBindings = new Map<string, AntigravityRequestBinding>();
  private readonly antigravityBindingCleanupHandles = new Map<string, NodeJS.Timeout>();
  private readonly liveTurns = new Map<string, LiveTurnState>();
  private readonly currentLiveTurnKeys = new Map<string, string>();
  private readonly sourceCollections = new Map<'cursor' | 'antigravity', ConversationCollection>();
  private readonly sourceAttention = new Map<'cursor' | 'antigravity', SourceAttentionState>();

  private status: MonitorStatus = {
    status: 'monitoring',
    text: 'Building the AI analytics dashboard...',
  };

  private promptLibrary: SavedPrompt[];
  private sessionSummaries: PersistedSessionSummary[];
  private budgets = createDefaultBudgets();
  private chatCounter = 0;
  private turnCounter = 0;
  private activeRuntimeChatId?: string;
  private activeRuntimeTurnId?: string;
  private activeChatKey?: string;
  private activeChatEngagedAt = 0;
  private lastAlertIds = new Set<string>();
  private cursorSelectedChatId?: string;
  private cursorActiveNewChatChatId?: string;
  private cursorTabIsNewChat = false;
  private antigravitySelectedChatId?: string;
  private antigravitySelectedChatLockedUntil = 0;

  private cursorInProcessInterceptor?: NetworkInterceptor;
  private cursorInterceptor?: CursorSiblingNetworkBridge;
  private antigravityCollector?: AntigravityLanguageServerCollector;
  private networkEmitHandle?: NodeJS.Timeout;

  private currentGroqInsights: CoachInsight[] = [];
  private groqInsightChatKey?: string;
  private groqDebounceHandle?: NodeJS.Timeout;
  private sessionAnalysisState: SessionAnalysisState = {
    isGenerating: false,
  };
  private lastSnapshot?: MonitorSnapshot;

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
    this.cursorDiagnosticLogPath = this.hostApp === 'cursor'
      ? path.join(os.tmpdir(), 'ai-token-analytics-cursor-network.log')
      : undefined;
    this.output.appendLine(`[host] Running inside ${this.appLabel}.`);

    this.promptLibrary = loadPromptLibrary(context.globalState.get<unknown>(PROMPT_LIBRARY_KEY));
    this.sessionSummaries = loadSessionSummaries(context.globalState.get<unknown>(SESSION_SUMMARIES_KEY));
    this.budgets = sanitizeBudgetSettings(context.globalState.get<unknown>(BUDGET_SETTINGS_KEY));

    for (const sourceId of this.getEnabledSourceIds()) {
      this.startWatcher(sourceId);
    }

    if (this.hostApp === 'cursor') {
      this.startCursorNetworkInterceptor();
      this.startCursorTabSelectionPoll();
    } else if (this.hostApp === 'antigravity') {
      this.startAntigravityCollector();
    }

    this.setStatus('monitoring', describeTrackingStatus(this.hostApp));
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
    this.triggerGroqAnalysis(chat);
    this.emitSnapshot();
    return cloneTurn(this.mustGetTurn(chat, turn.id));
  }

  clearBlocks(): void {
    this.flushNetworkEmit();
    this.clearLiveTurnState();
    this.clearAntigravityBindingCleanups();
    this.runtimeChats.clear();
    this.cursorLiveChats.clear();
    this.cursorRequestBindings.clear();
    this.antigravityLiveChats.clear();
    this.antigravityRequestBindings.clear();
    this.sourceCollections.clear();
    this.chatCounter = 0;
    this.turnCounter = 0;
    this.activeRuntimeChatId = undefined;
    this.activeRuntimeTurnId = undefined;
    this.activeChatKey = undefined;
    this.activeChatEngagedAt = 0;
    this.currentGroqInsights = [];
    this.groqInsightChatKey = undefined;
    this.cursorSelectedChatId = undefined;
    this.cursorActiveNewChatChatId = undefined;
    this.cursorTabIsNewChat = false;
    this.antigravitySelectedChatId = undefined;
    this.antigravitySelectedChatLockedUntil = 0;

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

  async generateSessionAnalysisReport(): Promise<void> {
    if (this.sessionAnalysisState.isGenerating) {
      return;
    }

    const snapshot = this.buildSnapshot();
    const activeChat = snapshot.activeChat;
    if (!activeChat) {
      void vscode.window.showInformationMessage('No active chat is available to analyze yet.');
      return;
    }

    if (!snapshot.analysisProvider.hasAnyKey) {
      const selection = await vscode.window.showInformationMessage(
        'Set a Gemini or Groq API key to enable full session analysis. Gemini is preferred when both are configured.',
        'Open Settings'
      );
      if (selection === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'aiAgentMonitor.geminiApiKey');
      }
      return;
    }

    this.sessionAnalysisState = {
      isGenerating: true,
      activeChatId: activeChat.id,
      lastGeneratedAt: this.sessionAnalysisState.lastGeneratedAt,
    };
    this.emitSnapshot();

    try {
      const report = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating full session analysis',
        },
        async () => {
          return generateFullSessionAnalysis(
            activeChat,
            snapshot.analytics.patterns,
            this.sessionSummaries
          );
        }
      );
      const html = renderFullSessionAnalysisHtml(
        activeChat,
        report,
        snapshot.analytics.patterns
      );

      const panel = vscode.window.createWebviewPanel(
        'aiAgentMonitor.fullSessionAnalysis',
        `Analysis: ${activeChat.title || 'Session'}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      panel.webview.html = html;

      // Pop it out into a standalone, detached floating window using VS Code's native floating windows
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      }, 100);

      this.sessionAnalysisState = {
        isGenerating: false,
        activeChatId: activeChat.id,
        lastGeneratedAt: Date.now(),
      };
      this.emitSnapshot();
    } catch (error) {
      const detail = formatError(error);
      this.sessionAnalysisState = {
        isGenerating: false,
        activeChatId: activeChat.id,
        lastGeneratedAt: this.sessionAnalysisState.lastGeneratedAt,
        lastError: detail,
      };
      this.emitSnapshot();
      void vscode.window.showErrorMessage(`Failed to generate session analysis: ${detail}`);
    }
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
      case 'generateSessionAnalysis':
        void this.generateSessionAnalysisReport();
        return;
      case 'openApiKeySettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'aiAgentMonitor.geminiApiKey');
        return;
    }
  }

  dispose(): void {
    this.flushNetworkEmit();
    this.clearLiveTurnState();
    this.clearAntigravityBindingCleanups();
    if (this.cursorTabSelectionPollHandle) {
      clearInterval(this.cursorTabSelectionPollHandle);
      this.cursorTabSelectionPollHandle = undefined;
    }
    const finalSnapshot = this.lastSnapshot ?? this.buildSnapshot();
    this.persistCompletedSessionIfNeeded(
      this.lastSnapshot,
      {
        ...finalSnapshot,
        activeChat: undefined,
      }
    );

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this._onSnapshotChanged.dispose();
    this._onStatusChanged.dispose();
    this.output.dispose();
  }

  private getEnabledSourceIds(): Array<'cursor' | 'antigravity'> {
    switch (this.hostApp) {
      case 'cursor':
        return ['cursor'];
      case 'antigravity':
        return ['antigravity'];
      default:
        return ['cursor', 'antigravity'];
    }
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

  private startCursorTabSelectionPoll(): void {
    this.syncCursorSelectedChatFromTabs('startup');
    this.cursorTabSelectionPollHandle = setInterval(() => {
      this.syncCursorSelectedChatFromTabs('poll');
    }, CURSOR_TAB_SELECTION_POLL_MS);
  }

  private startCursorNetworkInterceptor(): void {
    this.resetCursorDiagnosticLog();
    if (this.cursorDiagnosticLogPath) {
      this.logCursorDiagnostic(
        `[cursor-network] Writing verbose request diagnostics to ${this.cursorDiagnosticLogPath}`
      );
    }

    const localInterceptor = new NetworkInterceptor({
      log: (message) => this.logCursorDiagnostic(message),
    });
    this.cursorInProcessInterceptor = localInterceptor;
    this.disposables.push(localInterceptor);

    localInterceptor.onTurnStart((turnStart) => {
      this.handleCursorTurnStart(turnStart, 'in-process');
    });
    localInterceptor.onTurnChunk((turnChunk) => {
      this.handleCursorTurnChunk(turnChunk);
    });
    localInterceptor.onTurnComplete((turnComplete) => {
      this.handleCursorTurnComplete(turnComplete);
    });
    localInterceptor.start();
    this.logCursorDiagnostic(
      '[cursor-network] Cursor in-process NetworkInterceptor activated for user-host live capture.'
    );

    const eventLogPath = path.join(os.tmpdir(), 'ai-token-analytics-cursor-live-events.jsonl');
    const interceptor = new CursorSiblingNetworkBridge({
      diagnosticLogPath: this.cursorDiagnosticLogPath,
      eventLogPath,
      probeModulePath: this.extensionContext.asAbsolutePath(path.join('dist', 'cursorRemoteProbe.js')),
      log: (message) => this.logCursorDiagnostic(message),
    });
    this.cursorInterceptor = interceptor;
    this.disposables.push(interceptor);

    interceptor.onTurnStart((turnStart) => {
      this.handleCursorTurnStart(turnStart, 'sibling-host');
    });

    interceptor.onTurnChunk((turnChunk) => {
      this.handleCursorTurnChunk(turnChunk);
    });

    interceptor.onTurnComplete((turnComplete) => {
      this.handleCursorTurnComplete(turnComplete);
    });

    void interceptor.start();
    this.logCursorDiagnostic(
      '[cursor-network] Cursor sibling-host bridge activated for live capture.'
    );
  }

  private handleCursorTurnStart(
    turnStart: CursorInterceptedTurnStart,
    captureSource: 'in-process' | 'sibling-host'
  ): void {
    if (turnStart.provider !== 'Cursor') {
      return;
    }

    const modelLabel = turnStart.model
      ? `, model ${turnStart.model}`
      : '';
    this.output.appendLine(
      `[cursor-network] Prompt captured via ${captureSource} (${turnStart.prompt.length} chars${modelLabel})`
    );

    const resolution = this.resolveCursorLiveChatTarget(turnStart.chatId);
    const chatId = resolution.chatId;
    const chatConfidence: CursorRequestBinding['chatConfidence'] = turnStart.chatId ? 'explicit' : 'selection';
    const chat = this.ensureCursorLiveChat(chatId, {
      provider: SOURCE_LABELS.cursor,
      model: turnStart.model,
      modelConfidence: turnStart.modelConfidence,
      startedAt: turnStart.startedAt,
      title: turnStart.prompt.trim()
        ? summarizeForTitle(turnStart.prompt)
        : undefined,
      subtitle: turnStart.prompt.trim()
        ? summarizeForSubtitle(turnStart.prompt)
        : undefined,
    });
    const { turn, state } = this.bindLiveRequest(
      'cursor',
      chat,
      turnStart.requestId,
      turnStart.requestType,
      turnStart.startedAt,
      turnStart.requestType === 'primary' && Boolean(turnStart.prompt.trim())
    );
    const childTurn = turnStart.requestType === 'primary'
      ? undefined
      : this.ensureChildTurn(chat, turn, {
        requestId: turnStart.requestId,
        requestType: turnStart.requestType,
        timestamp: turnStart.startedAt,
        model: turnStart.model,
        modelConfidence: turnStart.modelConfidence,
      });

    this.cursorRequestBindings.set(turnStart.requestId, {
      chatId,
      chatConfidence,
      selectionSource: turnStart.chatId ? 'explicit' : resolution.source,
      turnId: turn.id,
      requestType: turnStart.requestType,
      liveTurnKey: state.liveTurnKey,
      childTurnId: childTurn?.id,
    });
    this.pinCursorSelectedChat(chatId);

    if (childTurn) {
      this.output.appendLine(
        `[cursor-live] Child turn created type=${turnStart.requestType} parent=${turn.id} request=${turnStart.requestId}`
      );
    }

    if (turnStart.requestType === 'primary' && turnStart.prompt.trim()) {
      this.setBlockContent(
        chat,
        turn.id,
        'user-input',
        turnStart.prompt,
        false,
        turnStart.startedAt
      );
    } else if (childTurn && turnStart.prompt.trim()) {
      this.setTurnBlockContent(
        chat,
        childTurn,
        'user-input',
        turnStart.prompt,
        false,
        turnStart.startedAt,
        turn
      );
      if (turnStart.requestType === 'editor') {
        childTurn.capturedTokenUsage = {
          ...childTurn.capturedTokenUsage,
          editorInputTokens: estimateQuickTokens(turnStart.prompt),
        };
      }
    }

    if (turnStart.model) {
      chat.model = turnStart.model;
      chat.modelConfidence = turnStart.modelConfidence;
      turn.model = turnStart.model;
      turn.modelConfidence = turnStart.modelConfidence;
      if (childTurn) {
        childTurn.model = turnStart.model;
        childTurn.modelConfidence = turnStart.modelConfidence;
      }
    }

    this.activeChatKey = `cursor:${chat.id}`;
    this.activeChatEngagedAt = turnStart.startedAt;
    this.refreshCursorCollection();

    if (!turnStart.chatId && resolution.source !== 'tab') {
      void this.refreshCursorSelectionForRequest(turnStart.requestId);
    }
  }

  private handleCursorTurnChunk(turnChunk: CursorInterceptedTurnChunk): void {
    if (turnChunk.provider !== 'Cursor') {
      return;
    }

    const binding = this.cursorRequestBindings.get(turnChunk.requestId);
    if (!binding) {
      return;
    }

    const chat = this.cursorLiveChats.get(binding.chatId);
    if (!chat) {
      return;
    }

    const { parentTurn, targetTurn } = this.resolveBoundTurn(chat, binding);
    this.appendTurnBlockContent(
      chat,
      targetTurn,
      this.blockTypeForRequestType(binding.requestType, turnChunk.kind),
      turnChunk.content,
      Date.now(),
      parentTurn
    );
    if (binding.requestType === 'editor') {
      targetTurn.capturedTokenUsage = {
        ...targetTurn.capturedTokenUsage,
        editorOutputTokens: estimateQuickTokens(targetTurn.blocks['agent-editor'].content),
      };
    }

    this.scheduleNetworkEmit();
  }

  private handleCursorTurnComplete(turnComplete: CursorInterceptedTurnComplete): void {
    if (turnComplete.provider !== 'Cursor') {
      return;
    }

    const binding = this.cursorRequestBindings.get(turnComplete.requestId);
    if (!binding) {
      return;
    }

    if (turnComplete.chatId && turnComplete.chatId !== binding.chatId) {
      binding.chatConfidence = 'explicit';
      binding.selectionSource = 'explicit';
      this.rebindCursorLiveChat(binding.chatId, turnComplete.chatId, 'request-metadata');
    } else if (turnComplete.chatId) {
      binding.chatConfidence = 'explicit';
      binding.selectionSource = 'explicit';
    }

    const chat = this.cursorLiveChats.get(binding.chatId);
    if (!chat) {
      return;
    }

    const { parentTurn, targetTurn } = this.resolveBoundTurn(chat, binding);
    this.backfillCursorPrompt(chat, binding, parentTurn, targetTurn, turnComplete);
    if (turnComplete.model) {
      chat.model = turnComplete.model;
      chat.modelConfidence = turnComplete.modelConfidence;
      parentTurn.model = turnComplete.model;
      parentTurn.modelConfidence = turnComplete.modelConfidence;
      targetTurn.model = turnComplete.model;
      targetTurn.modelConfidence = turnComplete.modelConfidence;
    }

    if (binding.requestType === 'primary') {
      if (turnComplete.thinking || !targetTurn.blocks['agent-thinking'].content) {
        this.setBlockContent(
          chat,
          targetTurn.id,
          'agent-thinking',
          turnComplete.thinking,
          false,
          turnComplete.completedAt
        );
      }
      if (turnComplete.output || !targetTurn.blocks['agent-output'].content) {
        this.setBlockContent(
          chat,
          targetTurn.id,
          'agent-output',
          turnComplete.output,
          false,
          turnComplete.completedAt
        );
      }
    } else {
      const blockType = this.blockTypeForRequestType(binding.requestType, 'agent-output');
      if (turnComplete.output && !targetTurn.blocks[blockType].content) {
        this.setTurnBlockContent(
          chat,
          targetTurn,
          blockType,
          turnComplete.output,
          false,
          turnComplete.completedAt,
          parentTurn
        );
      }
      if (binding.requestType === 'editor') {
        targetTurn.capturedTokenUsage = {
          ...targetTurn.capturedTokenUsage,
          editorOutputTokens: estimateQuickTokens(targetTurn.blocks['agent-editor'].content),
        };
      }
      for (const blockType of BLOCK_TYPES) {
        targetTurn.blocks[blockType].isStreaming = false;
      }
      targetTurn.isComplete = BLOCK_TYPES
        .filter((blockType) => blockType !== 'user-input')
        .some((blockType) => Boolean(targetTurn.blocks[blockType].content.trim()));
      this.touchTurn(chat, parentTurn, turnComplete.completedAt);
    }

    const namedTitle = extractCursorNamedTitle(turnComplete.output);
    if (namedTitle) {
      this.applyCursorLiveChatMetadata(chat, {
        title: namedTitle,
        updatedAt: turnComplete.completedAt,
      });
    }

    this.settleLiveRequest('cursor', this.cursorLiveChats, turnComplete.requestId, binding, turnComplete.completedAt);
    this.syncCursorSelectedChatFromTabs('completion');
    this.cursorRequestBindings.delete(turnComplete.requestId);
    const selectedChatId = this.readCurrentCursorSelectedChatIdFromTabs() ?? binding.chatId;
    this.pinCursorSelectedChat(selectedChatId);
    this.activeChatKey = `cursor:${selectedChatId}`;
    this.activeChatEngagedAt = turnComplete.completedAt;
    this.refreshCursorCollection();
  }

  private resetCursorDiagnosticLog(): void {
    if (!this.cursorDiagnosticLogPath) {
      return;
    }

    const logPath = this.cursorDiagnosticLogPath;
    this.cursorDiagnosticWrite = fs.writeFile(logPath, '', 'utf8').catch((error) => {
      this.output.appendLine(
        `[cursor-network] Failed to reset diagnostic log ${logPath}: ${formatError(error)}`
      );
    });
  }

  private logCursorDiagnostic(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.output.appendLine(line);

    if (!this.cursorDiagnosticLogPath) {
      return;
    }

    const logPath = this.cursorDiagnosticLogPath;
    this.cursorDiagnosticWrite = this.cursorDiagnosticWrite
      .then(() => fs.appendFile(logPath, `${line}\n`, 'utf8'))
      .catch((error) => {
        this.output.appendLine(
          `[cursor-network] Failed to write diagnostic log ${logPath}: ${formatError(error)}`
        );
      });
  }

  private startAntigravityCollector(): void {
    const collector = new AntigravityLanguageServerCollector({
      output: this.output,
      getWorkspacePaths: () => this.getWorkspacePaths(),
      getPreferredConversationId: () =>
        this.antigravitySelectedChatId
        ?? this.sourceCollections.get('antigravity')?.selectedChatId,
    });
    this.antigravityCollector = collector;
    this.disposables.push(collector);

    collector.onConversationSummary((summary) => {
      const chat = this.antigravityLiveChats.get(summary.conversationId);
      if (!chat) {
        return;
      }

      this.applyAntigravityLiveChatMetadata(chat, {
        title: summary.title,
        subtitle: summary.snippet,
        updatedAt: summary.lastModifiedAt,
      });
      this.scheduleNetworkEmit();
    });

    collector.onTurnStart((turnStart) => {
      const modelLabel = turnStart.model
        ? `, model ${turnStart.model}`
        : '';
      this.output.appendLine(
        `[antigravity-ls] Prompt captured (${turnStart.prompt.length} chars${modelLabel})`
      );

      const chatId = this.resolveAntigravityLiveChatId(turnStart.conversationId);
      const chat = this.ensureAntigravityLiveChat(chatId, {
        provider: SOURCE_LABELS.antigravity,
        model: turnStart.model,
        modelConfidence: turnStart.modelConfidence,
        startedAt: turnStart.startedAt,
        title: turnStart.title,
        subtitle: turnStart.subtitle,
        contextUsagePercent: turnStart.contextUsagePercent,
        contextWindowTokens: turnStart.contextWindowTokens,
      });
      const { turn, state } = this.bindLiveRequest(
        'antigravity',
        chat,
        turnStart.executionId,
        'primary',
        turnStart.startedAt,
        Boolean(turnStart.prompt.trim())
      );

      this.antigravityRequestBindings.set(turnStart.executionId, {
        chatId,
        turnId: turn.id,
        requestType: 'primary',
        liveTurnKey: state.liveTurnKey,
      });
      this.clearAntigravityBindingCleanup(turnStart.executionId);
      this.pinAntigravitySelectedChat(chatId, turnStart.startedAt);

      this.setBlockContent(
        chat,
        turn.id,
        'user-input',
        turnStart.prompt,
        false,
        turnStart.startedAt
      );

      if (turnStart.model) {
        chat.model = turnStart.model;
        chat.modelConfidence = turnStart.modelConfidence;
        turn.model = turnStart.model;
        turn.modelConfidence = turnStart.modelConfidence;
      }

      this.activeChatKey = `antigravity:${chat.id}`;
      this.activeChatEngagedAt = turnStart.startedAt;
      this.refreshAntigravityCollection();
    });

    collector.onTurnUpdate((turnUpdate) => {
      const binding = this.antigravityRequestBindings.get(turnUpdate.executionId)
        ?? this.recoverAntigravityBindingForLateUpdate(turnUpdate);
      if (!binding) {
        return;
      }

      const chat = this.antigravityLiveChats.get(binding.chatId);
      if (!chat) {
        return;
      }

      this.applyAntigravityLiveChatMetadata(chat, {
        model: turnUpdate.model,
        modelConfidence: turnUpdate.modelConfidence,
        title: turnUpdate.title,
        subtitle: turnUpdate.subtitle,
        contextUsagePercent: turnUpdate.contextUsagePercent,
        contextWindowTokens: turnUpdate.contextWindowTokens,
        updatedAt: turnUpdate.updatedAt,
      });

      const turn = this.mustGetTurn(chat, binding.turnId);
      if (turnUpdate.model) {
        turn.model = turnUpdate.model;
        turn.modelConfidence = turnUpdate.modelConfidence ?? chat.modelConfidence;
      }

      if (turnUpdate.output !== undefined) {
        this.setBlockContent(
          chat,
          turn.id,
          'agent-output',
          turnUpdate.output,
          !turnUpdate.isComplete,
          turnUpdate.updatedAt
        );
      }

      if (turnUpdate.thinking !== undefined) {
        this.setBlockContent(
          chat,
          turn.id,
          'agent-thinking',
          turnUpdate.thinking,
          !turnUpdate.isComplete,
          turnUpdate.updatedAt
        );
      }

      if (turnUpdate.subagent !== undefined) {
        this.setBlockContent(
          chat,
          turn.id,
          'agent-subagent',
          turnUpdate.subagent,
          !turnUpdate.isComplete,
          turnUpdate.updatedAt
        );
      }

      if (turnUpdate.editor !== undefined) {
        this.setBlockContent(
          chat,
          turn.id,
          'agent-editor',
          turnUpdate.editor,
          !turnUpdate.isComplete,
          turnUpdate.updatedAt
        );
      }

      if (turnUpdate.capturedTokenUsage) {
        this.mergeCapturedTokenUsage(turn, turnUpdate.capturedTokenUsage);
      }

      if (turnUpdate.isComplete) {
        this.flushNetworkEmit();
        this.settleLiveRequest('antigravity', this.antigravityLiveChats, turnUpdate.executionId, binding, turnUpdate.updatedAt);
        this.scheduleAntigravityBindingCleanup(turnUpdate.executionId);
        this.pinAntigravitySelectedChat(binding.chatId, turnUpdate.updatedAt);
        this.activeChatKey = `antigravity:${binding.chatId}`;
        this.activeChatEngagedAt = turnUpdate.updatedAt;
        this.refreshAntigravityCollection();
        return;
      }

      this.scheduleNetworkEmit();
    });

    collector.start();
    this.output.appendLine('[antigravity-ls] Local language-server collector activated for live capture.');
  }

  private scheduleNetworkEmit(): void {
    if (this.networkEmitHandle) {
      return;
    }

    this.networkEmitHandle = setTimeout(() => {
      this.networkEmitHandle = undefined;
      this.emitSnapshot();
    }, 250);
  }

  private flushNetworkEmit(): void {
    if (this.networkEmitHandle) {
      clearTimeout(this.networkEmitHandle);
      this.networkEmitHandle = undefined;
    }
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

    if (sourceId === 'antigravity') {
      if (
        decorated.selectedChatId
        && (
          !this.antigravitySelectedChatId
          || decorated.selectedChatId === this.antigravitySelectedChatId
          || Date.now() >= this.antigravitySelectedChatLockedUntil
        )
      ) {
        this.antigravitySelectedChatId = decorated.selectedChatId;
      }
    }
    if (sourceId === 'cursor') {
      const tabSelection = this.readCurrentCursorTabSelectionFromTabs();
      const preserveProvisionalSelection = tabSelection.isNewChat
        && Boolean(this.cursorActiveNewChatChatId);
      if (tabSelection.chatId) {
        this.cursorSelectedChatId = tabSelection.chatId;
      } else if (decorated.selectedChatId && !preserveProvisionalSelection) {
        this.cursorSelectedChatId = decorated.selectedChatId;
      }
      this.reconcileCursorLiveChats(decorated);
    }

    const resolvedCollection = sourceId === 'antigravity'
      ? this.mergeAntigravityCollection(decorated)
      : sourceId === 'cursor'
        ? this.mergeCursorCollection(decorated)
        : decorated;

    this.sourceCollections.set(sourceId, cloneCollection(resolvedCollection));
    this.updateActiveChatLock(sourceId, resolvedCollection);

    const activeChat = resolvedCollection.chats.find((chat) => chat.id === resolvedCollection.selectedChatId);
    if (activeChat) {
      this.triggerGroqAnalysis(activeChat);
    }

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

  private refreshAntigravityCollection(): void {
    const merged = this.mergeAntigravityCollection(this.sourceCollections.get('antigravity'));
    this.sourceCollections.set('antigravity', cloneCollection(merged));
    this.updateActiveChatLock('antigravity', merged);

    const activeChat = merged.chats.find((chat) => chat.id === merged.selectedChatId);
    if (activeChat) {
      this.triggerGroqAnalysis(activeChat);
    }

    this.emitSnapshot();
  }

  private refreshCursorCollection(): void {
    const merged = this.mergeCursorCollection(this.sourceCollections.get('cursor'));
    this.sourceCollections.set('cursor', cloneCollection(merged));
    this.updateActiveChatLock('cursor', merged);

    const activeChat = merged.chats.find((chat) => chat.id === merged.selectedChatId);
    if (activeChat) {
      this.triggerGroqAnalysis(activeChat);
    }

    this.emitSnapshot();
  }

  private mergeCursorCollection(
    baseCollection: ConversationCollection | undefined
  ): ConversationCollection {
    const base = baseCollection
      ? cloneCollection(baseCollection)
      : { chats: [], selectedChatId: undefined };
    const chatsById = new Map(base.chats.map((chat) => [chat.id, chat]));

    for (const liveChat of this.cursorLiveChats.values()) {
      const existing = chatsById.get(liveChat.id);
      chatsById.set(
        liveChat.id,
        existing
          ? this.mergeCursorChat(existing, liveChat)
          : cloneChat(liveChat)
      );
    }

    const chats = [...chatsById.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const selectedChatId = this.cursorSelectedChatId
      ?? base.selectedChatId
      ?? chats[0]?.id;

    return {
      chats,
      selectedChatId,
    };
  }

  private mergeCursorChat(
    persistedChat: ConversationChat,
    liveChat: ConversationChat
  ): ConversationChat {
    const preferredTitle = isGenericLiveTitle(persistedChat.title) && liveChat.title
      ? liveChat.title
      : persistedChat.title || liveChat.title;
    const preferredSubtitle = liveChat.subtitle || persistedChat.subtitle;
    const preferredModel = liveChat.model ?? persistedChat.model;
    const preferredConfidence = liveChat.modelConfidence
      ?? persistedChat.modelConfidence
      ?? (preferredModel ? 'inferred' : 'unknown');

    return {
      ...persistedChat,
      title: preferredTitle || 'Untitled chat',
      subtitle: preferredSubtitle,
      createdAt: Math.min(persistedChat.createdAt, liveChat.createdAt),
      updatedAt: Math.max(persistedChat.updatedAt, liveChat.updatedAt),
      turns: mergeCursorTurns(persistedChat.turns, liveChat.turns),
      model: preferredModel,
      modelConfidence: preferredConfidence,
    };
  }

  private mergeAntigravityCollection(
    baseCollection: ConversationCollection | undefined
  ): ConversationCollection {
    const base = baseCollection
      ? cloneCollection(baseCollection)
      : { chats: [], selectedChatId: undefined };
    const chatsById = new Map(base.chats.map((chat) => [chat.id, chat]));

    for (const liveChat of this.antigravityLiveChats.values()) {
      const existing = chatsById.get(liveChat.id);
      chatsById.set(
        liveChat.id,
        existing
          ? this.mergeAntigravityChat(existing, liveChat)
          : cloneChat(liveChat)
      );
    }

    const chats = [...chatsById.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const selectedChatId = this.antigravitySelectedChatId
      ?? base.selectedChatId
      ?? chats[0]?.id;

    return {
      chats,
      selectedChatId,
    };
  }

  private mergeAntigravityChat(
    persistedChat: ConversationChat,
    liveChat: ConversationChat
  ): ConversationChat {
    const preferredTitle = isGenericLiveTitle(persistedChat.title) && liveChat.title
      ? liveChat.title
      : persistedChat.title || liveChat.title;
    const preferredSubtitle = persistedChat.subtitle || liveChat.subtitle;
    const preferredModel = liveChat.model ?? persistedChat.model;
    const preferredConfidence = liveChat.modelConfidence
      ?? persistedChat.modelConfidence
      ?? (preferredModel ? 'inferred' : 'unknown');

    return {
      ...persistedChat,
      title: preferredTitle || 'Untitled chat',
      subtitle: preferredSubtitle,
      createdAt: Math.min(persistedChat.createdAt, liveChat.createdAt),
      updatedAt: Math.max(persistedChat.updatedAt, liveChat.updatedAt),
      turns: mergeCursorTurns(persistedChat.turns, liveChat.turns),
      model: preferredModel,
      modelConfidence: preferredConfidence,
    };
  }

  private buildSnapshot(): MonitorSnapshot {
    const analysisProvider = getAnalysisProviderState();

    return buildDashboardSnapshot({
      app: this.hostApp,
      appLabel: this.appLabel,
      sources: this.buildSourceSnapshots(),
      activeChatKey: this.activeChatKey,
      promptLibrary: this.promptLibrary,
      persistedSessions: this.sessionSummaries,
      budgets: this.budgets,
      analysisProvider,
      coachInsights: this.groqInsightChatKey === this.activeChatKey ? this.currentGroqInsights : [],
      sessionAnalysis: this.sessionAnalysisState,
      workspacePaths: this.getWorkspacePaths(),
    });
  }

  private triggerGroqAnalysis(chat: ConversationChat): void {
    if (this.groqDebounceHandle) {
      clearTimeout(this.groqDebounceHandle);
    }

    const chatKey = `${chat.sourceId}:${chat.id}`;
    this.groqDebounceHandle = setTimeout(async () => {
      try {
        const insights = await analyzeChatWithGroq(chat);
        if (this.activeChatKey !== chatKey) {
          return;
        }

        if (insights.length > 0 || this.currentGroqInsights.length > 0) {
          this.currentGroqInsights = insights;
          this.groqInsightChatKey = chatKey;
          this.emitSnapshot();
        }
      } catch (err) {
        console.error('[Groq] Analysis error:', err);
      }
    }, 1500);
  }

  private buildSourceSnapshots(): SourceSnapshot[] {
    const sources: SourceSnapshot[] = [];

    for (const sourceId of ['cursor', 'antigravity'] as const) {
      const collection = this.sourceCollections.get(sourceId);
      if (
        !collection
        && !(sourceId === 'cursor' && this.cursorLiveChats.size > 0)
        && !(sourceId === 'antigravity' && this.antigravityLiveChats.size > 0)
      ) {
        continue;
      }

      const resolvedCollection = sourceId === 'antigravity'
        ? this.mergeAntigravityCollection(collection)
        : sourceId === 'cursor'
          ? this.mergeCursorCollection(collection)
          : collection!;

      sources.push({
        id: sourceId,
        label: SOURCE_LABELS[sourceId],
        chats: resolvedCollection.chats.map((chat) => ({ ...chat })),
        selectedChatId: resolvedCollection.selectedChatId,
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

  private createCursorLiveChatId(): string {
    return `cursor-live:${++this.chatCounter}`;
  }

  private createAntigravityLiveChatId(): string {
    return `antigravity-live:${++this.chatCounter}`;
  }

  private resolveCursorLiveChatTarget(preferredChatId?: string): { chatId: string; source: CursorSelectionSource } {
    if (preferredChatId) {
      return {
        chatId: preferredChatId,
        source: 'explicit',
      };
    }

    const tabSelection = this.readCurrentCursorTabSelectionFromTabs();
    if (tabSelection.chatId) {
      return {
        chatId: tabSelection.chatId,
        source: 'tab',
      };
    }

    if (tabSelection.isNewChat) {
      return {
        chatId: this.ensureCursorProvisionalSelectedChat(
          tabSelection.label ?? 'New Agent',
          !this.cursorTabIsNewChat
        ),
        source: 'provisional-tab',
      };
    }

    if (this.cursorSelectedChatId) {
      return {
        chatId: this.cursorSelectedChatId,
        source: 'pinned',
      };
    }

    const storeSelectedChatId = this.sourceCollections.get('cursor')?.selectedChatId;
    if (storeSelectedChatId) {
      return {
        chatId: storeSelectedChatId,
        source: 'store',
      };
    }

    const openChatId = this.findOpenCursorLiveChatId();
    if (openChatId) {
      return {
        chatId: openChatId,
        source: 'open-turn',
      };
    }

    return {
      chatId: this.createCursorLiveChatId(),
      source: 'ephemeral',
    };
  }

  private resolveCursorLiveChatId(preferredChatId?: string): string {
    return this.resolveCursorLiveChatTarget(preferredChatId).chatId;
  }

  private resolveAntigravityLiveChatId(preferredChatId?: string): string {
    const selectedFromActiveChat = this.activeChatKey?.startsWith('antigravity:')
      ? extractChatId(this.activeChatKey)
      : undefined;

    return preferredChatId
      ?? this.antigravitySelectedChatId
      ?? this.sourceCollections.get('antigravity')?.selectedChatId
      ?? selectedFromActiveChat
      ?? this.createAntigravityLiveChatId();
  }

  private pinAntigravitySelectedChat(chatId: string, engagedAt = Date.now()): void {
    this.antigravitySelectedChatId = chatId;
    this.antigravitySelectedChatLockedUntil = engagedAt + ANTIGRAVITY_SELECTION_LOCK_MS;
  }

  private pinCursorSelectedChat(chatId: string): void {
    this.cursorSelectedChatId = chatId;
  }

  private ensureCursorProvisionalSelectedChat(label: string, forceFresh = false): string {
    const now = Date.now();
    if (!forceFresh && this.cursorActiveNewChatChatId) {
      const activeChat = this.cursorLiveChats.get(this.cursorActiveNewChatChatId);
      if (activeChat) {
        this.applyCursorLiveChatMetadata(activeChat, {
          title: label,
          updatedAt: now,
        });
      }
      this.cursorSelectedChatId = this.cursorActiveNewChatChatId;
      return this.cursorActiveNewChatChatId;
    }

    const selectedProvisional = this.cursorSelectedChatId?.startsWith('cursor-live:')
      ? this.cursorLiveChats.get(this.cursorSelectedChatId)
      : undefined;
    if (!forceFresh && selectedProvisional?.isEphemeral && selectedProvisional.turns.length === 0) {
      this.applyCursorLiveChatMetadata(selectedProvisional, {
        title: label,
        updatedAt: now,
      });
      this.cursorSelectedChatId = selectedProvisional.id;
      this.cursorActiveNewChatChatId = selectedProvisional.id;
      return selectedProvisional.id;
    }

    const chatId = this.createCursorLiveChatId();
    this.ensureCursorLiveChat(chatId, {
      provider: SOURCE_LABELS.cursor,
      startedAt: now,
      title: label,
    });
    this.cursorSelectedChatId = chatId;
    this.cursorActiveNewChatChatId = chatId;
    return chatId;
  }

  private syncCursorSelectedChatFromTabs(reason: string): void {
    const tabSelection = this.readCurrentCursorTabSelectionFromTabs();
    if (tabSelection.isNewChat) {
      const previousSelectedChatId = this.cursorSelectedChatId;
      const provisionalChatId = this.ensureCursorProvisionalSelectedChat(
        tabSelection.label ?? 'New Agent',
        !this.cursorTabIsNewChat
      );
      this.cursorTabIsNewChat = true;
      if (provisionalChatId !== previousSelectedChatId) {
        this.output.appendLine(
          `[cursor-live] Active tab entered provisional chat ${provisionalChatId} (${reason}).`
        );
      }
      this.refreshCursorCollection();
      return;
    }

    this.cursorTabIsNewChat = false;
    this.cursorActiveNewChatChatId = undefined;

    const selectedChatId = tabSelection.chatId;
    if (!selectedChatId) {
      return;
    }

    const previousSelectedChatId = this.cursorSelectedChatId;
    if (selectedChatId !== previousSelectedChatId) {
      this.cursorSelectedChatId = selectedChatId;
      this.output.appendLine(`[cursor-live] Active tab selected chat ${selectedChatId} (${reason}).`);
    }

    const liveTurn = this.findReassignableCursorLiveTurnState(selectedChatId);
    if (liveTurn) {
      this.reassignCursorLiveTurnToChat(
        liveTurn.chatId,
        selectedChatId,
        liveTurn.turnId,
        `tab-${reason}`
      );
      this.refreshCursorCollection();
      return;
    }

    if (selectedChatId !== previousSelectedChatId) {
      this.refreshCursorCollection();
    }
  }

  private findReassignableCursorLiveTurnState(selectedChatId: string): LiveTurnState | undefined {
    let bestState: LiveTurnState | undefined;
    let bestUpdatedAt = 0;

    for (const state of this.liveTurns.values()) {
      if (state.sourceId !== 'cursor' || state.chatId === selectedChatId) {
        continue;
      }

      if (!this.canCursorTurnFollowSelectedChat(state.turnId, state.chatId)) {
        continue;
      }

      const chat = this.cursorLiveChats.get(state.chatId);
      const turn = chat?.turns.find((candidate) => candidate.id === state.turnId);
      if (!chat || !turn) {
        continue;
      }

      if (state.pendingRequestIds.size === 0 && !state.settleHandle) {
        continue;
      }

      if (turn.updatedAt < bestUpdatedAt) {
        continue;
      }

      bestState = state;
      bestUpdatedAt = turn.updatedAt;
    }

    return bestState;
  }

  private canCursorTurnFollowSelectedChat(turnId: string, chatId: string): boolean {
    let sawBinding = false;

    for (const binding of this.cursorRequestBindings.values()) {
      if (binding.turnId !== turnId || binding.chatId !== chatId) {
        continue;
      }

      sawBinding = true;
      if (binding.chatConfidence === 'explicit') {
        return false;
      }
    }

    return sawBinding;
  }

  private readCurrentCursorTabSelectionFromTabs(): CursorTabSelection {
    if (this.hostApp !== 'cursor') {
      return {
        isNewChat: false,
      };
    }

    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
      return {
        isNewChat: false,
      };
    }

    const candidateIds = new Set<string>();
    for (const chat of this.sourceCollections.get('cursor')?.chats ?? []) {
      candidateIds.add(chat.id);
    }
    for (const chatId of this.cursorLiveChats.keys()) {
      candidateIds.add(chatId);
    }

    const serializedTabStrings = collectCursorTabStrings(activeTab);
    for (const candidateId of candidateIds) {
      if (serializedTabStrings.some((value) => value.includes(candidateId))) {
        return {
          chatId: candidateId,
          isNewChat: false,
          label: activeTab.label,
        };
      }
    }

    const normalizedLabel = normalizeComparableText(activeTab.label);
    if (normalizedLabel) {
      const titleMatches = [
        ...(this.sourceCollections.get('cursor')?.chats ?? []),
        ...this.cursorLiveChats.values(),
      ]
        .filter((chat) => normalizeComparableText(chat.title) === normalizedLabel)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      if (titleMatches[0]?.id) {
        return {
          chatId: titleMatches[0].id,
          isNewChat: false,
          label: activeTab.label,
        };
      }
    }

    const looksLikeNewChat = isCursorGenericNewChatLabel(activeTab.label)
      || serializedTabStrings.some((value) => isCursorGenericNewChatLabel(value));
    return {
      isNewChat: looksLikeNewChat,
      label: activeTab.label,
    };
  }

  private readCurrentCursorSelectedChatIdFromTabs(): string | undefined {
    return this.readCurrentCursorTabSelectionFromTabs().chatId;
  }

  private async readCurrentCursorSelectedChatId(): Promise<string | undefined> {
    const workspaceStorageDir = await this.findCursorWorkspaceStorageDir();
    if (!workspaceStorageDir) {
      return undefined;
    }

    const dbPath = path.join(workspaceStorageDir, 'state.vscdb');
    const values = await readMergedSqliteKeyMap(dbPath, [
      'composer.composerData',
      'memento/workbench.parts.embeddedAuxBarEditor.state',
    ]);
    const selectedCandidates = extractCursorActiveComposerIds(
      values['composer.composerData'],
      values['memento/workbench.parts.embeddedAuxBarEditor.state']
    );

    return selectedCandidates[0];
  }

  private async findCursorWorkspaceStorageDir(): Promise<string | undefined> {
    const workspacePaths = this.getWorkspacePaths()
      .map((workspacePath) => normalizeFsPath(workspacePath))
      .filter((workspacePath): workspacePath is string => Boolean(workspacePath));
    if (workspacePaths.length === 0) {
      return undefined;
    }

    const roots = buildAppStoragePathCandidates('Cursor', 'User', 'workspaceStorage');
    for (const root of roots) {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const workspaceJsonPath = path.join(root, entry.name, 'workspace.json');
        const raw = await fs.readFile(workspaceJsonPath, 'utf8').catch(() => undefined);
        if (!raw) {
          continue;
        }

        try {
          const parsed = JSON.parse(raw) as { folder?: string };
          const workspacePath = normalizeFsPath(fileUriToFsPath(parsed.folder ?? ''));
          if (!workspacePath) {
            continue;
          }

          if (workspacePaths.some((candidate) => pathsEqual(candidate, workspacePath))) {
            return path.join(root, entry.name);
          }
        } catch {
          // Ignore malformed workspace descriptors.
        }
      }
    }

    return undefined;
  }

  private scheduleAntigravityBindingCleanup(executionId: string): void {
    this.clearAntigravityBindingCleanup(executionId);

    const handle = setTimeout(() => {
      const activeHandle = this.antigravityBindingCleanupHandles.get(executionId);
      if (activeHandle !== handle) {
        return;
      }

      this.antigravityBindingCleanupHandles.delete(executionId);
      if (this.antigravityRequestBindings.delete(executionId)) {
        this.output.appendLine(
          `[antigravity-live] Released execution binding ${executionId} after waiting for late updates.`
        );
      }
    }, ANTIGRAVITY_LATE_UPDATE_GRACE_MS);

    this.antigravityBindingCleanupHandles.set(executionId, handle);
  }

  private clearAntigravityBindingCleanup(executionId: string): void {
    const handle = this.antigravityBindingCleanupHandles.get(executionId);
    if (!handle) {
      return;
    }

    clearTimeout(handle);
    this.antigravityBindingCleanupHandles.delete(executionId);
  }

  private clearAntigravityBindingCleanups(): void {
    for (const handle of this.antigravityBindingCleanupHandles.values()) {
      clearTimeout(handle);
    }
    this.antigravityBindingCleanupHandles.clear();
  }

  private recoverAntigravityBindingForLateUpdate(
    turnUpdate: AntigravityTurnUpdateEvent
  ): { chatId: string; turnId: string; requestType: InterceptedRequestType; liveTurnKey: string } | undefined {
    const directChat = this.antigravityLiveChats.get(turnUpdate.conversationId);
    const fallbackChat = directChat
      ?? [...this.antigravityLiveChats.values()]
        .filter((chat) => chat.turns.some((turn) => turn.blocks['user-input'].content.trim()))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!fallbackChat) {
      return undefined;
    }

    const candidateTurn = [...fallbackChat.turns]
      .filter((turn) => turn.blocks['user-input'].content.trim())
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!candidateTurn) {
      return undefined;
    }

    const recoveredBinding = {
      chatId: fallbackChat.id,
      turnId: candidateTurn.id,
      requestType: 'primary' as const,
      liveTurnKey: this.currentLiveTurnKeys.get(this.liveChatKey('antigravity', fallbackChat.id)) ?? '',
    };
    this.antigravityRequestBindings.set(turnUpdate.executionId, recoveredBinding);
    this.output.appendLine(
      `[antigravity-live] Reattached late execution ${turnUpdate.executionId} to ${fallbackChat.id}:${candidateTurn.id}.`
    );
    return recoveredBinding;
  }

  private ensureAntigravityLiveChat(
    chatId: string,
    options: {
      provider: string;
      model?: string;
      modelConfidence?: ModelConfidence;
      startedAt: number;
      title?: string;
      subtitle?: string;
      contextUsagePercent?: number;
      contextWindowTokens?: number;
    }
  ): ConversationChat {
    const existing = this.antigravityLiveChats.get(chatId);
    if (existing) {
      this.applyAntigravityLiveChatMetadata(existing, options);
      return existing;
    }

    const persisted = this.sourceCollections.get('antigravity')?.chats.find((chat) => chat.id === chatId);
    const timestamp = options.startedAt || Date.now();
    const next: ConversationChat = {
      id: chatId,
      title: persisted?.title ?? `${options.provider} live session`,
      subtitle: persisted?.subtitle,
      createdAt: persisted?.createdAt ?? timestamp,
      updatedAt: persisted?.updatedAt ?? timestamp,
      turns: persisted?.turns.map((turn) => cloneTurn(turn)) ?? [],
      sourceId: 'antigravity',
      sourceLabel: SOURCE_LABELS.antigravity,
      model: options.model ?? persisted?.model,
      modelConfidence: options.model
        ? options.modelConfidence ?? 'inferred'
        : persisted?.modelConfidence ?? 'unknown',
      contextUsagePercent: options.contextUsagePercent ?? persisted?.contextUsagePercent,
      contextWindowTokens: options.contextWindowTokens ?? persisted?.contextWindowTokens,
    };

    this.applyAntigravityLiveChatMetadata(next, options);
    this.antigravityLiveChats.set(chatId, next);
    return next;
  }

  private ensureCursorLiveChat(
    chatId: string,
    options: {
      provider: string;
      model?: string;
      modelConfidence?: ModelConfidence;
      startedAt: number;
      title?: string;
      subtitle?: string;
    }
  ): ConversationChat {
    const existing = this.cursorLiveChats.get(chatId);
    if (existing) {
      this.applyCursorLiveChatMetadata(existing, options);
      return existing;
    }

    const persisted = this.sourceCollections.get('cursor')?.chats.find((chat) => chat.id === chatId);
    const timestamp = options.startedAt || Date.now();
    const next: ConversationChat = {
      id: chatId,
      title: persisted?.title ?? options.title ?? `${options.provider} live session`,
      subtitle: persisted?.subtitle ?? options.subtitle,
      createdAt: persisted?.createdAt ?? timestamp,
      updatedAt: persisted?.updatedAt ?? timestamp,
      turns: persisted?.turns.map((turn) => cloneTurn(turn)) ?? [],
      isEphemeral: chatId.startsWith('cursor-live:'),
      sourceId: 'cursor',
      sourceLabel: SOURCE_LABELS.cursor,
      model: options.model ?? persisted?.model,
      modelConfidence: options.model
        ? options.modelConfidence ?? 'inferred'
        : persisted?.modelConfidence ?? 'unknown',
      contextUsagePercent: persisted?.contextUsagePercent,
      contextWindowTokens: persisted?.contextWindowTokens,
    };

    this.applyCursorLiveChatMetadata(next, options);
    this.cursorLiveChats.set(chatId, next);
    return next;
  }

  private clearLiveTurnState(): void {
    for (const state of this.liveTurns.values()) {
      if (state.settleHandle) {
        clearTimeout(state.settleHandle);
      }
    }
    this.liveTurns.clear();
    this.currentLiveTurnKeys.clear();
  }

  private liveChatKey(sourceId: 'cursor' | 'antigravity', chatId: string): string {
    return `${sourceId}:${chatId}`;
  }

  private buildLiveTurnKey(
    sourceId: 'cursor' | 'antigravity',
    chatId: string,
    turnId: string
  ): string {
    return `${sourceId}:${chatId}:${turnId}`;
  }

  private ensureLiveTurn(
    sourceId: 'cursor' | 'antigravity',
    chat: ConversationChat,
    startedAt: number,
    forceNew = false
  ): ConversationTurn {
    const chatKey = this.liveChatKey(sourceId, chat.id);
    const activeLiveTurnKey = this.currentLiveTurnKeys.get(chatKey);
    const existing = activeLiveTurnKey
      ? this.liveTurns.get(activeLiveTurnKey)
      : undefined;
    if (existing && !forceNew) {
      if (existing.settleHandle) {
        clearTimeout(existing.settleHandle);
        existing.settleHandle = undefined;
      }
      return this.mustGetTurn(chat, existing.turnId);
    }

    if (existing) {
      if (existing.settleHandle) {
        clearTimeout(existing.settleHandle);
        existing.settleHandle = undefined;
      }

      if (existing.pendingRequestIds.size === 0) {
        this.logTurnBreakdown(sourceId, chat, existing.turnId, 'superseded-by-new-prompt');
        this.finalizeTurn(chat, existing.turnId, startedAt);
        this.liveTurns.delete(activeLiveTurnKey!);
      } else {
        this.output.appendLine(
          `[${sourceId}-live] New prompt started while turn ${existing.turnId} still had ${existing.pendingRequestIds.size} pending request(s); isolating prior streams.`
        );
      }
    }

    const turn = this.createRuntimeTurn(chat, { timestamp: startedAt });
    const liveTurnKey = this.buildLiveTurnKey(sourceId, chat.id, turn.id);
    this.liveTurns.set(liveTurnKey, {
      sourceId,
      chatKey,
      chatId: chat.id,
      turnId: turn.id,
      pendingRequestIds: new Set(),
    });
    this.currentLiveTurnKeys.set(chatKey, liveTurnKey);
    return turn;
  }

  private bindLiveRequest(
    sourceId: 'cursor' | 'antigravity',
    chat: ConversationChat,
    requestId: string,
    requestType: InterceptedRequestType,
    startedAt: number,
    forceNewTurn = false
  ): { turn: ConversationTurn; state: LiveTurnState & { liveTurnKey: string } } {
    const turn = this.ensureLiveTurn(sourceId, chat, startedAt, forceNewTurn);
    const chatKey = this.liveChatKey(sourceId, chat.id);
    const liveTurnKey = this.currentLiveTurnKeys.get(chatKey);
    const baseState = liveTurnKey
      ? this.liveTurns.get(liveTurnKey)
      : undefined;
    if (!baseState || !liveTurnKey) {
      throw new Error(`Missing live turn state for ${chatKey}`);
    }

    const state: LiveTurnState & { liveTurnKey: string } = {
      ...baseState,
      liveTurnKey,
    };

    baseState!.pendingRequestIds.add(requestId);
    return { turn, state };
  }

  private settleLiveRequest(
    sourceId: 'cursor' | 'antigravity',
    chatMap: Map<string, ConversationChat>,
    requestId: string,
    binding: { chatId: string; turnId: string; liveTurnKey: string },
    completedAt: number
  ): void {
    const state = this.liveTurns.get(binding.liveTurnKey);
    if (!state || state.turnId !== binding.turnId) {
      return;
    }

    state.pendingRequestIds.delete(requestId);
    if (state.pendingRequestIds.size > 0) {
      return;
    }

    if (state.settleHandle) {
      clearTimeout(state.settleHandle);
    }

    state.settleHandle = setTimeout(() => {
      const latest = this.liveTurns.get(binding.liveTurnKey);
      if (!latest || latest.turnId !== binding.turnId || latest.pendingRequestIds.size > 0) {
        return;
      }

      const chat = chatMap.get(binding.chatId);
      if (chat) {
        this.logTurnBreakdown(sourceId, chat, binding.turnId, 'settled');
        this.finalizeTurn(chat, binding.turnId, completedAt);
      }
      this.liveTurns.delete(binding.liveTurnKey);
      if (this.currentLiveTurnKeys.get(state.chatKey) === binding.liveTurnKey) {
        this.currentLiveTurnKeys.delete(state.chatKey);
      }
      this.scheduleNetworkEmit();
    }, LIVE_TURN_SETTLE_MS);
  }

  private blockTypeForRequestType(
    requestType: InterceptedRequestType,
    chunkKind: 'agent-thinking' | 'agent-output'
  ): BlockType {
    if (requestType === 'subagent') {
      return 'agent-subagent';
    }
    if (requestType === 'editor') {
      return 'agent-editor';
    }
    return chunkKind;
  }

  private appendRequestTextToBlock(
    chat: ConversationChat,
    turnId: string,
    requestType: InterceptedRequestType,
    content: string,
    updatedAt: number
  ): void {
    if (!content || requestType === 'primary') {
      return;
    }

    const blockType = this.blockTypeForRequestType(requestType, 'agent-output');
    const turn = this.mustGetTurn(chat, turnId);
    const separator = turn.blocks[blockType].content ? '\n\n' : '';
    this.appendBlockContent(chat, turnId, blockType, `${separator}${content}`, updatedAt);
  }

  private logTurnBreakdown(
    sourceId: 'cursor' | 'antigravity',
    chat: ConversationChat,
    turnId: string,
    reason: string
  ): void {
    const turn = chat.turns.find((candidate) => candidate.id === turnId);
    if (!turn) {
      return;
    }

    const inputTokens = estimateQuickTokens(turn.blocks['user-input'].content);
    let thinkingTokens = this.resolveQuickTokenCount(turn, 'thinkingTokens', 'agent-thinking');
    let subagentTokens = this.resolveQuickTokenCount(turn, 'subagentTokens', 'agent-subagent');
    let editorTokens = this.resolveQuickTokenCount(turn, 'editorTokens', 'agent-editor');
    let outputTokens = this.resolveQuickTokenCount(turn, 'outputTokens', 'agent-output');

    for (const childTurn of turn.childTurns ?? []) {
      const childThinkingTokens = this.resolveQuickTokenCount(childTurn, 'thinkingTokens', 'agent-thinking');
      const childSubagentTokens = this.resolveQuickTokenCount(childTurn, 'subagentTokens', 'agent-subagent');
      const childEditorTokens = this.resolveQuickEditorOutputTokenCount(childTurn);
      const childOutputTokens = this.resolveQuickTokenCount(childTurn, 'outputTokens', 'agent-output');
      const childInputTokens = childTurn.capturedTokenUsage?.editorInputTokens
        ?? childTurn.capturedTokenUsage?.inputTokens
        ?? estimateQuickTokens(childTurn.blocks['user-input'].content);
      let childTotalTokens = childThinkingTokens + childSubagentTokens + childEditorTokens + childOutputTokens;
      thinkingTokens += childThinkingTokens;
      subagentTokens += childSubagentTokens;
      editorTokens += childEditorTokens;
      outputTokens += childOutputTokens;
      if (childTurn.requestType === 'editor') {
        editorTokens += childInputTokens;
        childTotalTokens += childInputTokens;
      } else if (childTurn.requestType === 'subagent') {
        subagentTokens += childInputTokens;
        childTotalTokens += childInputTokens;
      }

      if (childTotalTokens > 0) {
        this.output.appendLine(
          `[${sourceId}-live] Child finalized type=${childTurn.requestType ?? 'primary'} request=${childTurn.requestId ?? childTurn.id} input=${childInputTokens} thinking=${childThinkingTokens} subagent=${childSubagentTokens} editor=${childEditorTokens} output=${childOutputTokens} total=${childTotalTokens}`
        );
      }
    }
    const totalTokens = inputTokens + thinkingTokens + subagentTokens + editorTokens + outputTokens;

    this.output.appendLine(
      `[${sourceId}-live] Turn finalized (${reason}) input=${inputTokens} thinking=${thinkingTokens} subagent=${subagentTokens} editor=${editorTokens} output=${outputTokens} total=${totalTokens}`
    );
  }

  private resolveQuickTokenCount(
    turn: ConversationTurn,
    key: 'thinkingTokens' | 'subagentTokens' | 'editorTokens' | 'outputTokens',
    blockType: BlockType
  ): number {
    const capturedValue = turn.capturedTokenUsage?.[key];
    if (typeof capturedValue === 'number' && Number.isFinite(capturedValue) && capturedValue > 0) {
      return capturedValue;
    }

    return estimateQuickTokens(turn.blocks[blockType].content);
  }

  private resolveQuickEditorOutputTokenCount(turn: ConversationTurn): number {
    const capturedOutput = turn.capturedTokenUsage?.editorOutputTokens;
    if (typeof capturedOutput === 'number' && Number.isFinite(capturedOutput) && capturedOutput > 0) {
      return capturedOutput;
    }

    return this.resolveQuickTokenCount(turn, 'editorTokens', 'agent-editor');
  }

  private mergeCapturedTokenUsage(
    turn: ConversationTurn,
    captured: CapturedTokenUsage
  ): void {
    turn.capturedTokenUsage = {
      ...turn.capturedTokenUsage,
      ...captured,
    };
  }

  private ensureRuntimeTurn(
    chat: ConversationChat,
    options?: { turnId?: string; timestamp?: number }
  ): ConversationTurn {
    if (options?.turnId) {
      const existing = chat.turns.find((candidate) => candidate.id === options.turnId);
      if (existing) {
        return existing;
      }
    }

    return this.createRuntimeTurn(chat, options);
  }

  private createRuntimeTurn(
    chat: ConversationChat,
    options?: { turnId?: string; timestamp?: number }
  ): ConversationTurn {
    const now = options?.timestamp ?? Date.now();
    const turn: ConversationTurn = {
      id: options?.turnId ?? `runtime-turn:${++this.turnCounter}`,
      createdAt: now,
      updatedAt: now,
      isComplete: false,
      blocks: createEmptyBlocks(),
    };

    chat.turns.push(turn);
    chat.updatedAt = now;
    return turn;
  }

  private ensureChildTurn(
    chat: ConversationChat,
    parentTurn: ConversationTurn,
    options: {
      requestId: string;
      requestType: InterceptedRequestType;
      timestamp: number;
      model?: string;
      modelConfidence?: ModelConfidence;
    }
  ): ConversationTurn {
    parentTurn.childTurns ??= [];
    const existing = parentTurn.childTurns.find((candidate) => candidate.requestId === options.requestId);
    if (existing) {
      return existing;
    }

    const childTurn: ConversationTurn = {
      id: `${parentTurn.id}:child:${options.requestId}`,
      parentTurnId: parentTurn.id,
      requestId: options.requestId,
      requestType: options.requestType,
      createdAt: options.timestamp,
      updatedAt: options.timestamp,
      isComplete: false,
      blocks: createEmptyBlocks(),
      model: options.model,
      modelConfidence: options.modelConfidence,
    };

    parentTurn.childTurns.push(childTurn);
    this.touchTurn(chat, parentTurn, options.timestamp);
    return childTurn;
  }

  private applyAntigravityLiveChatMetadata(
    chat: ConversationChat,
    options: {
      model?: string;
      modelConfidence?: ModelConfidence;
      title?: string;
      subtitle?: string;
      contextUsagePercent?: number;
      contextWindowTokens?: number;
      updatedAt?: number;
    }
  ): void {
    if (options.model) {
      chat.model = options.model;
      chat.modelConfidence = options.modelConfidence ?? 'inferred';
    }

    if (options.title && (isGenericLiveTitle(chat.title) || !chat.title.trim())) {
      chat.title = options.title;
    }

    if (options.subtitle && (!chat.subtitle || isGenericLiveTitle(chat.subtitle))) {
      chat.subtitle = options.subtitle;
    }

    if (options.contextUsagePercent !== undefined) {
      chat.contextUsagePercent = options.contextUsagePercent;
    }

    if (options.contextWindowTokens !== undefined) {
      chat.contextWindowTokens = options.contextWindowTokens;
    }

    if (options.updatedAt !== undefined) {
      chat.updatedAt = Math.max(chat.updatedAt, options.updatedAt);
    }
  }

  private applyCursorLiveChatMetadata(
    chat: ConversationChat,
    options: {
      model?: string;
      modelConfidence?: ModelConfidence;
      title?: string;
      subtitle?: string;
      updatedAt?: number;
    }
  ): void {
    if (options.model) {
      chat.model = options.model;
      chat.modelConfidence = options.modelConfidence ?? 'inferred';
    }

    if (options.title && (isGenericLiveTitle(chat.title) || !chat.title.trim())) {
      chat.title = options.title;
    }

    if (options.subtitle && (!chat.subtitle || isGenericLiveTitle(chat.subtitle))) {
      chat.subtitle = options.subtitle;
    }

    if (options.updatedAt !== undefined) {
      chat.updatedAt = Math.max(chat.updatedAt, options.updatedAt);
    }
  }

  private findOpenCursorLiveChatId(): string | undefined {
    const activeCursorChatId = this.activeChatKey?.startsWith('cursor:')
      ? extractChatId(this.activeChatKey)
      : undefined;
    if (activeCursorChatId) {
      const activeChat = this.cursorLiveChats.get(activeCursorChatId);
      if (activeChat && hasOpenTurn(activeChat)) {
        return activeCursorChatId;
      }
    }

    return [...this.cursorLiveChats.values()]
      .filter((chat) => hasOpenTurn(chat))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      ?.id;
  }

  private backfillCursorPrompt(
    chat: ConversationChat,
    binding: CursorRequestBinding,
    parentTurn: ConversationTurn,
    targetTurn: ConversationTurn,
    turnComplete: CursorInterceptedTurnComplete
  ): void {
    const prompt = turnComplete.prompt.trim();
    if (!prompt) {
      return;
    }

    if (!parentTurn.blocks['user-input'].content.trim()) {
      this.setTurnBlockContent(
        chat,
        parentTurn,
        'user-input',
        prompt,
        false,
        turnComplete.completedAt
      );
    }

    if (!binding.childTurnId || targetTurn.blocks['user-input'].content.trim()) {
      return;
    }

    this.setTurnBlockContent(
      chat,
      targetTurn,
      'user-input',
      prompt,
      false,
      turnComplete.completedAt,
      parentTurn
    );

    const inputTokens = estimateQuickTokens(prompt);
    targetTurn.capturedTokenUsage = {
      ...targetTurn.capturedTokenUsage,
      ...(binding.requestType === 'editor'
        ? { editorInputTokens: inputTokens }
        : { inputTokens }),
    };
  }

  private async refreshCursorSelectionForRequest(requestId: string): Promise<void> {
    let lastObservedChatId: string | undefined;
    let stableObservations = 0;

    for (let attempt = 0; attempt < CURSOR_SELECTION_REFRESH_ATTEMPTS; attempt += 1) {
      const binding = this.cursorRequestBindings.get(requestId);
      if (!binding) {
        return;
      }

      if (binding.chatConfidence === 'explicit' || binding.selectionSource === 'tab') {
        return;
      }

      const tabSelection = this.readCurrentCursorTabSelectionFromTabs();
      if (tabSelection.chatId) {
        this.cursorTabIsNewChat = false;
        this.cursorActiveNewChatChatId = undefined;
        if (tabSelection.chatId === binding.chatId) {
          this.cursorSelectedChatId = tabSelection.chatId;
          binding.selectionSource = 'tab';
          return;
        }

        this.cursorSelectedChatId = tabSelection.chatId;
        this.reassignCursorLiveTurnToChat(
          binding.chatId,
          tabSelection.chatId,
          binding.turnId,
          'selection-refresh-tab'
        );
        binding.selectionSource = 'tab';
        this.refreshCursorCollection();
        return;
      }

      if (tabSelection.isNewChat) {
        this.cursorTabIsNewChat = true;
        const provisionalChatId = this.ensureCursorProvisionalSelectedChat(tabSelection.label ?? 'New Agent');
        if (binding.chatId !== provisionalChatId) {
          this.reassignCursorLiveTurnToChat(
            binding.chatId,
            provisionalChatId,
            binding.turnId,
            'selection-refresh-new-chat'
          );
          binding.selectionSource = 'provisional-tab';
          this.refreshCursorCollection();
        }
      }

      const selectedChatId = await this.readCurrentCursorSelectedChatId();
      if (selectedChatId) {
        if (selectedChatId === binding.chatId) {
          this.cursorSelectedChatId = selectedChatId;
          binding.selectionSource = 'store';
          return;
        }

        if (selectedChatId === lastObservedChatId) {
          stableObservations += 1;
        } else {
          lastObservedChatId = selectedChatId;
          stableObservations = 1;
        }

        if (stableObservations >= 2) {
          this.cursorSelectedChatId = selectedChatId;
          this.reassignCursorLiveTurnToChat(
            binding.chatId,
            selectedChatId,
            binding.turnId,
            'selection-refresh'
          );
          binding.selectionSource = 'store';
          this.refreshCursorCollection();
          return;
        }
      }

      if (attempt < CURSOR_SELECTION_REFRESH_ATTEMPTS - 1) {
        await wait(CURSOR_SELECTION_REFRESH_DELAY_MS);
      }
    }
  }

  private reconcileCursorLiveChats(collection: ConversationCollection): void {
    for (const liveChat of [...this.cursorLiveChats.values()]) {
      if (!liveChat.id.startsWith('cursor-live:')) {
        continue;
      }

      const matchId = this.findMatchingCursorChatId(liveChat, collection);
      if (!matchId || matchId === liveChat.id) {
        continue;
      }

      this.rebindCursorLiveChat(liveChat.id, matchId, 'store-reconciliation');
    }
  }

  private findMatchingCursorChatId(
    liveChat: ConversationChat,
    collection: ConversationCollection
  ): string | undefined {
    const candidates = collection.chats.filter((candidate) => candidate.id !== liveChat.id);
    if (candidates.length === 0) {
      return undefined;
    }

    const latestPrompt = normalizeComparableText(getLatestPromptTextForChat(liveChat));
    if (latestPrompt) {
      const promptMatch = candidates
        .filter((candidate) => normalizeComparableText(getLatestPromptTextForChat(candidate)) === latestPrompt)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (promptMatch) {
        return promptMatch.id;
      }
    }

    const normalizedTitle = normalizeComparableText(liveChat.title);
    if (normalizedTitle && !isGenericLiveTitle(liveChat.title)) {
      const titleMatch = candidates
        .filter((candidate) => normalizeComparableText(candidate.title) === normalizedTitle)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (titleMatch) {
        return titleMatch.id;
      }
    }

    if (!latestPrompt) {
      const selectedChat = collection.selectedChatId
        ? candidates.find((candidate) => candidate.id === collection.selectedChatId)
        : undefined;
      if (
        selectedChat
        && Date.now() - liveChat.updatedAt < CURSOR_PROVISIONAL_CHAT_GRACE_MS
        && selectedChat.updatedAt >= liveChat.createdAt - 5_000
      ) {
        return selectedChat.id;
      }
    }

    return undefined;
  }

  private reassignCursorLiveTurnToChat(
    fromChatId: string,
    toChatId: string,
    turnId: string,
    reason: string
  ): void {
    if (!fromChatId || !toChatId || fromChatId === toChatId) {
      return;
    }

    const sourceChat = this.cursorLiveChats.get(fromChatId);
    if (!sourceChat) {
      return;
    }

    const turnIndex = sourceChat.turns.findIndex((candidate) => candidate.id === turnId);
    if (turnIndex < 0) {
      return;
    }

    const [turn] = sourceChat.turns.splice(turnIndex, 1);
    const targetChat = this.ensureCursorLiveChat(toChatId, {
      provider: SOURCE_LABELS.cursor,
      model: turn.model ?? sourceChat.model,
      modelConfidence: turn.modelConfidence ?? sourceChat.modelConfidence,
      startedAt: turn.createdAt,
      title: sourceChat.title,
      subtitle: sourceChat.subtitle,
    });

    if (!targetChat.turns.some((candidate) => candidate.id === turn.id)) {
      targetChat.turns.push(turn);
    }
    targetChat.updatedAt = Math.max(targetChat.updatedAt, turn.updatedAt);

    const fromChatKey = this.liveChatKey('cursor', fromChatId);
    const toChatKey = this.liveChatKey('cursor', toChatId);
    const liveTurnKey = this.buildLiveTurnKey('cursor', fromChatId, turnId);
    const nextLiveTurnKey = this.buildLiveTurnKey('cursor', toChatId, turnId);
    const liveState = this.liveTurns.get(liveTurnKey);
    if (liveState) {
      this.liveTurns.delete(liveTurnKey);
      liveState.chatId = toChatId;
      liveState.chatKey = toChatKey;
      this.liveTurns.set(nextLiveTurnKey, liveState);
      if (this.currentLiveTurnKeys.get(fromChatKey) === liveTurnKey) {
        this.currentLiveTurnKeys.delete(fromChatKey);
        this.currentLiveTurnKeys.set(toChatKey, nextLiveTurnKey);
      }
    }

    for (const binding of this.cursorRequestBindings.values()) {
      if (binding.turnId !== turnId || binding.chatId !== fromChatId) {
        continue;
      }
      binding.chatId = toChatId;
      binding.liveTurnKey = nextLiveTurnKey;
    }

    if (sourceChat.turns.length === 0 && sourceChat.isEphemeral) {
      this.cursorLiveChats.delete(fromChatId);
    }

    if (this.cursorActiveNewChatChatId === fromChatId) {
      this.cursorActiveNewChatChatId = toChatId;
    }
    if (this.activeChatKey === `cursor:${fromChatId}`) {
      this.activeChatKey = `cursor:${toChatId}`;
    }

    this.output.appendLine(
      `[cursor-live] Reassigned live turn ${turnId} ${fromChatId} -> ${toChatId} (${reason}).`
    );
  }

  private rebindCursorLiveChat(
    fromChatId: string,
    toChatId: string,
    reason: string
  ): void {
    if (!fromChatId || !toChatId || fromChatId === toChatId) {
      return;
    }

    const liveChat = this.cursorLiveChats.get(fromChatId);
    if (!liveChat) {
      return;
    }

    const targetChat = this.cursorLiveChats.get(toChatId);
    const mergedChat = targetChat
      ? this.mergeCursorChat(targetChat, liveChat)
      : cloneChat(liveChat);
    mergedChat.id = toChatId;
    mergedChat.isEphemeral = false;

    this.cursorLiveChats.delete(fromChatId);
    this.cursorLiveChats.set(toChatId, mergedChat);

    const fromChatKey = this.liveChatKey('cursor', fromChatId);
    const toChatKey = this.liveChatKey('cursor', toChatId);

    for (const [liveTurnKey, state] of [...this.liveTurns.entries()]) {
      if (state.sourceId !== 'cursor' || state.chatId !== fromChatId) {
        continue;
      }

      const nextLiveTurnKey = this.buildLiveTurnKey('cursor', toChatId, state.turnId);
      this.liveTurns.delete(liveTurnKey);
      state.chatId = toChatId;
      state.chatKey = toChatKey;
      this.liveTurns.set(nextLiveTurnKey, state);

      if (this.currentLiveTurnKeys.get(fromChatKey) === liveTurnKey) {
        this.currentLiveTurnKeys.delete(fromChatKey);
        this.currentLiveTurnKeys.set(toChatKey, nextLiveTurnKey);
      }

      for (const binding of this.cursorRequestBindings.values()) {
        if (binding.liveTurnKey === liveTurnKey) {
          binding.liveTurnKey = nextLiveTurnKey;
        }
      }
    }

    for (const binding of this.cursorRequestBindings.values()) {
      if (binding.chatId === fromChatId) {
        binding.chatId = toChatId;
      }
    }

    if (this.cursorActiveNewChatChatId === fromChatId) {
      this.cursorActiveNewChatChatId = toChatId;
    }
    if (this.cursorSelectedChatId === fromChatId) {
      this.cursorSelectedChatId = toChatId;
    }
    if (this.activeChatKey === `cursor:${fromChatId}`) {
      this.activeChatKey = `cursor:${toChatId}`;
    }

    this.output.appendLine(
      `[cursor-live] Rebound provisional chat ${fromChatId} -> ${toChatId} (${reason}).`
    );
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

  private getChildTurn(parentTurn: ConversationTurn, childTurnId: string | undefined): ConversationTurn | undefined {
    if (!childTurnId) {
      return undefined;
    }

    return parentTurn.childTurns?.find((candidate) => candidate.id === childTurnId);
  }

  private resolveBoundTurn(
    chat: ConversationChat,
    binding: { turnId: string; childTurnId?: string }
  ): { parentTurn: ConversationTurn; targetTurn: ConversationTurn } {
    const parentTurn = this.mustGetTurn(chat, binding.turnId);
    const targetTurn = this.getChildTurn(parentTurn, binding.childTurnId) ?? parentTurn;
    return { parentTurn, targetTurn };
  }

  private setTurnBlockContent(
    chat: ConversationChat,
    turn: ConversationTurn,
    blockType: BlockType,
    content: string,
    isStreaming = false,
    updatedAt = Date.now(),
    presentationTurn = turn
  ): void {
    turn.blocks[blockType].content = content;
    turn.blocks[blockType].isStreaming = isStreaming;
    this.updateChatPresentationFromBlock(chat, blockType, content);
    this.touchTurn(chat, presentationTurn, updatedAt);
    if (presentationTurn !== turn) {
      turn.updatedAt = updatedAt;
    }
  }

  private appendTurnBlockContent(
    chat: ConversationChat,
    turn: ConversationTurn,
    blockType: BlockType,
    delta: string,
    updatedAt = Date.now(),
    presentationTurn = turn
  ): void {
    if (!delta) {
      return;
    }

    turn.blocks[blockType].content += delta;
    turn.blocks[blockType].isStreaming = true;
    this.updateChatPresentationFromBlock(chat, blockType, turn.blocks[blockType].content);
    this.touchTurn(chat, presentationTurn, updatedAt);
    if (presentationTurn !== turn) {
      turn.updatedAt = updatedAt;
    }
  }

  private setBlockContent(
    chat: ConversationChat,
    turnId: string,
    blockType: BlockType,
    content: string,
    isStreaming = false,
    updatedAt = Date.now()
  ): void {
    const turn = this.mustGetTurn(chat, turnId);
    this.setTurnBlockContent(chat, turn, blockType, content, isStreaming, updatedAt);
  }

  private appendBlockContent(
    chat: ConversationChat,
    turnId: string,
    blockType: BlockType,
    delta: string,
    updatedAt = Date.now()
  ): void {
    if (!delta) {
      return;
    }

    const turn = this.mustGetTurn(chat, turnId);
    this.appendTurnBlockContent(chat, turn, blockType, delta, updatedAt);
  }

  private finalizeTurn(chat: ConversationChat, turnId: string, completedAt = Date.now()): void {
    const turn = this.mustGetTurn(chat, turnId);
    for (const blockType of BLOCK_TYPES) {
      turn.blocks[blockType].isStreaming = false;
    }
    turn.isComplete = BLOCK_TYPES
      .filter((blockType) => blockType !== 'user-input')
      .some((blockType) => Boolean(turn.blocks[blockType].content.trim()));
    this.touchTurn(chat, turn, completedAt);
  }

  private updateChatPresentationFromBlock(
    chat: ConversationChat,
    blockType: BlockType,
    content: string
  ): void {
    if (blockType === 'agent-output') {
      chat.subtitle = summarizeForSubtitle(content) ?? chat.subtitle;
    } else if ((blockType === 'agent-subagent' || blockType === 'agent-editor') && !chat.subtitle) {
      chat.subtitle = summarizeForSubtitle(content) ?? chat.subtitle;
    } else if (blockType === 'user-input' && !chat.subtitle) {
      chat.subtitle = summarizeForSubtitle(content);
    }
  }

  private touchTurn(chat: ConversationChat, turn: ConversationTurn, updatedAt = Date.now()): void {
    turn.updatedAt = updatedAt;
    chat.updatedAt = Math.max(chat.updatedAt, turn.updatedAt);
  }

  private persistCompletedSessionIfNeeded(
    previousSnapshot: MonitorSnapshot | undefined,
    nextSnapshot: MonitorSnapshot
  ): void {
    const previousChat = previousSnapshot?.activeChat;
    if (!previousChat) {
      return;
    }

    const previousKey = `${previousChat.sourceId}:${previousChat.id}`;
    const nextKey = nextSnapshot.activeChat
      ? `${nextSnapshot.activeChat.sourceId}:${nextSnapshot.activeChat.id}`
      : undefined;

    if (previousKey === nextKey) {
      return;
    }

    const summary = createPersistedSessionSummary(previousChat);
    if (!summary) {
      return;
    }

    if (this.sessionSummaries.some((candidate) => candidate.id === summary.id)) {
      return;
    }

    this.sessionSummaries = [
      summary,
      ...this.sessionSummaries.filter((candidate) => candidate.id !== summary.id),
    ]
      .sort((left, right) => right.endedAt - left.endedAt)
      .slice(0, 10);

    void this.extensionContext.globalState.update(SESSION_SUMMARIES_KEY, this.sessionSummaries);
  }

  private getWorkspacePaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => folder.uri.fsPath)
      .filter((value): value is string => Boolean(value));
  }

  private emitSnapshot(): void {
    const snapshot = this.buildSnapshot();
    this.persistCompletedSessionIfNeeded(this.lastSnapshot, snapshot);
    this.lastSnapshot = cloneSnapshot(snapshot);
    this.notifyBudgetAlerts(snapshot);
    this._onSnapshotChanged.fire(cloneSnapshot(snapshot));
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

function describeTrackingStatus(hostApp: HostApp): string {
  switch (hostApp) {
    case 'cursor':
      return 'Tracking live AI usage in Cursor...';
    case 'antigravity':
      return 'Tracking live AI usage in Antigravity...';
    default:
      return 'Tracking live AI usage across Cursor and Antigravity...';
  }
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

function estimateQuickTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.round(normalized.length / 4));
}

function isGenericLiveTitle(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return !normalized
    || normalized === 'new chat'
    || normalized === 'untitled chat'
    || normalized.endsWith('live session');
}

function hasOpenTurn(chat: ConversationChat): boolean {
  return chat.turns.some((turn) => !turn.isComplete);
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

function loadSessionSummaries(rawValue: unknown): PersistedSessionSummary[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }

    const summary = candidate as Partial<PersistedSessionSummary>;
    if (
      typeof summary.id !== 'string'
      || typeof summary.chatId !== 'string'
      || typeof summary.title !== 'string'
      || typeof summary.sourceLabel !== 'string'
    ) {
      return [];
    }

    return [{
      id: summary.id,
      sourceId: summary.sourceId === 'cursor' || summary.sourceId === 'antigravity' || summary.sourceId === 'manual'
        ? summary.sourceId
        : 'manual',
      sourceLabel: summary.sourceLabel,
      chatId: summary.chatId,
      title: summary.title,
      model: typeof summary.model === 'string' ? summary.model : 'Unknown model',
      startedAt: toFiniteNumber(summary.startedAt) ?? Date.now(),
      endedAt: toFiniteNumber(summary.endedAt) ?? Date.now(),
      healthScore: toFiniteNumber(summary.healthScore) ?? 0,
      efficiencyScore: toFiniteNumber(summary.efficiencyScore) ?? 0,
      averagePromptScore: toFiniteNumber(summary.averagePromptScore) ?? 0,
      costUsd: toFiniteNumber(summary.costUsd) ?? 0,
      totalTokens: toFiniteNumber(summary.totalTokens) ?? 0,
      promptCount: toFiniteNumber(summary.promptCount) ?? 0,
      historyBloatRatio: toFiniteNumber(summary.historyBloatRatio) ?? 0,
      prompts: Array.isArray(summary.prompts)
        ? summary.prompts.flatMap((promptCandidate) => {
            if (!promptCandidate || typeof promptCandidate !== 'object') {
              return [];
            }

            const prompt = promptCandidate as PersistedSessionSummary['prompts'][number];
            if (typeof prompt.promptText !== 'string' || typeof prompt.promptPreview !== 'string') {
              return [];
            }

            return [{
              promptText: prompt.promptText,
              promptPreview: prompt.promptPreview,
              promptSignature: typeof prompt.promptSignature === 'string'
                ? prompt.promptSignature
                : prompt.promptPreview.toLowerCase(),
              inputTokens: toFiniteNumber(prompt.inputTokens) ?? 0,
              totalTokens: toFiniteNumber(prompt.totalTokens) ?? 0,
              costUsd: toFiniteNumber(prompt.costUsd) ?? 0,
              promptScore: toFiniteNumber(prompt.promptScore) ?? 0,
              complexity: prompt.complexity === 'trivial'
                || prompt.complexity === 'moderate'
                || prompt.complexity === 'complex'
                || prompt.complexity === 'reasoning-heavy'
                ? prompt.complexity
                : 'moderate',
            }];
          })
        : [],
    }];
  })
    .sort((left, right) => right.endedAt - left.endedAt)
    .slice(0, 10);
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
  const selectedChat = collection.chats.find((candidate) => candidate.id === collection.selectedChatId);
  const freshestPromptChat = selectFreshPromptChat(collection.chats);
  const freshestUpdatedChat = selectFreshUpdatedChat(collection.chats);
  const selectedChatPromptUpdatedAt = selectedChat
    ? latestPromptUpdatedAt(selectedChat)
    : 0;
  const freshPromptOverride = freshestPromptChat
    && (
      !selectedChat
      || (
        freshestPromptChat.id !== selectedChat.id
        && freshestPromptChat.updatedAt > selectedChat.updatedAt
        && freshestPromptChat.updatedAt > selectedChatPromptUpdatedAt
        && Date.now() - freshestPromptChat.updatedAt < 15_000
      )
    )
    ? freshestPromptChat
    : undefined;
  const freshRealtimeOverride = sourceId === 'antigravity'
    && freshestUpdatedChat
    && (
      !selectedChat
      || (
        freshestUpdatedChat.id !== selectedChat.id
        && freshestUpdatedChat.updatedAt > selectedChat.updatedAt + 1_000
        && Date.now() - freshestUpdatedChat.updatedAt < 10 * 60 * 1000
      )
    )
    ? freshestUpdatedChat
    : undefined;
  const chat = freshPromptOverride
    ?? freshRealtimeOverride
    ?? selectedChat
    ?? freshestUpdatedChat
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

function selectFreshPromptChat(chats: ConversationChat[]): ConversationChat | undefined {
  let bestChat: ConversationChat | undefined;
  let bestUpdatedAt = 0;

  for (const chat of chats) {
    const promptUpdatedAt = latestPromptUpdatedAt(chat);
    if (promptUpdatedAt <= 0) {
      continue;
    }

    if (!bestChat || promptUpdatedAt > bestUpdatedAt) {
      bestChat = chat;
      bestUpdatedAt = promptUpdatedAt;
    }
  }

  return bestChat;
}

function selectFreshUpdatedChat(chats: ConversationChat[]): ConversationChat | undefined {
  let bestChat: ConversationChat | undefined;

  for (const chat of chats) {
    if (!bestChat || chat.updatedAt > bestChat.updatedAt) {
      bestChat = chat;
    }
  }

  return bestChat;
}

function latestPromptUpdatedAt(chat: ConversationChat): number {
  let updatedAt = 0;

  for (const turn of chat.turns) {
    if (!turn.blocks['user-input'].content.trim()) {
      continue;
    }

    updatedAt = Math.max(updatedAt, turn.updatedAt);
  }

  return updatedAt;
}

function getLatestPromptTextForChat(chat: ConversationChat): string {
  let latestTurn: ConversationTurn | undefined;

  for (const turn of chat.turns) {
    if (!turn.blocks['user-input'].content.trim()) {
      continue;
    }

    if (!latestTurn || turn.updatedAt >= latestTurn.updatedAt) {
      latestTurn = turn;
    }
  }

  return latestTurn?.blocks['user-input'].content ?? '';
}

function mergeCursorTurns(
  persistedTurns: ConversationTurn[],
  liveTurns: ConversationTurn[]
): ConversationTurn[] {
  if (persistedTurns.length === 0) {
    return liveTurns.map((turn) => cloneTurn(turn));
  }

  if (liveTurns.length === 0) {
    return persistedTurns.map((turn) => cloneTurn(turn));
  }

  const persisted = persistedTurns.map((turn) => cloneTurn(turn));
  const live = liveTurns.map((turn) => cloneTurn(turn));
  const matchedPersisted = new Set<number>();
  const merged: ConversationTurn[] = [];

  live.forEach((liveTurn, liveIndex) => {
    const matchIndex = findMatchingCursorTurnIndex(persisted, liveTurn, liveIndex, matchedPersisted);
    if (matchIndex === undefined) {
      merged.push(liveTurn);
      return;
    }

    matchedPersisted.add(matchIndex);
    merged.push(mergeConversationTurn(persisted[matchIndex], liveTurn));
  });

  persisted.forEach((persistedTurn, index) => {
    if (!matchedPersisted.has(index)) {
      merged.push(persistedTurn);
    }
  });

  return merged.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.id.localeCompare(right.id);
  });
}

function findMatchingCursorTurnIndex(
  persistedTurns: ConversationTurn[],
  liveTurn: ConversationTurn,
  liveIndex: number,
  matchedPersisted: Set<number>
): number | undefined {
  const livePrompt = normalizeComparableText(liveTurn.blocks['user-input'].content);
  if (livePrompt) {
    const promptMatch = persistedTurns.findIndex((candidate, index) =>
      !matchedPersisted.has(index)
      && normalizeComparableText(candidate.blocks['user-input'].content) === livePrompt
    );
    if (promptMatch !== -1) {
      return promptMatch;
    }
  }

  if (liveIndex < persistedTurns.length && !matchedPersisted.has(liveIndex)) {
    return liveIndex;
  }

  const liveSignature = buildTurnMatchSignature(liveTurn);
  if (liveSignature) {
    const signatureMatch = persistedTurns.findIndex((candidate, index) =>
      !matchedPersisted.has(index)
      && buildTurnMatchSignature(candidate) === liveSignature
    );
    if (signatureMatch !== -1) {
      return signatureMatch;
    }
  }

  return undefined;
}

function buildTurnMatchSignature(turn: ConversationTurn): string {
  return [
    turn.requestType ?? 'primary',
    normalizeComparableText(turn.blocks['user-input'].content),
    normalizeComparableText(turn.blocks['agent-editor'].content),
    normalizeComparableText(turn.blocks['agent-subagent'].content),
    normalizeComparableText(turn.blocks['agent-output'].content),
  ]
    .filter(Boolean)
    .join('::');
}

function mergeConversationTurn(
  persistedTurn: ConversationTurn,
  liveTurn: ConversationTurn
): ConversationTurn {
  const merged = cloneTurn(liveTurn);
  merged.parentTurnId = liveTurn.parentTurnId ?? persistedTurn.parentTurnId;
  merged.requestId = liveTurn.requestId ?? persistedTurn.requestId;
  merged.requestType = liveTurn.requestType ?? persistedTurn.requestType;
  merged.createdAt = Math.min(persistedTurn.createdAt, liveTurn.createdAt);
  merged.updatedAt = Math.max(persistedTurn.updatedAt, liveTurn.updatedAt);
  merged.isComplete = liveTurn.isComplete || persistedTurn.isComplete;
  merged.model = liveTurn.model ?? persistedTurn.model;
  merged.modelConfidence = liveTurn.modelConfidence ?? persistedTurn.modelConfidence;

  for (const blockType of BLOCK_TYPES) {
    merged.blocks[blockType] = mergeConversationSegment(
      persistedTurn.blocks[blockType],
      liveTurn.blocks[blockType]
    );
  }

  merged.capturedTokenUsage = mergeCapturedUsageObjects(
    persistedTurn.capturedTokenUsage,
    liveTurn.capturedTokenUsage
  );

  const persistedChildren = persistedTurn.childTurns ?? [];
  const liveChildren = liveTurn.childTurns ?? [];
  const mergedChildren = mergeCursorTurns(persistedChildren, liveChildren);
  if (mergedChildren.length > 0) {
    merged.childTurns = mergedChildren;
  }

  return merged;
}

function mergeConversationSegment(
  persistedSegment: ConversationSegment | undefined,
  liveSegment: ConversationSegment | undefined
): ConversationSegment {
  const persistedContent = persistedSegment?.content ?? '';
  const liveContent = liveSegment?.content ?? '';
  let content = liveContent;

  if (!liveContent.trim()) {
    content = persistedContent;
  } else if (persistedContent.trim() && persistedContent.length > liveContent.length) {
    content = persistedContent;
  }

  return {
    content,
    isStreaming: Boolean(liveSegment?.isStreaming || persistedSegment?.isStreaming),
  };
}

function mergeCapturedUsageObjects(
  persisted: CapturedTokenUsage | undefined,
  live: CapturedTokenUsage | undefined
): CapturedTokenUsage | undefined {
  if (!persisted && !live) {
    return undefined;
  }

  const merged: CapturedTokenUsage = {
    ...persisted,
    ...live,
  };
  for (const key of [
    'inputTokens',
    'editorInputTokens',
    'editorOutputTokens',
    'thinkingTokens',
    'subagentTokens',
    'editorTokens',
    'outputTokens',
  ] as const) {
    const persistedValue = persisted?.[key];
    const liveValue = live?.[key];
    if (typeof persistedValue === 'number' && typeof liveValue === 'number') {
      merged[key] = Math.max(persistedValue, liveValue);
    }
  }

  return merged;
}

function extractCursorNamedTitle(value: string): string | undefined {
  const match = value.match(/<name>([^<]+)<\/name>/i);
  return match?.[1]?.trim() || undefined;
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

function isCursorGenericNewChatLabel(value: string | undefined): boolean {
  const normalized = normalizeComparableText(value ?? '');
  return normalized === 'new agent'
    || normalized === 'new chat'
    || normalized === 'untitled chat'
    || normalized.startsWith('new agent ');
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function collectCursorTabStrings(tab: vscode.Tab): string[] {
  const rawTab = tab as vscode.Tab & { tooltip?: string | { value?: string } };
  const values = new Set<string>();
  const tooltipValue = typeof rawTab.tooltip === 'string'
    ? rawTab.tooltip
    : rawTab.tooltip?.value;

  pushCursorTabString(values, tab.label);
  pushCursorTabString(values, tooltipValue);
  collectCursorValueStrings(tab.input, values, 0, new WeakSet<object>());

  return [...values];
}

function collectCursorValueStrings(
  value: unknown,
  values: Set<string>,
  depth: number,
  visited: WeakSet<object>
): void {
  if (depth > 3 || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    pushCursorTabString(values, value);
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    pushCursorTabString(values, String(value));
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  if (visited.has(record)) {
    return;
  }
  visited.add(record);

  const maybeUri = record as Partial<vscode.Uri>;
  pushCursorTabString(values, maybeUri.fsPath);
  pushCursorTabString(values, maybeUri.path);
  pushCursorTabString(values, maybeUri.fragment);
  pushCursorTabString(values, maybeUri.query);
  if (typeof (maybeUri as { toString?: () => string }).toString === 'function') {
    try {
      pushCursorTabString(values, (maybeUri as { toString: () => string }).toString());
    } catch {
      // Ignore inaccessible toString implementations.
    }
  }

  for (const key of Object.getOwnPropertyNames(record)) {
    if (key.startsWith('_')) {
      continue;
    }

    let nextValue: unknown;
    try {
      nextValue = record[key];
    } catch {
      continue;
    }

    collectCursorValueStrings(nextValue, values, depth + 1, visited);
  }
}

function pushCursorTabString(target: Set<string>, value: string | undefined): void {
  if (!value) {
    return;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  target.add(trimmed);
}

function fileUriToFsPath(value: string): string {
  if (!value) {
    return value;
  }

  try {
    return value.startsWith('file:')
      ? path.normalize(new URL(value).pathname)
      : value;
  } catch {
    return value;
  }
}

function normalizeFsPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return path.normalize(value);
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeFsPath(left) === normalizeFsPath(right);
}
