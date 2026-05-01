import type { Dirent, FSWatcher, Stats } from 'fs';
import { existsSync, promises as fs, watch as fsWatch } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildAppStoragePathCandidates,
  extractCursorActiveComposerIds,
  extractAntigravitySelectedModelName,
  firstExistingPath,
  formatError,
  pathExists,
  readMergedSqliteKeyMap,
} from './stateSqlite';
import {
  BLOCK_TYPES,
  BlockType,
  cloneTurn,
  ConversationChat,
  ConversationCollection,
  ConversationSegment,
  ConversationTurn,
  HostApp,
  ModelConfidence,
} from './types';
const STREAMING_GRACE_MS = 2500;
const RECENT_LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000;
const MAX_CURSOR_TRANSCRIPTS = 240;
const MAX_ANTIGRAVITY_CHATS = 240;
const ANTIGRAVITY_NEW_CHAT_GRACE_MS = 35 * 24 * 60 * 60 * 1000;
const REFRESH_DEBOUNCE_MS = 60;
const ANTIGRAVITY_POLL_INTERVAL_MS = 3000;

interface StoreWatcherCallbacks {
  onCollectionCaptured(collection: ConversationCollection): void;
}

interface CursorComposerHeader {
  composerId: string;
  name?: string;
  subtitle?: string;
  contextUsagePercent?: number;
  createdAt?: number;
  lastUpdatedAt?: number;
  conversationCheckpointLastUpdatedAt?: number;
  isArchived?: boolean;
  isDraft?: boolean;
  workspaceIdentifier?: {
    uri?: {
      fsPath?: string;
      path?: string;
      external?: string;
    };
  };
}

interface CursorComposerState {
  activeComposerIds: string[];
  selectedComposerIds: string[];
  lastFocusedComposerIds: string[];
}

interface CursorTranscriptToolUse {
  name: string;
  content: string;
  prompt?: string;
}

interface CursorTranscriptEntry {
  role: string;
  text: string;
  toolUses: CursorTranscriptToolUse[];
  timestamp?: number;
}

interface CursorTranscriptTurnDraft {
  userInput: string;
  assistantEntries: CursorTranscriptEntry[];
  editorToolUses: CursorTranscriptToolUse[];
  fallbackSubagentToolUses: CursorTranscriptToolUse[];
  createdAt: number;
  updatedAt: number;
}

interface CursorSubagentTranscript {
  createdAt: number;
  updatedAt: number;
  turn: ConversationTurn;
}

interface AntigravitySummaryEntry {
  id: string;
  title: string;
  subtitle?: string;
  order: number;
}

interface AntigravityArtifactMetadata {
  artifactType?: string;
  summary?: string;
  updatedAt?: string;
  version?: string;
}

interface AntigravityArtifact {
  baseName: string;
  content: string;
  kind: BlockType;
  summary?: string;
  updatedAt: number;
  createdAt: number;
  revision: number;
  isCurrentRevision: boolean;
}

interface WatchTarget {
  basePath: string;
  pattern: string;
  label: string;
}

interface AntigravityState {
  summaries: AntigravitySummaryEntry[];
  selectedChatId?: string;
  model?: string;
  modelConfidence?: ModelConfidence;
}

export class ConversationStoreWatcher implements vscode.Disposable {
  private readonly callbacks: StoreWatcherCallbacks;
  private readonly output: vscode.OutputChannel;
  private readonly hostApp: HostApp;
  private readonly knownRoots = new Set<string>();
  private readonly fileWatchers: vscode.Disposable[] = [];
  private readonly nativeWatchers: FSWatcher[] = [];
  private refreshHandle?: NodeJS.Timeout;
  private pollHandle?: NodeJS.Timeout;
  private nativeRefreshHandle?: NodeJS.Timeout;
  private started = false;
  private watchTargetFingerprint = '';
  private baselineFingerprint = '';
  private lastFingerprint = '';
  private resettingBaseline = false;

  constructor(
    callbacks: StoreWatcherCallbacks,
    output: vscode.OutputChannel,
    hostApp: HostApp
  ) {
    this.callbacks = callbacks;
    this.output = output;
    this.hostApp = hostApp;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    void this.syncWatchers();
    this.scheduleRefresh();

    if (this.hostApp === 'antigravity') {
      this.pollHandle = setInterval(() => this.scheduleRefresh(), ANTIGRAVITY_POLL_INTERVAL_MS);
      this.startNativeStateWatchers();
    }
  }

  resetBaseline(): void {
    void this.captureBaseline();
  }

