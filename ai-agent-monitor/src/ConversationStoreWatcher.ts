import { execFile } from 'child_process';
import type { Dirent, Stats } from 'fs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
  BlockType,
  ConversationChat,
  ConversationCollection,
  ConversationSegment,
  ConversationTurn,
  HostApp,
} from './types';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 400;
const STREAMING_GRACE_MS = 2500;
const RECENT_LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000;
const MAX_CURSOR_TRANSCRIPTS = 240;
const MAX_ANTIGRAVITY_CHATS = 240;
const ANTIGRAVITY_NEW_CHAT_GRACE_MS = 35 * 24 * 60 * 60 * 1000;

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
  selectedComposerIds: string[];
  lastFocusedComposerIds: string[];
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
}

interface AntigravityArtifact {
  baseName: string;
  content: string;
  kind: BlockType;
  summary?: string;
  updatedAt: number;
  createdAt: number;
}

export class ConversationStoreWatcher implements vscode.Disposable {
  private readonly callbacks: StoreWatcherCallbacks;
  private readonly output: vscode.OutputChannel;
  private readonly hostApp: HostApp;
  private readonly knownRoots = new Set<string>();
  private timer?: NodeJS.Timeout;
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
    if (this.timer) {
      return;
    }

    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  resetBaseline(): void {
    void this.captureBaseline();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
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
    if (workspacePaths.length === 0) {
      return { chats: [] };
    }

    const globalDbPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Antigravity',
      'User',
      'globalStorage',
      'state.vscdb'
    );
    const workspaceStorageDir = await findWorkspaceStorageDir('Antigravity', workspacePaths);
    const workspaceDbPath = workspaceStorageDir
      ? path.join(workspaceStorageDir, 'state.vscdb')
      : undefined;

    if (workspaceDbPath) {
      this.logDiscoveredRoot(workspaceDbPath, 'Antigravity workspace state');
    }
    this.logDiscoveredRoot(globalDbPath, 'Antigravity global state');

    const globalValuesPromise = readSqliteKeyMap(
      globalDbPath,
      ['antigravityUnifiedStateSync.trajectorySummaries']
    );
    const workspaceValuesPromise: Promise<Record<string, string>> = workspaceDbPath
      ? readSqliteKeyMap(workspaceDbPath, ['memento/antigravity.jetskiArtifactsEditor'])
      : Promise.resolve({});

    const [globalValues, workspaceValues] = await Promise.all([
      globalValuesPromise,
      workspaceValuesPromise,
    ]);

    const summaryEntries = parseAntigravitySummaryEntries(
      globalValues['antigravityUnifiedStateSync.trajectorySummaries'],
      workspacePaths
    );
    const summaries = new Map(summaryEntries.map((summary) => [summary.id, summary]));
    const brainRoot = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    const chats = await this.collectAntigravityBrainChats(brainRoot, summaries);

    if (chats.length === 0 && summaryEntries.length > 0) {
      const fallbackChats = await Promise.all(
        summaryEntries.map(async (summary, index) => this.parseAntigravitySummaryChat(summary, index))
      );
      return {
        chats: fallbackChats,
        selectedChatId: parseAntigravitySelectedChatId(
          workspaceValues['memento/antigravity.jetskiArtifactsEditor'],
          summaryEntries
        ) ?? fallbackChats[0]?.id,
      };
    }

    const selectedChatId = parseAntigravitySelectedChatId(
      workspaceValues['memento/antigravity.jetskiArtifactsEditor'],
      summaryEntries
    );

