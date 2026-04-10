import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConversationTurn } from './types';

const POLL_INTERVAL_MS = 900;
const STREAMING_GRACE_MS = 2500;
const RECENT_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const MAX_CURSOR_TRANSCRIPTS = 12;
const MAX_ANTIGRAVITY_BRAIN_DIRS = 12;

interface StoreWatcherCallbacks {
  onTurnCaptured(turn: ConversationTurn): void;
}

interface ParsedTurnState {
  turn: ConversationTurn;
  fingerprint: string;
}

export class ConversationStoreWatcher implements vscode.Disposable {
  private readonly knownFingerprints = new Map<string, string>();
  private readonly knownRoots = new Set<string>();
  private readonly callbacks: StoreWatcherCallbacks;
  private readonly output: vscode.OutputChannel;
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private resettingBaseline = false;

  constructor(
    callbacks: StoreWatcherCallbacks,
    output: vscode.OutputChannel
  ) {
    this.callbacks = callbacks;
    this.output = output;
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
      const turns = await this.collectParsedTurns();
      this.knownFingerprints.clear();
      for (const state of turns) {
        this.knownFingerprints.set(state.turn.id, state.fingerprint);
      }
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
      const turns = await this.collectParsedTurns();

      for (const state of turns) {
        const previousFingerprint = this.knownFingerprints.get(state.turn.id);
        if (previousFingerprint === state.fingerprint) {
          continue;
        }

        this.knownFingerprints.set(state.turn.id, state.fingerprint);
        this.callbacks.onTurnCaptured(state.turn);
      }
    } catch (error) {
      this.output.appendLine(`[stores] Refresh failed: ${formatError(error)}`);
    }
  }

  private async collectParsedTurns(): Promise<ParsedTurnState[]> {
    const turns: ParsedTurnState[] = [];

    await this.collectCursorTranscriptTurns(turns, '.cursor', 'Cursor');
    await this.collectCursorTranscriptTurns(turns, '.antigravity', 'Antigravity');
    await this.collectAntigravityBrainTurns(turns);

    turns.sort((left, right) => {
      if (left.turn.createdAt !== right.turn.createdAt) {
        return left.turn.createdAt - right.turn.createdAt;
      }

      return left.turn.id.localeCompare(right.turn.id);
    });

    return turns;
  }

  private async collectCursorTranscriptTurns(
    target: ParsedTurnState[],
    appDir: string,
    sourceLabel: string
  ): Promise<void> {
    for (const transcriptRoot of this.getWorkspaceTranscriptRoots(appDir)) {
      if (!(await pathExists(transcriptRoot))) {
        continue;
      }

      this.logDiscoveredRoot(transcriptRoot, `${sourceLabel} transcripts`);

      const transcriptFiles = await this.listTranscriptFiles(transcriptRoot);
      for (const transcriptFile of transcriptFiles) {
        const parsedTurns = await this.parseCursorTranscriptFile(transcriptFile, sourceLabel);
        target.push(...parsedTurns);
      }
    }
  }

  private async collectAntigravityBrainTurns(target: ParsedTurnState[]): Promise<void> {
    const root = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    if (!(await pathExists(root))) {
      return;
    }

    this.logDiscoveredRoot(root, 'Antigravity brain artifacts');

    const dirEntries = await readDirSafe(root);
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const dirPath = path.join(root, entry.name);
      const parsedTurn = await this.parseAntigravityBrainDirectory(dirPath);
      if (parsedTurn) {
        target.push(parsedTurn);
      }
    }
  }

  private getWorkspaceTranscriptRoots(appDir: string): string[] {
    const roots = new Set<string>();
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of folders) {
      const slug = workspacePathToSlug(folder.uri.fsPath);
      if (!slug) {
        continue;
      }

      roots.add(path.join(os.homedir(), appDir, 'projects', slug, 'agent-transcripts'));
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

        if (stats.mtimeMs < this.startedAt - RECENT_LOOKBACK_MS) {
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

  private async parseCursorTranscriptFile(
    filePath: string,
    sourceLabel: string
  ): Promise<ParsedTurnState[]> {
    const stats = await safeStat(filePath);
    const raw = await safeReadFile(filePath);
    if (!stats || raw === undefined) {
      return [];
    }

    const entries: Array<{ role: string; text: string }> = [];
    for (const line of raw.split(/\r?\n/)) {
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

    const turns: Array<{ userInput: string; assistantMessages: string[] }> = [];
    let currentTurn: { userInput: string; assistantMessages: string[] } | undefined;

    for (const entry of entries) {
      if (entry.role === 'user') {
        currentTurn = {
          userInput: normalizeUserMessage(entry.text),
          assistantMessages: [],
        };
        turns.push(currentTurn);
        continue;
      }

      if (entry.role !== 'assistant' || !currentTurn) {
        continue;
      }

      const assistantText = normalizeAssistantMessage(entry.text);
      if (assistantText) {
        currentTurn.assistantMessages.push(assistantText);
      }
    }

    const conversationId = path.basename(path.dirname(filePath));
    const recentlyUpdated = Date.now() - stats.mtimeMs < STREAMING_GRACE_MS;

    return turns
      .filter((turn) => turn.userInput || turn.assistantMessages.length > 0)
      .map((turn, index, allTurns) => {
        const thinkingMessages = turn.assistantMessages.length > 1
          ? turn.assistantMessages.slice(0, -1)
          : [];
        const output = turn.assistantMessages.length > 0
          ? turn.assistantMessages[turn.assistantMessages.length - 1]
          : '';
        const thinking = thinkingMessages.join('\n\n');
        const isLatestTurn = index === allTurns.length - 1;
        const outputStreaming = isLatestTurn && recentlyUpdated && Boolean(output);
        const thinkingStreaming = isLatestTurn && recentlyUpdated && !output && Boolean(thinking);

        const parsedTurn: ConversationTurn = {
          id: `store:${sourceLabel.toLowerCase()}:transcript:${conversationId}:${index + 1}`,
          source: sourceLabel,
          createdAt: Math.floor((stats.birthtimeMs || stats.mtimeMs) + index),
          updatedAt: Math.floor(stats.mtimeMs + index),
          isComplete: Boolean(output),
          blocks: {
            'user-input': {
              content: turn.userInput,
              isStreaming: false,
            },
            'agent-thinking': {
              content: thinking,
              isStreaming: thinkingStreaming,
            },
            'agent-output': {
              content: output,
              isStreaming: outputStreaming,
            },
          },
        };

        return {
          turn: parsedTurn,
          fingerprint: fingerprintTurn(parsedTurn),
        };
      });
  }

  private async parseAntigravityBrainDirectory(dirPath: string): Promise<ParsedTurnState | undefined> {
    const taskFile = await pickArtifactFile(dirPath, ['task.md']);
    const thinkingFile = await pickArtifactFile(dirPath, ['implementation_plan_retry.md', 'implementation_plan.md']);
    const outputFile = await pickArtifactFile(dirPath, [
      'final_walkthrough.md',
      'final_testing_walkthrough.md',
      'testing_guide.md',
      'feature_audit_report.md',
      'walkthrough.md',
    ]);

    if (!taskFile && !thinkingFile && !outputFile) {
      return undefined;
    }

    const [taskContent, thinkingContent, outputContent, taskStats, thinkingStats, outputStats] = await Promise.all([
      taskFile ? safeReadFile(taskFile) : Promise.resolve(undefined),
      thinkingFile ? safeReadFile(thinkingFile) : Promise.resolve(undefined),
      outputFile ? safeReadFile(outputFile) : Promise.resolve(undefined),
      taskFile ? safeStat(taskFile) : Promise.resolve(undefined),
      thinkingFile ? safeStat(thinkingFile) : Promise.resolve(undefined),
      outputFile ? safeStat(outputFile) : Promise.resolve(undefined),
    ]);

    const userInput = normalizeBrainContent(taskContent);
    const thinking = normalizeBrainContent(thinkingContent);
    const output = normalizeBrainContent(outputContent);

    if (!userInput && !thinking && !output) {
      return undefined;
    }

    const timestamps = [taskStats?.mtimeMs, thinkingStats?.mtimeMs, outputStats?.mtimeMs]
      .filter((value): value is number => typeof value === 'number');
    const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
    if (updatedAt < this.startedAt - RECENT_LOOKBACK_MS) {
      return undefined;
    }

    const createdAt = [taskStats?.birthtimeMs, taskStats?.mtimeMs, updatedAt]
      .filter((value): value is number => typeof value === 'number')[0] ?? updatedAt;
    const recentlyUpdated = Date.now() - updatedAt < STREAMING_GRACE_MS;
    const turn: ConversationTurn = {
      id: `store:antigravity:brain:${path.basename(dirPath)}`,
      source: 'Antigravity',
      createdAt: Math.floor(createdAt),
      updatedAt: Math.floor(updatedAt),
      isComplete: Boolean(output),
      blocks: {
        'user-input': {
          content: userInput,
          isStreaming: false,
        },
        'agent-thinking': {
          content: thinking,
          isStreaming: recentlyUpdated && !output && Boolean(thinking),
        },
        'agent-output': {
          content: output,
          isStreaming: recentlyUpdated && Boolean(output),
        },
      },
    };

    return {
      turn,
      fingerprint: fingerprintTurn(turn),
    };
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

function workspacePathToSlug(fsPath: string): string {
  return fsPath.replace(/^\/+/, '').replace(/[\\/]+/g, '-');
}

function fingerprintTurn(turn: ConversationTurn): string {
  return JSON.stringify({
    updatedAt: turn.updatedAt,
    isComplete: turn.isComplete,
    source: turn.source,
    userInput: turn.blocks['user-input'],
    thinking: turn.blocks['agent-thinking'],
    output: turn.blocks['agent-output'],
  });
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

async function readDirSafe(dirPath: string): Promise<import('fs').Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(targetPath: string): Promise<import('fs').Stats | undefined> {
  try {
    return await fs.stat(targetPath);
  } catch {
    return undefined;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