  dispose(): void {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle);
      this.refreshHandle = undefined;
    }
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    if (this.nativeRefreshHandle) {
      clearTimeout(this.nativeRefreshHandle);
      this.nativeRefreshHandle = undefined;
    }
    this.watchTargetFingerprint = '';

    while (this.fileWatchers.length > 0) {
      this.fileWatchers.pop()?.dispose();
    }
    while (this.nativeWatchers.length > 0) {
      this.nativeWatchers.pop()?.close();
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle);
    }

    this.refreshHandle = setTimeout(() => {
      this.refreshHandle = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Native fs.watch() file watchers on the Antigravity state directory.
   * This replicates the exact pattern used by orbit-hub for real-time
   * updates.  vscode.workspace.createFileSystemWatcher does not reliably
   * fire for paths outside the workspace (e.g. ~/Library/Application
   * Support/Antigravity/).  Node.js native fs.watch() on the directory
   * detects writes to state.vscdb / state.vscdb-wal / state.vscdb-shm
   * within milliseconds.
   */
  private startNativeStateWatchers(): void {
    const candidates = buildAppStoragePathCandidates(
      'Antigravity', 'User', 'globalStorage', 'state.vscdb'
    );

    for (const dbPath of candidates) {
      const stateDir = path.dirname(dbPath);
      if (!existsSync(stateDir)) {
        continue;
      }

      const watchedFiles = new Set([
        path.basename(dbPath),
        path.basename(dbPath) + '-wal',
        path.basename(dbPath) + '-shm',
        path.basename(dbPath) + '-journal',
      ]);

      try {
        const watcher = fsWatch(stateDir, (_eventType, filename) => {
          if (!filename) { return; }
          if (watchedFiles.has(filename.toString())) {
            this.scheduleNativeRefresh();
          }
        });
        this.nativeWatchers.push(watcher);
        this.output.appendLine(`[stores] Native fs.watch() active on ${stateDir}`);
      } catch {
        // Directory watch failed; polling remains as fallback.
      }
    }

    const brainRoot = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    if (existsSync(brainRoot)) {
      try {
        const watcher = fsWatch(brainRoot, { recursive: true }, () => {
          this.scheduleNativeRefresh();
        });
        this.nativeWatchers.push(watcher);
        this.output.appendLine(`[stores] Native fs.watch() active on ${brainRoot}`);
      } catch {
        // Brain directory watch failed; polling remains as fallback.
      }
    }
  }

  /** 300ms debounce for native fs.watch events — matches orbit-hub. */
  private scheduleNativeRefresh(): void {
    if (this.nativeRefreshHandle) {
      clearTimeout(this.nativeRefreshHandle);
    }
    this.nativeRefreshHandle = setTimeout(() => {
      this.nativeRefreshHandle = undefined;
      void this.refresh();
    }, 300);
  }

  private async syncWatchers(): Promise<void> {
    const targets = await this.getWatchTargets();
    const fingerprint = JSON.stringify(targets);
    if (fingerprint === this.watchTargetFingerprint) {
      return;
    }

    this.watchTargetFingerprint = fingerprint;
    while (this.fileWatchers.length > 0) {
      this.fileWatchers.pop()?.dispose();
    }

    for (const target of targets) {
      if (!(await pathExists(target.basePath))) {
        continue;
      }

      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(target.basePath), target.pattern)
      );
      const schedule = () => this.scheduleRefresh();
      watcher.onDidCreate(schedule);
      watcher.onDidChange(schedule);
      watcher.onDidDelete(schedule);
      this.fileWatchers.push(watcher);
      this.logDiscoveredRoot(path.join(target.basePath, target.pattern), target.label);
    }
  }

  private async captureBaseline(): Promise<void> {
    this.resettingBaseline = true;

    try {
      const collection = await this.collectCollection();
      this.baselineFingerprint = fingerprintCollection(collection);
      this.lastFingerprint = this.baselineFingerprint;
    } catch (error) {
      this.output.appendLine(`[stores] Failed to capture baseline: ${formatError(error)}`);
    } finally {
      this.resettingBaseline = false;
    }
  }

  private async refresh(): Promise<void> {
    if (this.resettingBaseline) {
      return;
    }

    try {
      await this.syncWatchers();
      const collection = await this.collectCollection();
      const fingerprint = fingerprintCollection(collection);

      if (fingerprint === this.lastFingerprint || fingerprint === this.baselineFingerprint) {
        this.lastFingerprint = fingerprint;
        return;
      }

      this.lastFingerprint = fingerprint;
      this.callbacks.onCollectionCaptured(collection);
    } catch (error) {
      this.output.appendLine(`[stores] Refresh failed: ${formatError(error)}`);
    }
  }

  private async collectCollection(): Promise<ConversationCollection> {
    switch (this.hostApp) {
      case 'cursor':
        return this.collectCursorCollection();
      case 'antigravity':
        return this.collectAntigravityCollection();
      default:
        return { chats: [] };
    }
  }

  private async getWatchTargets(): Promise<WatchTarget[]> {
    const workspacePaths = this.getWorkspacePaths();
    const targets: WatchTarget[] = [];

    if (this.hostApp === 'cursor') {
      const globalDbPath = await firstExistingPath(
        buildAppStoragePathCandidates('Cursor', 'User', 'globalStorage', 'state.vscdb')
      );
      if (globalDbPath) {
        targets.push(...buildSqliteWatchTargets(globalDbPath, 'Cursor global state'));
      }

      const workspaceStorageDir = await findWorkspaceStorageDir('Cursor', workspacePaths);
      if (workspaceStorageDir) {
        targets.push(...buildSqliteWatchTargets(path.join(workspaceStorageDir, 'state.vscdb'), 'Cursor workspace state'));
      }

      for (const transcriptRoot of this.getCursorTranscriptRoots(workspacePaths)) {
        targets.push(...buildRecursiveWatchTargets(transcriptRoot, 'Cursor transcripts'));
      }
    }

    if (this.hostApp === 'antigravity') {
      const globalDbPath = await firstExistingPath(
        buildAppStoragePathCandidates('Antigravity', 'User', 'globalStorage', 'state.vscdb')
      );
      if (globalDbPath) {
        targets.push(...buildSqliteWatchTargets(globalDbPath, 'Antigravity global state'));
      }

      const workspaceDbPaths = await this.getAntigravityWorkspaceDbPaths(workspacePaths);
      for (const workspaceDbPath of workspaceDbPaths) {
        targets.push(...buildSqliteWatchTargets(workspaceDbPath, 'Antigravity workspace state'));
      }

      const brainRoot = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
      targets.push(...buildRecursiveWatchTargets(brainRoot, 'Antigravity brain artifacts'));
    }

    return dedupeWatchTargets(targets);
  }

  private async collectCursorCollection(): Promise<ConversationCollection> {
    const workspacePaths = this.getWorkspacePaths();
    if (workspacePaths.length === 0) {
      return { chats: [] };
    }

    const [headers, composerState] = await Promise.all([
      this.readCursorComposerHeaders(workspacePaths),
      this.readCursorComposerState(workspacePaths),
    ]);

    const chatsById = new Map<string, ConversationChat>();

    for (const transcriptRoot of this.getCursorTranscriptRoots(workspacePaths)) {
      if (!(await pathExists(transcriptRoot))) {
        continue;
      }

      this.logDiscoveredRoot(transcriptRoot, 'Cursor transcripts');

      const transcriptFiles = await this.listTranscriptFiles(transcriptRoot);
      for (const transcriptFile of transcriptFiles) {
        const composerId = path.basename(path.dirname(transcriptFile));
        const chat = await this.parseCursorTranscriptChat(transcriptFile, headers.get(composerId));
        chatsById.set(chat.id, chat);
      }
    }

    for (const header of headers.values()) {
      if (header.isArchived || header.isDraft) {
        continue;
      }

      if (!chatsById.has(header.composerId)) {
        const now = header.lastUpdatedAt ?? header.conversationCheckpointLastUpdatedAt ?? header.createdAt ?? Date.now();
        chatsById.set(header.composerId, {
          id: header.composerId,
          title: normalizeTitle(header.name) || normalizeTitle(header.subtitle) || 'Untitled chat',
          subtitle: normalizeSubtitle(header.subtitle),
          createdAt: header.createdAt ?? now,
          updatedAt: now,
          turns: [],
          sourceId: 'cursor',
          sourceLabel: 'Cursor',
          contextUsagePercent: typeof header.contextUsagePercent === 'number'
            ? header.contextUsagePercent
            : undefined,
        });
      }
    }

    const selectedCandidates = [
      ...composerState.activeComposerIds,
      ...composerState.lastFocusedComposerIds,
      ...composerState.selectedComposerIds,
    ];

    const selectedChatId = selectedCandidates.find((id) => chatsById.has(id));
    const orderBySelection = new Map<string, number>();
    selectedCandidates.forEach((id, index) => {
      if (!orderBySelection.has(id)) {
        orderBySelection.set(id, index);
      }
    });

    const chats = [...chatsById.values()]
      .sort((left, right) => {
        const leftOrder = orderBySelection.get(left.id);
        const rightOrder = orderBySelection.get(right.id);

        if (leftOrder !== undefined || rightOrder !== undefined) {
          return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
        }

        if (left.updatedAt !== right.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }

        return left.title.localeCompare(right.title);
      });

    return {
      chats,
      selectedChatId: selectedChatId ?? chats[0]?.id,
    };
  }

  private async collectAntigravityCollection(): Promise<ConversationCollection> {
    const workspacePaths = this.getWorkspacePaths();

    const antigravityState = await this.readAntigravityState(workspacePaths);
    const summaries = new Map(antigravityState.summaries.map((summary) => [summary.id, summary]));
    const brainRoot = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    const chats = (await this.collectAntigravityBrainChats(brainRoot, summaries, antigravityState.selectedChatId))
      .map((chat) => ({
        ...chat,
        model: antigravityState.model ?? chat.model,
        modelConfidence: antigravityState.model
          ? antigravityState.modelConfidence ?? chat.modelConfidence ?? 'inferred'
          : chat.modelConfidence,
          }));

    const resolvedSelectedChatId = resolveAntigravityActiveChatId(
      chats,
      antigravityState.selectedChatId,
      summaries,
    );

    if (chats.length === 0 && antigravityState.summaries.length > 0) {
      const fallbackChats = await Promise.all(
        antigravityState.summaries.map(async (summary, index) => {
          const chat = await this.parseAntigravitySummaryChat(summary, index);
          return {
            ...chat,
            model: antigravityState.model ?? chat.model,
            modelConfidence: antigravityState.model
              ? antigravityState.modelConfidence ?? chat.modelConfidence ?? 'inferred'
              : chat.modelConfidence,
          };
        })
      );
      return {
        chats: fallbackChats,
        selectedChatId: resolveAntigravityActiveChatId(
          fallbackChats,
          antigravityState.selectedChatId,
          summaries,
        ) ?? fallbackChats[0]?.id,
      };
    }

    return {
      chats,
      selectedChatId: resolvedSelectedChatId ?? chats[0]?.id,
    };
  }

  private async readCursorComposerHeaders(workspacePaths: string[]): Promise<Map<string, CursorComposerHeader>> {
    const dbPath = await firstExistingPath(
      buildAppStoragePathCandidates('Cursor', 'User', 'globalStorage', 'state.vscdb')
    );
    if (!dbPath) {
      return new Map();
    }

    this.logDiscoveredRoot(dbPath, 'Cursor global state');

    const values = await readMergedSqliteKeyMap(dbPath, ['composer.composerHeaders']);
    const raw = values['composer.composerHeaders'];
    if (!raw) {
      return new Map();
    }

    try {
      const parsed = JSON.parse(raw) as { allComposers?: CursorComposerHeader[] };
      const map = new Map<string, CursorComposerHeader>();

      for (const header of parsed.allComposers ?? []) {
        const headerWorkspacePath = normalizeFsPath(
          header.workspaceIdentifier?.uri?.fsPath ?? header.workspaceIdentifier?.uri?.path
        );

        if (
          headerWorkspacePath &&
          !workspacePaths.some((workspacePath) => pathsEqual(headerWorkspacePath, workspacePath))
        ) {
          continue;
        }

        map.set(header.composerId, header);
      }

      return map;
    } catch (error) {
      this.output.appendLine(`[stores] Failed to parse Cursor composer headers: ${formatError(error)}`);
      return new Map();
    }
  }

  private async readCursorComposerState(workspacePaths: string[]): Promise<CursorComposerState> {
    const workspaceStorageDir = await findWorkspaceStorageDir('Cursor', workspacePaths);
    if (!workspaceStorageDir) {
      return {
        activeComposerIds: [],
        selectedComposerIds: [],
        lastFocusedComposerIds: [],
      };
    }

    const dbPath = path.join(workspaceStorageDir, 'state.vscdb');
    this.logDiscoveredRoot(dbPath, 'Cursor workspace state');

    const values = await readMergedSqliteKeyMap(dbPath, [
      'composer.composerData',
      'memento/workbench.parts.embeddedAuxBarEditor.state',
    ]);
    const raw = values['composer.composerData'];
    const embeddedState = values['memento/workbench.parts.embeddedAuxBarEditor.state'];
    if (!raw) {
      return {
        activeComposerIds: extractCursorActiveComposerIds(undefined, embeddedState),
        selectedComposerIds: [],
        lastFocusedComposerIds: [],
      };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CursorComposerState>;
      return {
        activeComposerIds: extractCursorActiveComposerIds(raw, embeddedState),
        selectedComposerIds: Array.isArray(parsed.selectedComposerIds) ? parsed.selectedComposerIds : [],
        lastFocusedComposerIds: Array.isArray(parsed.lastFocusedComposerIds) ? parsed.lastFocusedComposerIds : [],
      };
    } catch (error) {
      this.output.appendLine(`[stores] Failed to parse Cursor composer state: ${formatError(error)}`);
      return {
        activeComposerIds: extractCursorActiveComposerIds(undefined, embeddedState),
        selectedComposerIds: [],
        lastFocusedComposerIds: [],
      };
    }
  }

  private async readAntigravityState(workspacePaths: string[]): Promise<AntigravityState> {
    const globalDbPath = await firstExistingPath(
      buildAppStoragePathCandidates('Antigravity', 'User', 'globalStorage', 'state.vscdb')
    );
    const preferredWorkspaceStorageDir = workspacePaths.length > 0
      ? await findWorkspaceStorageDir('Antigravity', workspacePaths)
      : undefined;
    const preferredWorkspaceDbPath = preferredWorkspaceStorageDir
      ? path.join(preferredWorkspaceStorageDir, 'state.vscdb')
      : undefined;
    const workspaceDbPaths = await this.getAntigravityWorkspaceDbPaths(workspacePaths);

    if (globalDbPath) {
      this.logDiscoveredRoot(globalDbPath, 'Antigravity global state');
    }
    for (const workspaceDbPath of workspaceDbPaths) {
      this.logDiscoveredRoot(workspaceDbPath, 'Antigravity workspace state');
    }

    const globalValuesPromise: Promise<Record<string, string>> = globalDbPath
      ? readMergedSqliteKeyMap(globalDbPath, [
        'antigravityUnifiedStateSync.trajectorySummaries',
        'antigravityUnifiedStateSync.modelPreferences',
        'antigravityUnifiedStateSync.userStatus',
      ])
      : Promise.resolve({});
    const workspaceValuesPromise = Promise.all(
      workspaceDbPaths.map(async (workspaceDbPath) => {
        const values = await readMergedSqliteKeyMap(workspaceDbPath, [
          'memento/antigravity.jetskiArtifactsEditor',
          'memento/workbench.parts.editor',
        ]);
        return {
          dbPath: workspaceDbPath,
          jetskiRawValue: values['memento/antigravity.jetskiArtifactsEditor'],
          workbenchEditorRawValue: values['memento/workbench.parts.editor'],
          updatedAt: await latestSqliteWriteMs(workspaceDbPath),
        };
      })
    );

    const [globalValues, workspaceSelections] = await Promise.all([
      globalValuesPromise,
      workspaceValuesPromise,
    ]);
    const liveUserStatus = await getLiveAntigravityUserStatus();

    const preferredWorkspaceSelection = workspaceSelections.find((selection) =>
      Boolean(selection.jetskiRawValue || selection.workbenchEditorRawValue)
      && preferredWorkspaceDbPath
      && pathsEqual(selection.dbPath, preferredWorkspaceDbPath)
    );
    const freshestWorkspaceSelection = workspaceSelections
      .filter((selection) => Boolean(selection.jetskiRawValue || selection.workbenchEditorRawValue))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];

    const summaries = parseAntigravitySummaryEntries(
      globalValues['antigravityUnifiedStateSync.trajectorySummaries'],
      workspacePaths
    );
    const selectedChatId = parseAntigravitySelectedChatId(
      preferredWorkspaceSelection?.workbenchEditorRawValue
        ?? freshestWorkspaceSelection?.workbenchEditorRawValue,
      preferredWorkspaceSelection?.jetskiRawValue
        ?? freshestWorkspaceSelection?.jetskiRawValue
    );
    const model = extractAntigravitySelectedModelName(
      globalValues['antigravityUnifiedStateSync.modelPreferences'],
      liveUserStatus ?? globalValues['antigravityUnifiedStateSync.userStatus']
    );

    return {
      summaries,
      selectedChatId,
      model,
      modelConfidence: model ? 'exact' : 'unknown',
    };
  }

  private async getAntigravityWorkspaceDbPaths(workspacePaths: string[]): Promise<string[]> {
    const orderedPaths: string[] = [];
    const seen = new Set<string>();

    const pushDbPath = (dbPath?: string) => {
      if (!dbPath) {
        return;
      }

      const normalized = normalizeFsPath(dbPath);
      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      orderedPaths.push(normalized);
    };

    if (workspacePaths.length > 0) {
      const matchedWorkspaceStorageDir = await findWorkspaceStorageDir('Antigravity', workspacePaths);
      pushDbPath(matchedWorkspaceStorageDir
        ? path.join(matchedWorkspaceStorageDir, 'state.vscdb')
        : undefined);
    }

    const roots = buildAppStoragePathCandidates('Antigravity', 'User', 'workspaceStorage');

    for (const root of roots) {
      if (!(await pathExists(root))) {
        continue;
      }

      const entries = await readDirSafe(root);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const dbPath = path.join(root, entry.name, 'state.vscdb');
        if (await pathExists(dbPath)) {
          pushDbPath(dbPath);
        }
      }
    }

    return orderedPaths;
  }

  private getCursorTranscriptRoots(workspacePaths: string[]): string[] {
    const roots = new Set<string>();

    for (const workspacePath of workspacePaths) {
      const slug = workspacePathToSlug(workspacePath);
      if (!slug) {
        continue;
      }

      roots.add(path.join(os.homedir(), '.cursor', 'projects', slug, 'agent-transcripts'));
    }

    return [...roots];
  }

  private async listTranscriptFiles(root: string): Promise<string[]> {
    const transcriptFiles: Array<{ filePath: string; updatedAt: number }> = [];
    const conversationDirs = await readDirSafe(root);

    for (const dirEntry of conversationDirs) {
      if (!dirEntry.isDirectory()) {
        continue;
      }

      const conversationDir = path.join(root, dirEntry.name);
      const nestedEntries = await readDirSafe(conversationDir);
      for (const nestedEntry of nestedEntries) {
        if (!nestedEntry.isFile() || !nestedEntry.name.endsWith('.jsonl')) {
          continue;
        }

        const filePath = path.join(conversationDir, nestedEntry.name);
        const stats = await safeStat(filePath);
        if (!stats) {
          continue;
        }

        if (stats.mtimeMs < Date.now() - RECENT_LOOKBACK_MS) {
          continue;
        }

        transcriptFiles.push({
          filePath,
          updatedAt: stats.mtimeMs,
        });
      }
    }

    transcriptFiles.sort((left, right) => right.updatedAt - left.updatedAt);
    return transcriptFiles.slice(0, MAX_CURSOR_TRANSCRIPTS).map((item) => item.filePath);
  }

  private async parseCursorTranscriptChat(
    filePath: string,
    header?: CursorComposerHeader
  ): Promise<ConversationChat> {
    const stats = await safeStat(filePath);
    const raw = await safeReadFile(filePath);
    const composerId = path.basename(path.dirname(filePath));
    const fallbackTimestamp = Date.now();
    const createdAt = header?.createdAt ?? stats?.birthtimeMs ?? stats?.mtimeMs ?? fallbackTimestamp;
    const updatedAt = Math.max(
      header?.lastUpdatedAt ?? 0,
      header?.conversationCheckpointLastUpdatedAt ?? 0,
      stats?.mtimeMs ?? 0,
      createdAt
    );
    const entries: CursorTranscriptEntry[] = [];
    for (const line of (raw ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        const role = typeof parsed?.role === 'string' ? parsed.role : '';
        const message = extractCursorStructuredMessage(parsed?.message);
        if (role && (message.text || message.toolUses.length > 0)) {
          entries.push({
            role,
            text: message.text,
            toolUses: message.toolUses,
            timestamp: parseEmbeddedTimestamp(message.text),
          });
        }
      } catch {
        // Ignore incomplete trailing lines while the host is still writing.
      }
    }

    const drafts: CursorTranscriptTurnDraft[] = [];
    let currentTurn: CursorTranscriptTurnDraft | undefined;

    for (const entry of entries) {
      if (entry.role === 'user') {
        const normalizedUserInput = normalizeUserMessage(entry.text);
        const turnTimestamp = entry.timestamp ?? updatedAt + drafts.length;
        currentTurn = {
          userInput: normalizedUserInput,
          assistantEntries: [],
          editorToolUses: [],
          fallbackSubagentToolUses: [],
          createdAt: turnTimestamp,
          updatedAt: turnTimestamp,
        };
        drafts.push(currentTurn);
        continue;
      }

      if (entry.role !== 'assistant' || !currentTurn) {
        continue;
      }

      currentTurn.updatedAt = Math.max(currentTurn.updatedAt, entry.timestamp ?? currentTurn.updatedAt);
      currentTurn.assistantEntries.push(entry);
      for (const toolUse of entry.toolUses) {
        if (isCursorEditorToolName(toolUse.name)) {
          currentTurn.editorToolUses.push(toolUse);
        } else if (isCursorSubagentToolName(toolUse.name)) {
          currentTurn.fallbackSubagentToolUses.push(toolUse);
        }
      }
    }

    const subagentTranscripts = await this.readCursorSubagentTranscripts(path.dirname(filePath));
    const turns = drafts.map((draft, index) =>
      this.buildCursorTranscriptTurn(
        composerId,
        index,
        draft,
        drafts,
        subagentTranscripts,
        updatedAt
      )
    );

    const latestTurn = turns[turns.length - 1];
    const title = normalizeTitle(header?.name)
      || normalizeTitle(header?.subtitle)
      || snippetForTitle(latestTurn?.blocks['user-input'].content)
      || 'Untitled chat';

    const subtitle = normalizeSubtitle(header?.subtitle)
      || snippetForSubtitle(latestTurn?.blocks['agent-output'].content)
      || snippetForSubtitle(latestTurn?.blocks['user-input'].content);

    return {
      id: composerId,
      title,
      subtitle,
      createdAt,
      updatedAt,
      turns,
      sourceId: 'cursor',
      sourceLabel: 'Cursor',
      contextUsagePercent: typeof header?.contextUsagePercent === 'number'
        ? header.contextUsagePercent
        : undefined,
    };
  }

  private buildCursorTranscriptTurn(
    composerId: string,
    index: number,
    draft: CursorTranscriptTurnDraft,
    drafts: CursorTranscriptTurnDraft[],
    subagentTranscripts: CursorSubagentTranscript[],
    fileUpdatedAt: number
  ): ConversationTurn {
    const assistantMessages = draft.assistantEntries
      .map((entry) => normalizeAssistantMessage(entry.text))
      .filter((value): value is string => Boolean(value));
    const turn = this.createTurnFromMessages(
      `${composerId}:turn:${index + 1}`,
      draft.userInput,
      assistantMessages,
      draft.createdAt || fileUpdatedAt + index,
      Math.max(draft.updatedAt, fileUpdatedAt + index),
      Date.now() - Math.max(draft.updatedAt, fileUpdatedAt) < STREAMING_GRACE_MS
    );

    const childTurns: ConversationTurn[] = [];
    const nextDraft = drafts[index + 1];
    const matchingSubagents = subagentTranscripts.filter((candidate) =>
      candidate.createdAt >= draft.createdAt
      && (!nextDraft || candidate.createdAt < nextDraft.createdAt)
    );

    if (matchingSubagents.length > 0) {
      childTurns.push(...matchingSubagents.map((candidate) => cloneTurn(candidate.turn)));
    } else if (draft.fallbackSubagentToolUses.length > 0) {
      childTurns.push(
        ...draft.fallbackSubagentToolUses.map((toolUse, toolIndex) =>
          this.createCursorToolChildTurn(
            `${turn.id}:child:subagent:${toolIndex + 1}`,
            'subagent',
            toolUse.prompt ?? toolUse.content,
            toolUse.content,
            draft.createdAt + toolIndex,
            draft.updatedAt + toolIndex
          )
        )
      );
    }

    if (draft.editorToolUses.length > 0) {
      childTurns.push(
        ...draft.editorToolUses.map((toolUse, toolIndex) =>
          this.createCursorToolChildTurn(
            `${turn.id}:child:editor:${toolIndex + 1}`,
            'editor',
            '',
            toolUse.content,
            draft.createdAt + matchingSubagents.length + toolIndex,
            draft.updatedAt + matchingSubagents.length + toolIndex
          )
        )
      );
    }

    if (childTurns.length > 0) {
      turn.childTurns = childTurns
        .sort((left, right) => {
          if (left.createdAt !== right.createdAt) {
            return left.createdAt - right.createdAt;
          }
          return left.id.localeCompare(right.id);
        });
      turn.updatedAt = Math.max(
        turn.updatedAt,
        ...turn.childTurns.map((childTurn) => childTurn.updatedAt)
      );
      turn.isComplete = true;
    }

    return turn;
  }

  private async readCursorSubagentTranscripts(composerDir: string): Promise<CursorSubagentTranscript[]> {
    const subagentsDir = path.join(composerDir, 'subagents');
    if (!(await pathExists(subagentsDir))) {
      return [];
    }

    const entries = await readDirSafe(subagentsDir);
    const transcripts = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(async (entry) => this.parseCursorSubagentTranscript(path.join(subagentsDir, entry.name)))
    );

    return transcripts
      .filter((candidate): candidate is CursorSubagentTranscript => Boolean(candidate))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt - right.createdAt;
        }
        return left.turn.id.localeCompare(right.turn.id);
      });
  }

  private async parseCursorSubagentTranscript(
    filePath: string
  ): Promise<CursorSubagentTranscript | undefined> {
    const stats = await safeStat(filePath);
    const raw = await safeReadFile(filePath);
    if (!raw) {
      return undefined;
    }

    let userInput = '';
    let createdAt = stats?.birthtimeMs ?? stats?.mtimeMs ?? Date.now();
    let updatedAt = stats?.mtimeMs ?? createdAt;
    const assistantMessages: string[] = [];
    const toolSummaries: string[] = [];

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        const role = typeof parsed?.role === 'string' ? parsed.role : '';
        const message = extractCursorStructuredMessage(parsed?.message);
        const timestamp = parseEmbeddedTimestamp(message.text);
        if (role === 'user' && message.text) {
          userInput = normalizeUserMessage(message.text);
          if (timestamp) {
            createdAt = timestamp;
          }
          continue;
        }

        if (role !== 'assistant') {
          continue;
        }

        const assistantText = normalizeAssistantMessage(message.text);
        if (assistantText) {
          assistantMessages.push(assistantText);
        }
        for (const toolUse of message.toolUses) {
          if (normalizeComparableText(toolUse.name) === 'updatecurrentstep') {
            continue;
          }
          toolSummaries.push(formatCursorToolUseSummary(toolUse));
        }
      } catch {
        // Ignore malformed trailing lines while the subagent transcript is still being written.
      }
    }

    if (!userInput && assistantMessages.length === 0 && toolSummaries.length === 0) {
      return undefined;
    }

    const turn = this.createTurnFromMessages(
      path.basename(filePath, '.jsonl'),
      userInput,
      assistantMessages,
      createdAt,
      updatedAt,
      Date.now() - updatedAt < STREAMING_GRACE_MS
    );
    turn.requestType = 'subagent';
    if (toolSummaries.length > 0) {
      turn.blocks['agent-subagent'] = {
        content: toolSummaries.join('\n\n'),
        isStreaming: Date.now() - updatedAt < STREAMING_GRACE_MS,
      };
      turn.isComplete = true;
    }

    return {
      createdAt,
      updatedAt,
      turn,
    };
  }

  private createCursorToolChildTurn(
    turnId: string,
    requestType: 'subagent' | 'editor',
    userInput: string,
    content: string,
    createdAt: number,
    updatedAt: number
  ): ConversationTurn {
    const blocks = this.createTurnFromMessages(
      turnId,
      userInput,
      [],
      createdAt,
      updatedAt,
      false
    ).blocks;

    blocks[requestType === 'editor' ? 'agent-editor' : 'agent-subagent'] = {
      content,
      isStreaming: false,
    };

    const turn = this.createTurn(turnId, blocks, createdAt, updatedAt);
    turn.requestType = requestType;
    turn.isComplete = true;
    return turn;
  }

  private async parseAntigravitySummaryChat(
    summary: AntigravitySummaryEntry,
    index: number
  ): Promise<ConversationChat> {
    const brainRoot = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    const brainDir = path.join(brainRoot, summary.id);

    if (await pathExists(brainDir)) {
      this.logDiscoveredRoot(brainRoot, 'Antigravity brain artifacts');
      const populated = await this.parseAntigravityBrainChat(summary, brainDir, index);
      if (populated) {
        return populated;
      }
    }

    const now = Date.now();
    return {
      id: summary.id,
      title: summary.title,
      subtitle: summary.subtitle,
      createdAt: now - index,
      updatedAt: now - index,
      turns: [],
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
    };
  }

  private async collectAntigravityBrainChats(
    brainRoot: string,
    summaries: ReadonlyMap<string, AntigravitySummaryEntry>,
    selectedChatId?: string
  ): Promise<ConversationChat[]> {
    if (!(await pathExists(brainRoot))) {
      return [];
    }

    this.logDiscoveredRoot(brainRoot, 'Antigravity brain artifacts');

    const directories = await readDirSafe(brainRoot);
    const candidates = await Promise.all(
      directories
        .filter((entry) => entry.isDirectory() && looksLikeUuid(entry.name))
        .map(async (entry) => {
          const dirPath = path.join(brainRoot, entry.name);
          const stats = await safeStat(dirPath);
          return {
            id: entry.name,
            dirPath,
            updatedAt: stats?.mtimeMs ?? 0,
          };
        })
    );

    const summaryIds = new Set(summaries.keys());
    const included = candidates
      .filter((candidate) => {
        if (selectedChatId && candidate.id === selectedChatId) {
          return true;
        }

        if (summaryIds.size === 0) {
          return true;
        }

        if (summaryIds.has(candidate.id)) {
          return true;
        }

        return candidate.updatedAt >= Date.now() - ANTIGRAVITY_NEW_CHAT_GRACE_MS;
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ANTIGRAVITY_CHATS);

    const chats = await Promise.all(
      included.map(async (candidate, index) => {
        const summary = summaries.get(candidate.id) ?? {
          id: candidate.id,
          title: 'New chat',
          order: index,
        };

        return this.parseAntigravityBrainChat(summary, candidate.dirPath, index);
      })
    );

    return chats
      .filter((chat): chat is ConversationChat => Boolean(chat))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async parseAntigravityBrainChat(
    summary: AntigravitySummaryEntry,
    dirPath: string,
    index: number
  ): Promise<ConversationChat | undefined> {
    const artifacts = await loadAntigravityArtifacts(dirPath);
    const directoryStats = await safeStat(dirPath);
    const artifactTimestamps = artifacts.map((artifact) => artifact.updatedAt);
    const updatedAtCandidates = [
      directoryStats?.mtimeMs,
      ...artifactTimestamps,
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const updatedAt = updatedAtCandidates.length > 0
      ? Math.max(...updatedAtCandidates)
      : Date.now() - index;
    const createdAtCandidates = [
      directoryStats?.birthtimeMs,
      directoryStats?.mtimeMs,
      ...artifacts.map((artifact) => artifact.createdAt),
    ].filter((value): value is number => typeof value === 'number');
    const createdAt = createdAtCandidates.length > 0 ? Math.min(...createdAtCandidates) : updatedAt;
    const turns = this.buildAntigravityTurns(summary, artifacts);

    if (turns.length === 0) {
      return {
        id: summary.id,
        title: summary.title || 'New chat',
        subtitle: summary.subtitle,
        createdAt: createdAt - index,
        updatedAt: updatedAt - index,
        turns: [],
        sourceId: 'antigravity',
        sourceLabel: 'Antigravity',
      };
    }

    const latestTurn = turns[turns.length - 1];
    const latestOutput = latestTurn?.blocks['agent-output'].content;
    const latestThinking = latestTurn?.blocks['agent-thinking'].content;
    const latestUserInput = latestTurn?.blocks['user-input'].content;

    const title = normalizeTitle(summary.title)
      || extractAntigravityTitle(latestUserInput)
      || extractAntigravityTitle(latestOutput)
      || artifacts.map((artifact) => artifact.summary).find((value): value is string => Boolean(normalizeTitle(value)))
      || 'Untitled chat';
    const subtitle = normalizeSubtitle(summary.subtitle)
      || artifacts.map((artifact) => normalizeSubtitle(artifact.summary)).find((value): value is string => Boolean(value))
      || snippetForSubtitle(latestOutput)
      || snippetForSubtitle(latestThinking)
      || snippetForSubtitle(latestUserInput);

    return {
      id: summary.id,
      title,
      subtitle,
      createdAt: createdAt - index,
      updatedAt: updatedAt - index,
      turns,
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
    };
  }

  private buildAntigravityTurns(
    summary: AntigravitySummaryEntry,
    artifacts: AntigravityArtifact[]
  ): ConversationTurn[] {
    const userArtifact = pickAntigravityArtifact(artifacts, 'user-input');
    const thinkingArtifact = pickAntigravityArtifact(artifacts, 'agent-thinking');
    const outputArtifact = pickAntigravityArtifact(artifacts, 'agent-output');

    const userInput = normalizeBrainContent(userArtifact?.content);
    const thinking = normalizeBrainContent(thinkingArtifact?.content);
    const output = normalizeBrainContent(outputArtifact?.content);

    if (!userInput && !thinking && !output) {
      return [];
    }

    const createdAtCandidates = [
      userArtifact?.createdAt,
      thinkingArtifact?.createdAt,
      outputArtifact?.createdAt,
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const updatedAt = Math.max(
      userArtifact?.updatedAt ?? 0,
      thinkingArtifact?.updatedAt ?? 0,
      outputArtifact?.updatedAt ?? 0
    );
    const createdAt = createdAtCandidates.length > 0
      ? Math.min(...createdAtCandidates)
      : updatedAt;

    return [this.createTurn(
      `${summary.id}:turn:1`,
      {
        'user-input': {
          content: userInput,
          isStreaming: isAntigravityArtifactStreaming(userArtifact),
        },
        'agent-thinking': {
          content: thinking,
          isStreaming: isAntigravityArtifactStreaming(thinkingArtifact),
        },
        'agent-subagent': {
          content: '',
          isStreaming: false,
        },
        'agent-editor': {
          content: '',
          isStreaming: false,
        },
        'agent-output': {
          content: output,
          isStreaming: isAntigravityArtifactStreaming(outputArtifact),
        },
      },
      createdAt,
      updatedAt
    )];
  }

  private createTurnFromMessages(
    turnId: string,
    userInput: string,
    assistantMessages: string[],
    createdAt: number,
    updatedAt: number,
    isRecentWrite: boolean
  ): ConversationTurn {
    const thinkingMessages = assistantMessages.length > 1
      ? assistantMessages.slice(0, -1)
      : [];
    const output = assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1]
      : '';
    const thinking = thinkingMessages.join('\n\n');

    return this.createTurn(
      turnId,
      {
        'user-input': {
          content: userInput,
          isStreaming: false,
        },
        'agent-thinking': {
          content: thinking,
          isStreaming: isRecentWrite && !output && Boolean(thinking),
        },
        'agent-subagent': {
          content: '',
          isStreaming: false,
        },
        'agent-editor': {
          content: '',
          isStreaming: false,
        },
        'agent-output': {
          content: output,
          isStreaming: isRecentWrite && Boolean(output),
        },
      },
      createdAt,
      updatedAt
    );
  }

  private createTurn(
    turnId: string,
    blocks: Record<BlockType, ConversationSegment>,
    createdAt: number,
    updatedAt: number
  ): ConversationTurn {
    const isComplete = BLOCK_TYPES
      .filter((blockType) => blockType !== 'user-input')
      .some((blockType) => Boolean(blocks[blockType].content.trim()));

    return {
      id: turnId,
      createdAt: Math.floor(createdAt),
      updatedAt: Math.floor(updatedAt),
      isComplete,
      blocks,
    };
  }

  private getWorkspacePaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => normalizeFsPath(folder.uri.fsPath))
      .filter((value): value is string => Boolean(value));
  }

  private logDiscoveredRoot(root: string, label: string): void {
    const key = `${label}:${root}`;
    if (this.knownRoots.has(key)) {
      return;
    }

    this.knownRoots.add(key);
    this.output.appendLine(`[stores] Using ${label}: ${root}`);
  }
}