    return {
      chats,
      selectedChatId: selectedChatId ?? chats[0]?.id,
    };
  }

  private async readCursorComposerHeaders(workspacePaths: string[]): Promise<Map<string, CursorComposerHeader>> {
    const dbPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb'
    );

    this.logDiscoveredRoot(dbPath, 'Cursor global state');

    const values = await readSqliteKeyMap(dbPath, ['composer.composerHeaders']);
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
        selectedComposerIds: [],
        lastFocusedComposerIds: [],
      };
    }

    const dbPath = path.join(workspaceStorageDir, 'state.vscdb');
    this.logDiscoveredRoot(dbPath, 'Cursor workspace state');

    const values = await readSqliteKeyMap(dbPath, ['composer.composerData']);
    const raw = values['composer.composerData'];
    if (!raw) {
      return {
        selectedComposerIds: [],
        lastFocusedComposerIds: [],
      };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<CursorComposerState>;
      return {
        selectedComposerIds: Array.isArray(parsed.selectedComposerIds) ? parsed.selectedComposerIds : [],
        lastFocusedComposerIds: Array.isArray(parsed.lastFocusedComposerIds) ? parsed.lastFocusedComposerIds : [],
      };
    } catch (error) {
      this.output.appendLine(`[stores] Failed to parse Cursor composer state: ${formatError(error)}`);
      return {
        selectedComposerIds: [],
        lastFocusedComposerIds: [],
      };
    }
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

    const entries: Array<{ role: string; text: string }> = [];
    for (const line of (raw ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed);
        const role = typeof parsed?.role === 'string' ? parsed.role : '';
        const text = extractStructuredMessageText(parsed?.message);
        if (role && text) {
          entries.push({ role, text });
        }
      } catch {
        // Ignore incomplete trailing lines while the host is still writing.
      }
    }

    const turns: ConversationTurn[] = [];
    let currentTurn: { userInput: string; assistantMessages: string[] } | undefined;

    for (const entry of entries) {
      if (entry.role === 'user') {
        currentTurn = {
          userInput: normalizeUserMessage(entry.text),
          assistantMessages: [],
        };
        turns.push(
          this.createTurnFromMessages(
            `${composerId}:turn:${turns.length + 1}`,
            currentTurn.userInput,
            [],
            createdAt + turns.length,
            updatedAt + turns.length,
            false
          )
        );
        continue;
      }

      if (entry.role !== 'assistant' || !currentTurn || turns.length === 0) {
        continue;
      }

      const assistantText = normalizeAssistantMessage(entry.text);
      if (!assistantText) {
        continue;
      }

      currentTurn.assistantMessages.push(assistantText);
      const latestTurn = turns[turns.length - 1];
      const reconstructed = this.createTurnFromMessages(
        latestTurn.id,
        currentTurn.userInput,
        currentTurn.assistantMessages,
        latestTurn.createdAt,
        updatedAt + turns.length,
        Date.now() - updatedAt < STREAMING_GRACE_MS
      );
      turns[turns.length - 1] = reconstructed;
    }

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
    summaries: ReadonlyMap<string, AntigravitySummaryEntry>
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
    const userArtifact = pickAntigravityArtifact(artifacts, 'user-input');
    const thinkingArtifact = pickAntigravityArtifact(artifacts, 'agent-thinking');
    const outputArtifact = pickAntigravityArtifact(artifacts, 'agent-output');

    const userInput = normalizeBrainContent(userArtifact?.content);
    const thinking = normalizeBrainContent(thinkingArtifact?.content);
    const output = normalizeBrainContent(outputArtifact?.content);

    const artifactTimestamps = artifacts.map((artifact) => artifact.updatedAt);
    const updatedAt = Math.max(
      directoryStats?.mtimeMs ?? 0,
      ...artifactTimestamps,
      Date.now() - index
    );
    const createdAtCandidates = [
      directoryStats?.birthtimeMs,
      directoryStats?.mtimeMs,
      ...artifacts.map((artifact) => artifact.createdAt),
    ].filter((value): value is number => typeof value === 'number');
    const createdAt = createdAtCandidates.length > 0 ? Math.min(...createdAtCandidates) : updatedAt;

    if (!userInput && !thinking && !output) {
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

    const turn = this.createTurn(
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
        'agent-output': {
          content: output,
          isStreaming: isAntigravityArtifactStreaming(outputArtifact),
        },
      },
      createdAt,
      updatedAt
    );

    const title = normalizeTitle(summary.title)
      || extractAntigravityTitle(userInput)
      || extractAntigravityTitle(output)
      || artifacts.map((artifact) => artifact.summary).find((value): value is string => Boolean(normalizeTitle(value)))
      || 'Untitled chat';
    const subtitle = normalizeSubtitle(summary.subtitle)
      || artifacts.map((artifact) => normalizeSubtitle(artifact.summary)).find((value): value is string => Boolean(value))
      || snippetForSubtitle(output)
      || snippetForSubtitle(thinking)
      || snippetForSubtitle(userInput);

    return {
      id: summary.id,
      title,
      subtitle,
      createdAt: createdAt - index,
      updatedAt: updatedAt - index,
      turns: [turn],
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
    };
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
    const isComplete = Boolean(blocks['agent-output'].content);

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

    const belongsToWorkspace = segments.some((segment) =>
      workspaceNeedles.some((needle) => segment.includes(needle))
    );

    if (!belongsToWorkspace) {
      return;
    }

    const title = pickAntigravityTitle(segments) ?? `Chat ${entries.length + 1}`;
    const subtitle = pickAntigravitySubtitle(segments, title);

    entries.push({
      id: match[1],
      title,
      subtitle,
      order: entries.length,
    });
  });

  return entries;
}