function parseAntigravitySummaryEntries(
  encodedValue: string | undefined,
  workspacePaths: string[]
): AntigravitySummaryEntry[] {
  if (!encodedValue) {
    return [];
  }

  let decoded = '';
  try {
    decoded = Buffer.from(encodedValue, 'base64').toString('utf8');
  } catch {
    return [];
  }

  const workspaceNeedles = workspacePaths.flatMap((workspacePath) => [
    workspacePath,
    toFileUri(workspacePath),
  ]);
  const matches = [...decoded.matchAll(/\$([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)];
  const entries: AntigravitySummaryEntry[] = [];

  matches.forEach((match, index) => {
    const nextMatch = matches[index + 1];
    const start = match.index ?? 0;
    const end = nextMatch?.index ?? decoded.length;
    const chunk = decoded.slice(start, end);
    const segments = extractReadableSegments(chunk);

    if (workspaceNeedles.length > 0) {
      const belongsToWorkspace = segments.some((segment) =>
        workspaceNeedles.some((needle) => segment.includes(needle))
      );

      if (!belongsToWorkspace) {
        // Still include the entry — brain artifacts show all conversations
        // regardless of workspace, so the summaries should match.
      }
    }

    const title = pickAntigravityTitle(segments) ?? 'New chat';
    const subtitle = pickAntigravitySubtitle(segments, title);

    entries.push({
      id: match[1],
      title,
      subtitle,
      order: entries.length,
    });
  });

  if (entries.length === 0 && workspaceNeedles.length > 0) {
    return parseAntigravitySummaryEntries(encodedValue, []);
  }

  return entries;
}

function pickAntigravityTitle(segments: string[]): string | undefined {
  const candidates = segments
    .map((segment) => stripDecoration(segment))
    .filter(isPlausibleAntigravitySummaryText);

  return candidates.find((segment) => segment.length >= 4 || /\s/.test(segment))
    ?? candidates.find((segment) => segment.length >= 2);
}

function pickAntigravitySubtitle(
  segments: string[],
  title: string
): string | undefined {
  const candidates = segments
    .map((segment) => stripDecoration(segment))
    .filter((segment) => {
      return isPlausibleAntigravitySummaryText(segment) &&
        segment !== title &&
        segment.length <= 180;
    });

  return candidates.find((segment) => segment.length >= 10 || /\s/.test(segment))
    ?? candidates.find((segment) => segment.length >= 4);
}

function extractReadableSegments(chunk: string): string[] {
  const collected = new Set<string>();

  for (const printable of extractPrintableRuns(chunk)) {
    collected.add(printable);
  }

  const candidates = chunk.match(/[A-Za-z0-9+/=]{8,}/g) ?? [];
  for (const candidate of candidates) {
    try {
      const decoded = Buffer.from(candidate, 'base64').toString('utf8');
      for (const printable of extractPrintableRuns(decoded)) {
        collected.add(printable);
      }
    } catch {
      // Ignore malformed base64 fragments.
    }
  }

  return [...collected];
}

function extractPrintableRuns(value: string): string[] {
  const matches = value.match(/[ -~]{3,}/g) ?? [];
  return matches
    .map((match) => normalizeWhitespace(match))
    .filter(Boolean);
}

function parseAntigravitySelectedChatId(
  workbenchEditorRawValue: string | undefined,
  jetskiRawValue: string | undefined
): string | undefined {
  return parseAntigravitySelectedChatIdFromWorkbenchEditor(workbenchEditorRawValue)
    ?? parseAntigravitySelectedChatIdFromJetskiState(jetskiRawValue);
}

function parseAntigravitySelectedChatIdFromWorkbenchEditor(
  rawValue: string | undefined
): string | undefined {
  if (!rawValue) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawValue) as {
      'editorpart.state'?: {
        serializedGrid?: {
          root?: unknown;
        };
      };
    };

    const editors = collectWorkbenchEditors(parsed['editorpart.state']?.serializedGrid?.root);
    for (const editor of editors) {
      if (editor?.id !== 'antigravity.artifactsEditorInput' || typeof editor.value !== 'string') {
        continue;
      }

      const match = editor.value.match(/\/brain\/([0-9a-f-]{36})\//i);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Fall back to the older jetski selection state.
  }

  return undefined;
}

function collectWorkbenchEditors(root: unknown): Array<{ id?: string; value?: string }> {
  const collected: Array<{ id?: string; value?: string }> = [];
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') {
      continue;
    }

    const data = (node as any).data;
    if (Array.isArray(data)) {
      for (const child of data) {
        stack.push(child);
      }
    }

    const editors = Array.isArray(data?.editors) ? data.editors : undefined;
    if (!editors) {
      continue;
    }

    for (const editor of editors) {
      if (!editor || typeof editor !== 'object') {
        continue;
      }

      collected.push({
        id: typeof (editor as any).id === 'string' ? (editor as any).id : undefined,
        value: typeof (editor as any).value === 'string' ? (editor as any).value : undefined,
      });
    }
  }

  return collected;
}

function parseAntigravitySelectedChatIdFromJetskiState(
  rawValue: string | undefined
): string | undefined {
  if (!rawValue) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawValue) as {
      'jetskiArtifactsEditor.viewState'?: Array<[string, unknown]>;
    };

    const selected = parsed['jetskiArtifactsEditor.viewState']?.[0]?.[0];
    const match = typeof selected === 'string'
      ? selected.match(/\/brain\/([0-9a-f-]{36})\//i)
      : undefined;

    if (!match) {
      return undefined;
    }

    return match[1];
  } catch {
    return undefined;
  }
}

function extractCursorStructuredMessage(message: unknown): {
  text: string;
  toolUses: CursorTranscriptToolUse[];
} {
  if (!message || typeof message !== 'object') {
    return {
      text: '',
      toolUses: [],
    };
  }

  const content = (message as any).content;
  if (typeof content === 'string') {
    return {
      text: content,
      toolUses: [],
    };
  }

  if (!Array.isArray(content)) {
    return {
      text: '',
      toolUses: [],
    };
  }

  const textParts: string[] = [];
  const toolUses: CursorTranscriptToolUse[] = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }

    if ((part as any).type === 'text' && typeof (part as any).text === 'string') {
      textParts.push((part as any).text);
      continue;
    }

    if ((part as any).type === 'tool_use') {
      const name = typeof (part as any).name === 'string'
        ? (part as any).name
        : 'Tool';
      const input = (part as any).input;
      const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : undefined;
      toolUses.push({
        name,
        content: normalizeCursorToolInput(input),
        prompt,
      });
    }
  }

  return {
    text: textParts.filter(Boolean).join('\n'),
    toolUses,
  };
}