function pickAntigravityTitle(segments: string[]): string | undefined {
  const candidates = segments
    .map((segment) => stripDecoration(segment))
    .filter((segment) => {
      return Boolean(segment) &&
        segment.length <= 160 &&
        /[A-Za-z]/.test(segment) &&
        !looksLikeFileUri(segment) &&
        !looksLikeUuid(segment) &&
        !looksLikeInternalMarker(segment) &&
        !looksLikeEncodedBlob(segment);
    });

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
      return Boolean(segment) &&
        segment !== title &&
        segment.length <= 180 &&
        /[A-Za-z]/.test(segment) &&
        !looksLikeFileUri(segment) &&
        !looksLikeUuid(segment) &&
        !looksLikeInternalMarker(segment) &&
        !looksLikeEncodedBlob(segment);
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
  rawValue: string | undefined,
  summaries: AntigravitySummaryEntry[]
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

    return summaries.some((summary) => summary.id === match[1]) ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

function extractStructuredMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const content = (message as any).content;
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      if ((part as any).type === 'text' && typeof (part as any).text === 'string') {
        return (part as any).text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeUserMessage(value: string): string {
  return value
    .replace(/^\s*<user_query>\s*/i, '')
    .replace(/\s*<\/user_query>\s*$/i, '')
    .trim();
}

function normalizeAssistantMessage(value: string): string {
  const normalized = value
    .replace(/\n?\[REDACTED\]\s*$/g, '')
    .trim();

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
  const root = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    appName,
    'User',
    'workspaceStorage'
  );

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

  return undefined;
}

async function readSqliteKeyMap(
  dbPath: string,
  keys: string[]
): Promise<Record<string, string>> {
  if (keys.length === 0) {
    return {};
  }

  for (const candidatePath of [dbPath, `${dbPath}.backup`]) {
    if (!(await pathExists(candidatePath))) {
      continue;
    }

    const result = await querySqliteKeyMap(candidatePath, keys);
    if (Object.keys(result).length > 0) {
      return result;
    }
  }

  return {};
}

async function querySqliteKeyMap(
  sourceDbPath: string,
  keys: string[]
): Promise<Record<string, string>> {
  const tempDbPath = path.join(
    os.tmpdir(),
    `ai-agent-monitor-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );

  try {
    await fs.copyFile(sourceDbPath, tempDbPath);
    const sql = `SELECT key, value FROM ItemTable WHERE key IN (${keys.map(quoteSqliteString).join(', ')})`;
    const { stdout } = await execFileAsync('sqlite3', ['-json', tempDbPath, sql], {
      maxBuffer: 8 * 1024 * 1024,
    });

    const rows = JSON.parse(stdout || '[]') as Array<{ key: string; value: string }>;
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }

    return map;
  } catch {
    return {};
  } finally {
    await fs.rm(tempDbPath, { force: true }).catch(() => undefined);
  }
}

function quoteSqliteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
        createdAt: turn.createdAt,
        updatedAt: turn.updatedAt,
        isComplete: turn.isComplete,
        userInput: turn.blocks['user-input'],
        thinking: turn.blocks['agent-thinking'],
        output: turn.blocks['agent-output'],
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
          stats: await safeStat(filePath),
        }))
      );
      contentCandidates.sort((left, right) => (right.stats?.mtimeMs ?? 0) - (left.stats?.mtimeMs ?? 0));

      const latest = contentCandidates[0];
      if (!latest) {
        return undefined;
      }

      const [content, metadata] = await Promise.all([
        safeReadFile(latest.filePath),
        loadAntigravityArtifactMetadata(group.metadataPath),
      ]);

      const normalizedContent = normalizeBrainContent(content);
      if (!normalizedContent && !normalizeSubtitle(metadata?.summary ?? '')) {
        return undefined;
      }

      const metadataUpdatedAt = metadata?.updatedAt ? Date.parse(metadata.updatedAt) : NaN;
      const updatedAt = Math.max(
        latest.stats?.mtimeMs ?? 0,
        Number.isFinite(metadataUpdatedAt) ? metadataUpdatedAt : 0
      );
      const createdAt = latest.stats?.birthtimeMs ?? latest.stats?.mtimeMs ?? updatedAt;

      const artifact: AntigravityArtifact = {
        baseName,
        content: normalizedContent,
        kind: classifyAntigravityArtifact(baseName, metadata),
        summary: normalizeSubtitle(metadata?.summary),
        updatedAt,
        createdAt,
      };

      return artifact;
    })
  );

  return loadedArtifacts
    .filter((artifact): artifact is AntigravityArtifact => Boolean(artifact))
    .sort((left, right) => right.updatedAt - left.updatedAt);
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
    const priorityDiff = antigravityArtifactPriority(kind, right.baseName) - antigravityArtifactPriority(kind, left.baseName);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return right.updatedAt - left.updatedAt;
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
  return Boolean(artifact?.content) && Date.now() - (artifact?.updatedAt ?? 0) < STREAMING_GRACE_MS;
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