function normalizeCursorToolInput(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2).trim();
  } catch {
    return String(value);
  }
}

function parseEmbeddedTimestamp(value: string): number | undefined {
  const match = value.match(/<timestamp>([\s\S]*?)<\/timestamp>/i);
  if (!match?.[1]) {
    return undefined;
  }

  const normalized = match[1].replace(/\s*\(UTC[^)]*\)\s*/gi, ' ').trim();
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stripEmbeddedTimestamps(value: string): string {
  return value.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/gi, '');
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isCursorSubagentToolName(name: string): boolean {
  return normalizeComparableText(name) === 'subagent';
}

function isCursorEditorToolName(name: string): boolean {
  const normalized = normalizeComparableText(name).replace(/\s+/g, '');
  return normalized === 'applypatch'
    || normalized === 'edit'
    || normalized === 'multiedit'
    || normalized === 'writefile'
    || normalized === 'notebookedit'
    || normalized === 'rewrite';
}

function formatCursorToolUseSummary(toolUse: CursorTranscriptToolUse): string {
  if (!toolUse.content) {
    return toolUse.name;
  }

  return `${toolUse.name}\n${toolUse.content}`;
}

function normalizeUserMessage(value: string): string {
  const withoutTimestamp = stripEmbeddedTimestamps(value);
  return withoutTimestamp
    .replace(/^\s*<user_query>\s*/i, '')
    .replace(/\s*<\/user_query>\s*$/i, '')
    .trim();
}

function normalizeAssistantMessage(value: string): string {
  const normalized = stripEmbeddedTimestamps(
    value.replace(/\n?\[REDACTED\]\s*$/g, '')
  ).trim();

  return normalized === '[REDACTED]' ? '' : normalized;
}

function normalizeBrainContent(value?: string): string {
  return (value ?? '').trim();
}

function normalizeTitle(value?: string): string | undefined {
  const normalized = normalizeWhitespace(value ?? '');
  return normalized || undefined;
}

function normalizeSubtitle(value?: string): string | undefined {
  const normalized = normalizeWhitespace(value ?? '');
  return normalized || undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripDecoration(value: string): string {
  return normalizeWhitespace(value)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9)\]]+$/, '')
    .trim();
}

function snippetForTitle(value?: string): string | undefined {
  const normalized = normalizeWhitespace((value ?? '').split('\n')[0] ?? '');
  if (!normalized) {
    return undefined;
  }

  return normalized.length <= 80
    ? normalized
    : `${normalized.slice(0, 77).trimEnd()}...`;
}

function snippetForSubtitle(value?: string): string | undefined {
  const normalized = normalizeWhitespace((value ?? '').split('\n')[0] ?? '');
  if (!normalized) {
    return undefined;
  }

  return normalized.length <= 110
    ? normalized
    : `${normalized.slice(0, 107).trimEnd()}...`;
}

function workspacePathToSlug(fsPath: string): string {
  return fsPath.replace(/^\/+/, '').replace(/[\\/]+/g, '-');
}

async function findWorkspaceStorageDir(
  appName: 'Cursor' | 'Antigravity',
  workspacePaths: string[]
): Promise<string | undefined> {
  const roots = buildAppStoragePathCandidates(appName, 'User', 'workspaceStorage');

  for (const root of roots) {
    const entries = await readDirSafe(root);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const workspaceJsonPath = path.join(root, entry.name, 'workspace.json');
      const raw = await safeReadFile(workspaceJsonPath);
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
        // Ignore malformed workspace storage descriptors.
      }
    }
  }

  return undefined;
}

function buildSqliteWatchTargets(dbPath: string, label: string): WatchTarget[] {
  const basePath = path.dirname(dbPath);
  return [
    {
      basePath,
      pattern: path.basename(dbPath),
      label,
    },
    {
      basePath,
      pattern: `${path.basename(dbPath)}-wal`,
      label,
    },
    {
      basePath,
      pattern: `${path.basename(dbPath)}-journal`,
      label,
    },
  ];
}

function buildRecursiveWatchTargets(targetPath: string, label: string): WatchTarget[] {
  return [
    {
      basePath: targetPath,
      pattern: '**/*',
      label,
    },
    {
      basePath: path.dirname(targetPath),
      pattern: `${path.basename(targetPath)}/**/*`,
      label,
    },
  ];
}

function dedupeWatchTargets(targets: WatchTarget[]): WatchTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.basePath}:${target.pattern}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function quoteJson(value: unknown): string {
  return JSON.stringify(value);
}

function fingerprintCollection(collection: ConversationCollection): string {
  return quoteJson({
    selectedChatId: collection.selectedChatId,
    chats: collection.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      subtitle: chat.subtitle,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      sourceId: chat.sourceId,
      sourceLabel: chat.sourceLabel,
      model: chat.model,
      modelConfidence: chat.modelConfidence,
      contextUsagePercent: chat.contextUsagePercent,
      turns: chat.turns.map((turn) => ({
        id: turn.id,
        requestType: turn.requestType,
        createdAt: turn.createdAt,
        updatedAt: turn.updatedAt,
        isComplete: turn.isComplete,
        userInput: turn.blocks['user-input'],
        thinking: turn.blocks['agent-thinking'],
        subagent: turn.blocks['agent-subagent'],
        editor: turn.blocks['agent-editor'],
        output: turn.blocks['agent-output'],
        capturedTokenUsage: turn.capturedTokenUsage,
        childTurns: turn.childTurns?.map((childTurn) => ({
          id: childTurn.id,
          requestType: childTurn.requestType,
          createdAt: childTurn.createdAt,
          updatedAt: childTurn.updatedAt,
          isComplete: childTurn.isComplete,
          userInput: childTurn.blocks['user-input'],
          thinking: childTurn.blocks['agent-thinking'],
          subagent: childTurn.blocks['agent-subagent'],
          editor: childTurn.blocks['agent-editor'],
          output: childTurn.blocks['agent-output'],
          capturedTokenUsage: childTurn.capturedTokenUsage,
        })),
      })),
    })),
  });
}

async function loadAntigravityArtifacts(dirPath: string): Promise<AntigravityArtifact[]> {
  const entries = await readDirSafe(dirPath);
  const groups = new Map<string, { contentPaths: string[]; metadataPath?: string }>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name.endsWith('.metadata.json')) {
      const baseName = entry.name.slice(0, -'.metadata.json'.length);
      if (!isAntigravityTextBaseName(baseName)) {
        continue;
      }

      const existing = groups.get(baseName) ?? { contentPaths: [] };
      existing.metadataPath = path.join(dirPath, entry.name);
      groups.set(baseName, existing);
      continue;
    }

    if (!isAntigravityTextArtifactFile(entry.name)) {
      continue;
    }

    const baseName = toAntigravityArtifactBaseName(entry.name);
    const existing = groups.get(baseName) ?? { contentPaths: [] };
    existing.contentPaths.push(path.join(dirPath, entry.name));
    groups.set(baseName, existing);
  }

  const loadedArtifacts = await Promise.all(
    [...groups.entries()].map(async ([baseName, group]) => {
      if (group.contentPaths.length === 0) {
        return undefined;
      }

      const contentCandidates = await Promise.all(
        group.contentPaths.map(async (filePath) => ({
          filePath,
          fileName: path.basename(filePath),
          stats: await safeStat(filePath),
        }))
      );
      const metadata = await loadAntigravityArtifactMetadata(group.metadataPath);
      const currentRevision = resolveCurrentAntigravityArtifactRevision(contentCandidates, metadata);
      const currentCandidates = contentCandidates
        .filter((candidate) =>
          resolveAntigravityArtifactRevision(candidate.fileName, metadata, currentRevision) === currentRevision
        )
        .sort((left, right) => {
          const mtimeDiff = (right.stats?.mtimeMs ?? 0) - (left.stats?.mtimeMs ?? 0);
          if (mtimeDiff !== 0) {
            return mtimeDiff;
          }

          return antigravityResolvedVariantPriority(right.fileName) - antigravityResolvedVariantPriority(left.fileName);
        });
      const currentCandidate = currentCandidates[0];
      if (!currentCandidate) {
        return undefined;
      }

      const content = await safeReadFile(currentCandidate.filePath);
      const normalizedContent = normalizeBrainContent(content);
      if (!normalizedContent && !normalizeSubtitle(metadata?.summary ?? '')) {
        return undefined;
      }

      const metadataUpdatedAt = metadata?.updatedAt ? Date.parse(metadata.updatedAt) : NaN;
      const updatedAt = Math.max(
        currentCandidate.stats?.mtimeMs ?? 0,
        Number.isFinite(metadataUpdatedAt) ? metadataUpdatedAt : 0
      );
      const createdAt = currentCandidate.stats?.birthtimeMs ?? currentCandidate.stats?.mtimeMs ?? updatedAt;

      const artifact: AntigravityArtifact = {
        baseName,
        content: normalizedContent,
        kind: classifyAntigravityArtifact(baseName, metadata),
        summary: normalizeSubtitle(metadata?.summary),
        updatedAt,
        createdAt,
        revision: currentRevision,
        isCurrentRevision: true,
      };

      return artifact;
    })
  );

  return loadedArtifacts
    .filter((artifact): artifact is AntigravityArtifact => Boolean(artifact))
    .sort(compareAntigravityArtifactsChronologically);
}

async function loadAntigravityArtifactMetadata(
  filePath?: string
): Promise<AntigravityArtifactMetadata | undefined> {
  if (!filePath) {
    return undefined;
  }

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as AntigravityArtifactMetadata;
    return parsed;
  } catch {
    return undefined;
  }
}

function pickAntigravityArtifact(
  artifacts: AntigravityArtifact[],
  kind: BlockType
): AntigravityArtifact | undefined {
  const candidates = artifacts.filter((artifact) => artifact.kind === kind);
  candidates.sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }

    return antigravityArtifactPriority(kind, right.baseName) - antigravityArtifactPriority(kind, left.baseName);
  });
  return candidates[0];
}

function antigravityArtifactPriority(kind: BlockType, baseName: string): number {
  const value = baseName.toLowerCase();

  if (kind === 'user-input') {
    if (value === 'task.md') {
      return 100;
    }
    return 10;
  }

  if (kind === 'agent-thinking') {
    if (value === 'implementation_plan_retry.md') {
      return 100;
    }
    if (value === 'implementation_plan.md') {
      return 90;
    }
    return value.includes('plan') ? 50 : 10;
  }

  if (value === 'final_walkthrough.md') {
    return 100;
  }
  if (value === 'final_testing_walkthrough.md') {
    return 95;
  }
  if (value === 'walkthrough.md') {
    return 90;
  }
  if (value.includes('final')) {
    return 80;
  }
  if (value.includes('walkthrough') || value.includes('guide') || value.includes('report')) {
    return 70;
  }

  return 10;
}

function classifyAntigravityArtifact(
  baseName: string,
  metadata?: AntigravityArtifactMetadata
): BlockType {
  const artifactType = (metadata?.artifactType ?? '').toUpperCase();
  const value = baseName.toLowerCase();

  if (artifactType === 'ARTIFACT_TYPE_TASK' || value === 'task.md') {
    return 'user-input';
  }

  if (
    artifactType === 'ARTIFACT_TYPE_IMPLEMENTATION_PLAN'
    || value === 'implementation_plan.md'
    || value === 'implementation_plan_retry.md'
  ) {
    return 'agent-thinking';
  }

  return 'agent-output';
}

function isAntigravityArtifactStreaming(artifact?: AntigravityArtifact): boolean {
  return Boolean(artifact?.content)
    && Boolean(artifact?.isCurrentRevision)
    && Date.now() - (artifact?.updatedAt ?? 0) < STREAMING_GRACE_MS;
}

function extractAntigravityTitle(value?: string): string | undefined {
  const lines = (value ?? '').split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  if (heading) {
    return normalizeTitle(heading.replace(/^#\s+/, ''));
  }

  return snippetForTitle(value);
}

function isAntigravityTextArtifactFile(fileName: string): boolean {
  return /\.(md|txt)(?:\.resolved(?:\.\d+)?)?$/i.test(fileName);
}

function isAntigravityTextBaseName(fileName: string): boolean {
  return /\.(md|txt)$/i.test(fileName);
}

function toAntigravityArtifactBaseName(fileName: string): string {
  return fileName.replace(/\.resolved(?:\.\d+)?$/i, '');
}

function compareAntigravityArtifactsChronologically(
  left: AntigravityArtifact,
  right: AntigravityArtifact
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }

  if (left.revision !== right.revision) {
    return left.revision - right.revision;
  }

  return left.baseName.localeCompare(right.baseName);
}

function resolveCurrentAntigravityArtifactRevision(
  candidates: Array<{ fileName: string }>,
  metadata?: AntigravityArtifactMetadata
): number {
  const explicitMetadataVersion = parseAntigravityArtifactVersion(metadata?.version);
  if (explicitMetadataVersion !== undefined) {
    return explicitMetadataVersion;
  }

  const explicitRevisions = candidates
    .map((candidate) => extractAntigravityResolvedRevision(candidate.fileName))
    .filter((value): value is number => value !== undefined);

  return explicitRevisions.length > 0 ? Math.max(...explicitRevisions) : 0;
}

function resolveAntigravityArtifactRevision(
  fileName: string,
  metadata: AntigravityArtifactMetadata | undefined,
  currentRevision: number
): number {
  const explicitRevision = extractAntigravityResolvedRevision(fileName);
  if (explicitRevision !== undefined) {
    return explicitRevision;
  }

  return parseAntigravityArtifactVersion(metadata?.version) ?? currentRevision;
}

function parseAntigravityArtifactVersion(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  return Number.parseInt(value, 10);
}

function extractAntigravityResolvedRevision(fileName: string): number | undefined {
  const match = fileName.match(/\.resolved\.(\d+)$/i);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}

function antigravityResolvedVariantPriority(fileName: string): number {
  if (/\.resolved\.\d+$/i.test(fileName)) {
    return 3;
  }

  if (/\.resolved$/i.test(fileName)) {
    return 2;
  }

  return 1;
}

async function pickArtifactFile(dirPath: string, preferredBaseNames: string[]): Promise<string | undefined> {
  const entries = await readDirSafe(dirPath);

  for (const baseName of preferredBaseNames) {
    const exact = entries.find((entry) => entry.isFile() && entry.name === baseName);
    if (exact) {
      return path.join(dirPath, exact.name);
    }

    const variants = entries.filter((entry) =>
      entry.isFile() &&
      entry.name.startsWith(`${baseName}.resolved`) &&
      !entry.name.endsWith('.metadata.json')
    );

    if (variants.length === 0) {
      continue;
    }

    const variantWithStats = await Promise.all(
      variants.map(async (entry) => ({
        filePath: path.join(dirPath, entry.name),
        stats: await safeStat(path.join(dirPath, entry.name)),
      }))
    );

    variantWithStats.sort((left, right) => {
      return (right.stats?.mtimeMs ?? 0) - (left.stats?.mtimeMs ?? 0);
    });

    if (variantWithStats[0]) {
      return variantWithStats[0].filePath;
    }
  }

  return undefined;
}

function toFileUri(fsPath: string): string {
  const uri = vscode.Uri.file(fsPath);
  return uri.toString();
}

function fileUriToFsPath(value: string): string {
  if (!value.startsWith('file://')) {
    return value;
  }

  try {
    return vscode.Uri.parse(value).fsPath;
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

function looksLikeFileUri(value: string): boolean {
  return /^file:\/\//i.test(value) || value.includes('/Users/');
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function looksLikeInternalMarker(value: string): boolean {
  return value.startsWith('ARTIFACT_TYPE_')
    || value.startsWith('MESSAGE_PRIORITY_')
    || value.includes('.metadata.json')
    || value.includes('.resolved');
}

function looksLikeEncodedBlob(value: string): boolean {
  return /^[A-Za-z0-9+/=]+$/.test(value) && !value.includes(' ') && value.length > 12;
}

function isPlausibleAntigravitySummaryText(value: string): boolean {
  if (!value || value.length > 160) {
    return false;
  }

  if (
    !/[A-Za-z]/.test(value)
    || looksLikeFileUri(value)
    || looksLikeUuid(value)
    || looksLikeInternalMarker(value)
    || looksLikeEncodedBlob(value)
    || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(value)
  ) {
    return false;
  }

  const letterCount = (value.match(/[A-Za-z]/g) ?? []).length;
  const visibleCount = (value.match(/[A-Za-z0-9]/g) ?? []).length;
  const punctuationCount = (value.match(/[^A-Za-z0-9\s]/g) ?? []).length;

  if (letterCount < 3 || visibleCount === 0) {
    return false;
  }

  return punctuationCount <= Math.ceil(value.length * 0.2);
}

function resolveAntigravityActiveChatId(
  chats: ConversationChat[],
  preferredChatId: string | undefined,
  summaries: ReadonlyMap<string, AntigravitySummaryEntry>
): string | undefined {
  if (chats.length === 0) {
    return preferredChatId;
  }

  const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
  const preferredChat = preferredChatId
    ? chatsById.get(preferredChatId)
    : undefined;
  const freshestChat = [...chats]
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const freshestPromptChat = chats
    .filter((chat) => chat.turns.some((turn) => Boolean(turn.blocks['user-input'].content.trim())))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const freshestRecentChat = freshestPromptChat ?? freshestChat;

  if (
    preferredChat
    && (
      !freshestRecentChat
      || preferredChat.id === freshestRecentChat.id
      || preferredChat.updatedAt >= freshestRecentChat.updatedAt - 2_000
    )
  ) {
    return preferredChat.id;
  }

  if (
    freshestRecentChat
    && Date.now() - freshestRecentChat.updatedAt < 12 * 60 * 60 * 1000
  ) {
    return freshestRecentChat.id;
  }

  const summaryBackedChats = chats.filter((chat) => summaries.has(chat.id));
  const freshestSummaryBackedChat = summaryBackedChats[0];
  const freshNewChat = chats.find((chat) =>
    chat.turns.length === 0
    && Date.now() - chat.updatedAt < 2 * 60 * 60 * 1000
  );
  if (freshNewChat) {
    if (!freshestSummaryBackedChat || freshNewChat.updatedAt >= freshestSummaryBackedChat.updatedAt) {
      return freshNewChat.id;
    }
  }

  if (freshestSummaryBackedChat) {
    return freshestSummaryBackedChat.id;
  }

  return chats[0]?.id;
}

async function getLiveAntigravityUserStatus(): Promise<string | undefined> {
  try {
    const api = (vscode as typeof vscode & {
      antigravityUnifiedStateSync?: {
        UserStatus?: {
          getUserStatus?: () => Promise<string | undefined>;
        };
      };
    }).antigravityUnifiedStateSync;

    return await api?.UserStatus?.getUserStatus?.();
  } catch {
    return undefined;
  }
}

async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function readDirSafe(dirPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(targetPath: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(targetPath);
  } catch {
    return undefined;
  }
}

async function latestSqliteWriteMs(dbPath: string): Promise<number> {
  const [dbStats, walStats] = await Promise.all([
    safeStat(dbPath),
    safeStat(`${dbPath}-wal`),
  ]);

  return Math.max(
    dbStats?.mtimeMs ?? 0,
    walStats?.mtimeMs ?? 0
  );
}
