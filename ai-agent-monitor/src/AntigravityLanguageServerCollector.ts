import * as http2 from 'http2';
import { execFile as execFileCallback } from 'child_process';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { formatError } from './stateSqlite';
import { CapturedTokenUsage, ModelConfidence } from './types';

const HEARTBEAT_PATH = '/exa.language_server_pb.LanguageServerService/Heartbeat';
const SEARCH_CONVERSATIONS_PATH = '/exa.language_server_pb.LanguageServerService/SearchConversations';
const STREAM_AGENT_STATE_UPDATES_PATH = '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates';

const DISCOVERY_INTERVAL_MS = 2_000;
const SEARCH_INTERVAL_MS = 3_000;
const STREAM_RETRY_MS = 3_000;
const STREAM_STARTUP_STALL_MS = 4_000;
const BRAIN_COMPLETION_GRACE_MS = 30_000;
const BRAIN_IDLE_AUTOCOMPLETE_MS = 15_000;
const BRAIN_POST_COMPLETION_SYNC_MS = 60_000;
const BRAIN_LIVE_DISCOVERY_MAX_AGE_MS = 10 * 60 * 1000;
const BRAIN_DIRECTORY_SCAN_INTERVAL_MS = 2_000;
const MAX_ACTIVE_STREAM_TARGETS = 12;
const MAX_BRAIN_DISCOVERY_CONVERSATIONS = 12;
const MAX_RECENT_BRAIN_CONVERSATIONS = 12;
const CONNECT_END_STREAM_FLAG = 0x02;
const PS_OUTPUT_MAX_BUFFER = 4 * 1024 * 1024;

const execFile = promisify(execFileCallback);

interface CollectorOptions {
  output: vscode.OutputChannel;
  getWorkspacePaths: () => string[];
  getPreferredConversationId?: () => string | undefined;
}

interface LanguageServerClientInfo {
  csrfToken: string;
  port: number;
  source: 'runtime' | 'process' | 'logs' | 'process-log';
  discoveredAt: number;
  processId?: number;
}

interface SearchConversationsResponse {
  results?: SearchConversationResult[];
}

interface SearchConversationResult {
  cascadeId?: string;
  title?: string;
  snippet?: string;
  workspaceName?: string;
  lastModifiedTime?: string;
}

interface ConversationSummary {
  conversationId: string;
  title?: string;
  snippet?: string;
  workspaceName?: string;
  lastModifiedAt?: number;
}

interface ActiveRunState {
  conversationId: string;
  executionId: string;
  prompt?: string;
  promptStartedAt?: number;
  promptStepIndex?: number;
  lastUpdatedAt?: number;
  thinking?: string;
  subagent?: string;
  editor?: string;
  output?: string;
  model?: string;
  modelConfidence: ModelConfidence;
  title?: string;
  subtitle?: string;
  contextUsagePercent?: number;
  contextWindowTokens?: number;
  startedEmitted: boolean;
  completed: boolean;
  completedAt?: number;
  completionRequestedAt?: number;
  capturedTokenUsage: Required<Pick<CapturedTokenUsage, 'thinkingTokens' | 'subagentTokens' | 'editorTokens' | 'outputTokens'>>;
  stepTokenContributions: Map<string, StepTokenContribution>;
}

interface StepTokenContribution {
  thinkingTokens: number;
  subagentTokens: number;
  editorTokens: number;
  outputTokens: number;
}

interface BrainFallbackSnapshot {
  prompt?: string;
  promptStartedAt?: number;
  promptStepIndex?: number;
  thinking?: string;
  editor?: string;
  output?: string;
  updatedAt?: number;
}

interface OverviewLogEntry {
  stepIndex?: number;
  source?: string;
  type?: string;
  status?: string;
  createdAt?: number;
  content?: string;
  toolCalls: Array<{ name?: string; args?: Record<string, unknown> }>;
}

interface BrainArtifactEntry {
  baseName: string;
  filePath: string;
  content: string;
  updatedAt: number;
}

interface StreamState {
  conversationId: string;
  session: http2.ClientHttp2Session;
  request: http2.ClientHttp2Stream;
  buffer: Buffer;
  receivedData: boolean;
  openedAt: number;
  closed: boolean;
  finish: (error?: unknown) => void;
}

interface LogCandidate {
  csrfToken: string;
  port: number;
  discoveredAt: number;
  source?: 'logs' | 'process-log';
  processId?: number;
}

interface ProcessCandidate {
  pid: number;
  csrfToken: string;
  discoveredAt: number;
  port?: number;
}

export interface AntigravityConversationSummaryEvent {
  conversationId: string;
  title?: string;
  snippet?: string;
  workspaceName?: string;
  lastModifiedAt?: number;
}

export interface AntigravityTurnStartEvent {
  conversationId: string;
  executionId: string;
  prompt: string;
  startedAt: number;
  title?: string;
  subtitle?: string;
  model?: string;
  modelConfidence: ModelConfidence;
  contextUsagePercent?: number;
  contextWindowTokens?: number;
}

export interface AntigravityTurnUpdateEvent {
  conversationId: string;
  executionId: string;
  updatedAt: number;
  title?: string;
  subtitle?: string;
  model?: string;
  modelConfidence?: ModelConfidence;
  contextUsagePercent?: number;
  contextWindowTokens?: number;
  thinking?: string;
  subagent?: string;
  editor?: string;
  output?: string;
  capturedTokenUsage?: CapturedTokenUsage;
  isComplete: boolean;
}

export class AntigravityLanguageServerCollector implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly getWorkspacePaths: () => string[];
  private readonly getPreferredConversationId?: () => string | undefined;

  private readonly _onConversationSummary = new vscode.EventEmitter<AntigravityConversationSummaryEvent>();
  readonly onConversationSummary = this._onConversationSummary.event;

  private readonly _onTurnStart = new vscode.EventEmitter<AntigravityTurnStartEvent>();
  readonly onTurnStart = this._onTurnStart.event;

  private readonly _onTurnUpdate = new vscode.EventEmitter<AntigravityTurnUpdateEvent>();
  readonly onTurnUpdate = this._onTurnUpdate.event;

  private readonly summaries = new Map<string, ConversationSummary>();
  private readonly runStates = new Map<string, ActiveRunState>();
  private readonly activeStreams = new Map<string, StreamState>();
  private readonly nextStreamAttemptAt = new Map<string, number>();

  private clientInfo?: LanguageServerClientInfo;
  private active = false;
  private tickHandle?: NodeJS.Timeout;
  private lastDiscoveryAt = 0;
  private lastSearchAt = 0;
  private lastBrainDirectoryScanAt = 0;
  private discoveryInFlight = false;
  private searchInFlight = false;
  private brainDirectoryScanInFlight = false;
  private recentBrainConversationIds: string[] = [];

  constructor(options: CollectorOptions) {
    this.output = options.output;
    this.getWorkspacePaths = options.getWorkspacePaths;
    this.getPreferredConversationId = options.getPreferredConversationId;
  }

  start(): void {
    if (this.active) {
      return;
    }

    this.active = true;
    this.tickHandle = setInterval(() => {
      void this.tick();
    }, 1_000);
    void this.tick();
  }

  dispose(): void {
    this.active = false;

    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }

    for (const stream of this.activeStreams.values()) {
      try {
        stream.request.close();
      } catch {
        // Best effort only.
      }
      try {
        stream.session.close();
      } catch {
        // Best effort only.
      }
    }

    this.activeStreams.clear();
    this._onConversationSummary.dispose();
    this._onTurnStart.dispose();
    this._onTurnUpdate.dispose();
  }

  private async tick(): Promise<void> {
    if (!this.active) {
      return;
    }

    const now = Date.now();
    this.closeSilentStreams(now);

    if (!this.clientInfo && !this.discoveryInFlight) {
      this.discoveryInFlight = true;
      try {
        await this.discoverClientInfo();
      } finally {
        this.discoveryInFlight = false;
      }
    } else if (this.clientInfo && now - this.lastDiscoveryAt >= DISCOVERY_INTERVAL_MS * 5 && !this.discoveryInFlight) {
      this.discoveryInFlight = true;
      try {
        await this.validateOrRediscoverClientInfo();
      } finally {
        this.discoveryInFlight = false;
      }
    }

    if (!this.clientInfo || this.searchInFlight || now - this.lastSearchAt < SEARCH_INTERVAL_MS) {
      await this.refreshRecentBrainConversationIds(now);
      this.ensureRecentBrainStreamsOpen(now);
      await this.syncBrainFallbacks();
      return;
    }

    this.searchInFlight = true;
    try {
      await this.refreshRecentBrainConversationIds(now);
      await this.refreshConversationSearch();
    } finally {
      this.searchInFlight = false;
    }

    await this.syncBrainFallbacks();
  }

  private closeSilentStreams(now = Date.now()): void {
    for (const stream of this.activeStreams.values()) {
      if (stream.closed || stream.receivedData || now - stream.openedAt < STREAM_STARTUP_STALL_MS) {
        continue;
      }

      this.output.appendLine(
        `[antigravity-ls] Stream for ${stream.conversationId} produced no data after ${Math.round((now - stream.openedAt) / 1000)}s; retrying.`
      );
      stream.finish();
    }
  }

  private async validateOrRediscoverClientInfo(): Promise<void> {
    await this.discoverClientInfo();
  }

  private async discoverClientInfo(): Promise<void> {
    const candidates = await this.collectClientCandidates();
    for (const candidate of candidates) {
      try {
        await this.requestJson(HEARTBEAT_PATH, {}, candidate);
        const changed = !this.clientInfo
          || this.clientInfo.port !== candidate.port
          || this.clientInfo.csrfToken !== candidate.csrfToken;

        this.clientInfo = candidate;
        this.lastDiscoveryAt = Date.now();

        if (changed) {
          this.output.appendLine(
            `[antigravity-ls] Connected to local language server on port ${candidate.port} via ${candidate.source}.`
          );
        }
        return;
      } catch {
        // Try the next candidate.
      }
    }
  }

  private async collectClientCandidates(): Promise<LanguageServerClientInfo[]> {
    const candidates: LanguageServerClientInfo[] = [];
    const runtimeCandidate = this.readRuntimeClientCandidate();
    if (runtimeCandidate) {
      candidates.push(runtimeCandidate);
    }

    const processCandidates = await this.readProcessCandidates();
    for (const candidate of processCandidates.values()) {
      if (!candidate.port) {
        continue;
      }

      candidates.push({
        csrfToken: candidate.csrfToken,
        port: candidate.port,
        source: 'process',
        discoveredAt: candidate.discoveredAt,
        processId: candidate.pid,
      });
    }

    const logCandidates = await this.readLogCandidates(processCandidates);
    for (const candidate of logCandidates) {
      candidates.push({
        ...candidate,
        source: candidate.source ?? 'logs',
      });
    }

    if (this.clientInfo) {
      candidates.push(this.clientInfo);
    }

    const deduped = new Map<string, LanguageServerClientInfo>();
    for (const candidate of candidates) {
      const key = `${candidate.port}:${candidate.csrfToken}`;
      const existing = deduped.get(key);
      if (!existing || this.compareClientCandidates(candidate, existing) < 0) {
        deduped.set(key, candidate);
      }
    }

    return [...deduped.values()]
      .sort((left, right) => this.compareClientCandidates(left, right));
  }

  private compareClientCandidates(
    left: LanguageServerClientInfo,
    right: LanguageServerClientInfo
  ): number {
    const sourceDelta = this.clientCandidatePriority(right.source) - this.clientCandidatePriority(left.source);
    if (sourceDelta !== 0) {
      return sourceDelta;
    }

    const discoveryDelta = right.discoveredAt - left.discoveredAt;
    if (discoveryDelta !== 0) {
      return discoveryDelta;
    }

    const processDelta = (right.processId ?? 0) - (left.processId ?? 0);
    if (processDelta !== 0) {
      return processDelta;
    }

    return right.port - left.port;
  }

  private clientCandidatePriority(source: LanguageServerClientInfo['source']): number {
    switch (source) {
      case 'runtime':
        return 4;
      case 'process':
        return 3;
      case 'process-log':
        return 2;
      case 'logs':
      default:
        return 1;
    }
  }

  private readRuntimeClientCandidate(): LanguageServerClientInfo | undefined {
    const runtime = (vscode as any).antigravityLanguageServer;
    if (!runtime) {
      return undefined;
    }

    const port = this.pickFiniteNumber([
      runtime.httpsPort,
      runtime.port,
      runtime._httpsPort,
      typeof runtime.getPort === 'function' ? runtime.getPort() : undefined,
      typeof runtime.getHttpsPort === 'function' ? runtime.getHttpsPort() : undefined,
    ]);
    const csrfToken = this.pickNonEmptyString([
      runtime.csrfToken,
      runtime._csrfToken,
      runtime.token,
      typeof runtime.getCsrfToken === 'function' ? runtime.getCsrfToken() : undefined,
    ]);

    if (!port || !csrfToken) {
      return undefined;
    }

    return {
      csrfToken,
      port,
      source: 'runtime',
      discoveredAt: Date.now(),
    };
  }

  private pickFiniteNumber(values: unknown[]): number | undefined {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
      }
    }

    return undefined;
  }

  private pickNonEmptyString(values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }

  private async readLogCandidates(
    processCandidates?: Map<number, ProcessCandidate>
  ): Promise<LogCandidate[]> {
    const roots = [
      path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'logs'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Anti-Gravity', 'logs'),
      path.join(os.homedir(), '.config', 'Antigravity', 'logs'),
      path.join(os.homedir(), '.config', 'Anti-Gravity', 'logs'),
    ];

    const indexedProcessCandidates = processCandidates ?? await this.readProcessCandidates();
    const candidates: LogCandidate[] = [];
    for (const root of roots) {
      let entries: string[];
      try {
        entries = await fs.readdir(root);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const lsMainPath = path.join(root, entry, 'ls-main.log');
        const exthostPath = path.join(root, entry, 'window1', 'exthost', 'google.antigravity', 'Antigravity.log');

        candidates.push(...await this.readLsMainCandidates(lsMainPath));
        candidates.push(...await this.readExthostCandidates(exthostPath, indexedProcessCandidates));
      }
    }

    return candidates
      .sort((left, right) => right.discoveredAt - left.discoveredAt);
  }

  private async readProcessCandidates(): Promise<Map<number, ProcessCandidate>> {
    try {
      const { stdout } = await execFile('ps', ['-axo', 'pid=,command='], {
        maxBuffer: PS_OUTPUT_MAX_BUFFER,
      });
      const now = Date.now();
      const candidates = new Map<number, ProcessCandidate>();
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match) {
          continue;
        }

        const pid = Number(match[1]);
        const command = match[2] ?? '';
        if (!Number.isFinite(pid) || !/language_server/i.test(command)) {
          continue;
        }

        const csrfToken = command.match(/--csrf_token\s+([a-f0-9-]+)/i)?.[1];
        const port = command.match(/--https_server_port\s+(\d+)/i)?.[1];
        if (!csrfToken) {
          continue;
        }

        candidates.set(pid, {
          pid,
          csrfToken,
          discoveredAt: now,
          port: port ? Number(port) : undefined,
        });
      }

      return candidates;
    } catch {
      return new Map();
    }
  }

  private async readLsMainCandidates(logPath: string): Promise<LogCandidate[]> {
    let raw: string;
    let stats;
    try {
      [raw, stats] = await Promise.all([
        fs.readFile(logPath, 'utf8'),
        fs.stat(logPath),
      ]);
    } catch {
      return [];
    }

    const csrfToken = raw.match(/Args:\s+.*--csrf_token\s+([a-f0-9-]+)/i)?.[1];
    const portMatches = [...raw.matchAll(/(?:LS started on port|listening on random port at)\s+(\d+)\s+for HTTPS|LS started on port\s+(\d+)/gi)];
    const port = [...portMatches]
      .map((match) => Number(match[1] ?? match[2]))
      .filter((value) => Number.isFinite(value) && value > 0)
      .pop();

    if (!csrfToken || !port) {
      return [];
    }

    return [{
      csrfToken,
      port,
      discoveredAt: stats.mtimeMs,
      source: 'logs',
    }];
  }

  private async readExthostCandidates(
    logPath: string,
    processCandidates: Map<number, ProcessCandidate>
  ): Promise<LogCandidate[]> {
    let raw: string;
    let stats;
    try {
      [raw, stats] = await Promise.all([
        fs.readFile(logPath, 'utf8'),
        fs.stat(logPath),
      ]);
    } catch {
      return [];
    }

    const matches = [...raw.matchAll(/(?:^|\s)(\d+)\s+server\.go:454\]\s+Language server listening on random port at\s+(\d+)\s+for HTTPS/gi)];
    const candidates: LogCandidate[] = [];
    for (const match of matches) {
      const pid = Number(match[1]);
      const port = Number(match[2]);
      const processCandidate = processCandidates.get(pid);
      if (!Number.isFinite(pid) || !Number.isFinite(port) || port <= 0 || !processCandidate) {
        continue;
      }

      candidates.push({
        csrfToken: processCandidate.csrfToken,
        port,
        discoveredAt: Math.max(stats.mtimeMs, processCandidate.discoveredAt),
        source: 'process-log',
        processId: pid,
      });
    }

    return candidates;
  }

  private async refreshConversationSearch(): Promise<void> {
    if (!this.clientInfo) {
      return;
    }

    const response = await this.requestJson<SearchConversationsResponse>(
      SEARCH_CONVERSATIONS_PATH,
      { query: '', limit: 12 }
    );
    this.lastSearchAt = Date.now();

    const workspaceBasenames = this.getWorkspacePaths()
      .map((workspacePath) => path.basename(workspacePath).toLowerCase())
      .filter(Boolean);

    const results = dedupeSearchConversationResults(
      Array.isArray(response.results) ? response.results : []
    );
    const relevantResults = results.filter((result) => {
      if (!workspaceBasenames.length) {
        return true;
      }

      const workspaceName = (result.workspaceName ?? '').toLowerCase();
      return workspaceBasenames.some((basename) =>
        workspaceName === basename
        || workspaceName.endsWith(`/${basename}`)
        || workspaceName.includes(basename)
      );
    });
    const chosenResults = relevantResults.length > 0 ? relevantResults : results;
    const summaryResults = dedupeSearchConversationResults([
      ...chosenResults,
      ...results.slice(0, MAX_ACTIVE_STREAM_TARGETS),
    ]);
    const streamResults = dedupeSearchConversationResults([
      ...results.slice(0, MAX_ACTIVE_STREAM_TARGETS),
      ...chosenResults,
    ]);

    for (const result of summaryResults) {
      if (!result.cascadeId) {
        continue;
      }

      const summary: ConversationSummary = {
        conversationId: result.cascadeId,
        title: sanitizeTitle(result.title),
        snippet: sanitizeSnippet(result.snippet),
        workspaceName: typeof result.workspaceName === 'string' ? result.workspaceName : undefined,
        lastModifiedAt: toTimestamp(result.lastModifiedTime),
      };

      const previous = this.summaries.get(summary.conversationId);
      const changed = !previous
        || previous.title !== summary.title
        || previous.snippet !== summary.snippet
        || previous.lastModifiedAt !== summary.lastModifiedAt;

      this.summaries.set(summary.conversationId, summary);
      if (changed) {
        this._onConversationSummary.fire({ ...summary });
      }
    }

    const preferredConversationId = this.getPreferredConversationId?.();
    const targetIds = new Set<string>();
    if (preferredConversationId) {
      targetIds.add(preferredConversationId);
    }
    for (const conversationId of this.recentBrainConversationIds.slice(0, MAX_ACTIVE_STREAM_TARGETS)) {
      targetIds.add(conversationId);
    }
    for (const result of streamResults.slice(0, MAX_ACTIVE_STREAM_TARGETS)) {
      if (result.cascadeId) {
        targetIds.add(result.cascadeId);
      }
    }

    const now = Date.now();
    for (const conversationId of targetIds) {
      if (this.activeStreams.has(conversationId)) {
        continue;
      }

      const nextAttemptAt = this.nextStreamAttemptAt.get(conversationId) ?? 0;
      if (nextAttemptAt > now) {
        continue;
      }

      this.openConversationStream(conversationId);
    }
  }

  private async refreshRecentBrainConversationIds(now = Date.now()): Promise<void> {
    if (
      this.brainDirectoryScanInFlight
      || now - this.lastBrainDirectoryScanAt < BRAIN_DIRECTORY_SCAN_INTERVAL_MS
    ) {
      return;
    }

    this.brainDirectoryScanInFlight = true;
    try {
      const recentConversationIds = await listRecentBrainConversationIds(MAX_RECENT_BRAIN_CONVERSATIONS);
      const previousIds = new Set(this.recentBrainConversationIds);
      const newlyDiscovered = recentConversationIds.filter((conversationId) => !previousIds.has(conversationId));

      this.recentBrainConversationIds = recentConversationIds;
      this.lastBrainDirectoryScanAt = now;

      for (const conversationId of newlyDiscovered) {
        this.output.appendLine(
          `[antigravity-ls] Discovered recent brain conversation ${conversationId}.`
        );
      }
    } finally {
      this.brainDirectoryScanInFlight = false;
    }
  }

  private ensureRecentBrainStreamsOpen(now = Date.now()): void {
    if (!this.clientInfo) {
      return;
    }

    const targetIds = new Set<string>();
    const preferredConversationId = this.getPreferredConversationId?.();
    if (preferredConversationId) {
      targetIds.add(preferredConversationId);
    }
    for (const conversationId of this.recentBrainConversationIds.slice(0, MAX_ACTIVE_STREAM_TARGETS)) {
      targetIds.add(conversationId);
    }

    for (const conversationId of targetIds) {
      if (this.activeStreams.has(conversationId)) {
        continue;
      }

      const nextAttemptAt = this.nextStreamAttemptAt.get(conversationId) ?? 0;
      if (nextAttemptAt > now) {
        continue;
      }

      this.openConversationStream(conversationId);
    }
  }

  private openConversationStream(conversationId: string): void {
    if (!this.clientInfo || this.activeStreams.has(conversationId)) {
      return;
    }

    const clientInfo = this.clientInfo;
    const session = http2.connect(`https://127.0.0.1:${clientInfo.port}`, {
      rejectUnauthorized: false,
    });
    const request = session.request({
      ':method': 'POST',
      ':path': STREAM_AGENT_STATE_UPDATES_PATH,
      'content-type': 'application/connect+json',
      'x-codeium-csrf-token': clientInfo.csrfToken,
    });
    const streamState: StreamState = {
      conversationId,
      session,
      request,
      buffer: Buffer.alloc(0),
      receivedData: false,
      openedAt: Date.now(),
      closed: false,
      finish: () => undefined,
    };

    this.activeStreams.set(conversationId, streamState);
    const summary = this.summaries.get(conversationId);
    const summaryLabel = [summary?.title, summary?.workspaceName]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' | ');
    this.output.appendLine(
      `[antigravity-ls] Stream opened for ${conversationId}${summaryLabel ? ` (${summaryLabel})` : ''}.`
    );

    let statusCode = 200;
    const errorChunks: Buffer[] = [];

    request.on('response', (headers) => {
      statusCode = Number(headers[':status'] ?? 200);
    });

    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      if (statusCode >= 400) {
        errorChunks.push(buffer);
        return;
      }

      streamState.receivedData = true;
      streamState.openedAt = Date.now();
      streamState.buffer = Buffer.concat([streamState.buffer, buffer]);
      streamState.buffer = this.consumeConnectEnvelopes(streamState.buffer, (message) => {
        this.handleStreamMessage(conversationId, message);
      });
    });

    const finish = (error?: unknown) => {
      if (streamState.closed) {
        return;
      }
      streamState.closed = true;
      this.activeStreams.delete(conversationId);
      this.nextStreamAttemptAt.set(conversationId, Date.now() + STREAM_RETRY_MS);

      try {
        request.close();
      } catch {
        // Best effort only.
      }
      try {
        session.close();
      } catch {
        // Best effort only.
      }

      if (!this.active) {
        return;
      }

      if (statusCode >= 400) {
        const detail = Buffer.concat(errorChunks).toString('utf8');
        if (!/agent state .* not found/i.test(detail)) {
          this.output.appendLine(
            `[antigravity-ls] Stream request failed for ${conversationId}: ${detail || `HTTP ${statusCode}`}`
          );
        }
        return;
      }

      if (error && !/ECONNRESET/i.test(formatError(error))) {
        this.output.appendLine(
          `[antigravity-ls] Stream closed for ${conversationId}: ${formatError(error)}`
        );
      }
    };
    streamState.finish = finish;

    request.on('error', finish);
    request.on('end', () => finish());
    session.on('error', finish);
    session.on('close', () => finish());

    request.end(frameConnectJson({ conversationId }));
  }

  private consumeConnectEnvelopes(
    buffer: Buffer,
    onEnvelope: (payload: any) => void
  ): Buffer {
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const flags = buffer.readUInt8(offset);
      const length = buffer.readUInt32BE(offset + 1);
      if (offset + 5 + length > buffer.length) {
        break;
      }

      const payload = buffer.subarray(offset + 5, offset + 5 + length);
      offset += 5 + length;

      if (flags & CONNECT_END_STREAM_FLAG) {
        continue;
      }

      try {
        onEnvelope(JSON.parse(payload.toString('utf8')));
      } catch {
        // Ignore malformed payloads from the stream.
      }
    }

    return offset > 0 ? buffer.subarray(offset) : buffer;
  }

  private handleStreamMessage(conversationId: string, message: any): void {
    const update = message?.update;
    if (!update || typeof update !== 'object') {
      return;
    }

    const resolvedConversationId = typeof update.conversationId === 'string'
      ? update.conversationId
      : conversationId;
    const summary = this.summaries.get(resolvedConversationId);

    this.applyGeneratorMetadata(resolvedConversationId, update, summary);

    const stepsUpdate = update.mainTrajectoryUpdate?.stepsUpdate;
    const steps = Array.isArray(stepsUpdate?.steps) ? stepsUpdate.steps : [];
    for (const step of steps) {
      this.applyStepUpdate(resolvedConversationId, step, summary);
    }

    this.applyExecutorCompletions(resolvedConversationId, update);
    this.applyConversationCompletion(resolvedConversationId, update);
  }

  private applyGeneratorMetadata(
    conversationId: string,
    update: any,
    summary: ConversationSummary | undefined
  ): void {
    const generatorMetadatas = update.mainTrajectoryUpdate?.generatorMetadatasUpdate?.generatorMetadatas;
    if (!Array.isArray(generatorMetadatas)) {
      return;
    }

    for (const metadata of generatorMetadatas) {
      const executionId = this.extractExecutionId(metadata);
      if (!executionId) {
        continue;
      }

      const run = this.ensureRunState(conversationId, executionId);
      const model = this.extractModelName(metadata);
      const contextWindowTokens = toNumber(
        metadata?.plannerConfig?.truncationThresholdTokens
        ?? metadata?.chatModel?.chatStartMetadata?.contextWindowMetadata?.totalTokens
      );
      const estimatedTokensUsed = toNumber(
        metadata?.chatModel?.chatStartMetadata?.contextWindowMetadata?.estimatedTokensUsed
      );
      const contextUsagePercent = contextWindowTokens && estimatedTokensUsed
        ? Math.min(100, (estimatedTokensUsed / contextWindowTokens) * 100)
        : undefined;

      let changed = false;
      if (model && run.model !== model) {
        run.model = model;
        run.modelConfidence = 'exact';
        changed = true;
      }
      if (summary?.title && run.title !== summary.title) {
        run.title = summary.title;
        changed = true;
      }
      if (summary?.snippet && run.subtitle !== summary.snippet) {
        run.subtitle = summary.snippet;
        changed = true;
      }
      if (contextWindowTokens && run.contextWindowTokens !== contextWindowTokens) {
        run.contextWindowTokens = contextWindowTokens;
        changed = true;
      }
      if (contextUsagePercent !== undefined && run.contextUsagePercent !== contextUsagePercent) {
        run.contextUsagePercent = contextUsagePercent;
        changed = true;
      }

      if (changed && run.startedEmitted) {
        this._onTurnUpdate.fire({
          conversationId,
          executionId,
          updatedAt: Date.now(),
          title: run.title,
          subtitle: run.subtitle,
          model: run.model,
          modelConfidence: run.modelConfidence,
          contextUsagePercent: run.contextUsagePercent,
          contextWindowTokens: run.contextWindowTokens,
          thinking: run.thinking,
          subagent: run.subagent,
          editor: run.editor,
          output: run.output,
          capturedTokenUsage: { ...run.capturedTokenUsage },
          isComplete: run.completed,
        });
      }
    }
  }

  private applyStepUpdate(
    conversationId: string,
    step: any,
    summary: ConversationSummary | undefined
  ): void {
    const executionId = this.extractExecutionId(step);
    if (!executionId) {
      return;
    }

    const run = this.ensureRunState(conversationId, executionId);
    if (summary?.title) {
      run.title = summary.title;
    }
    if (summary?.snippet) {
      run.subtitle = summary.snippet;
    }

    const type = typeof step?.type === 'string' ? step.type : '';
    const status = typeof step?.status === 'string' ? step.status : '';

    if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const prompt = extractUserPrompt(step?.userInput);
      if (!prompt) {
        return;
      }

      const startedAt = stepTimestamp(step?.metadata) ?? Date.now();
      run.prompt = prompt;
      run.promptStartedAt = startedAt;

      if (!run.startedEmitted) {
        run.startedEmitted = true;
        this._onTurnStart.fire({
          conversationId,
          executionId,
          prompt,
          startedAt,
          title: run.title,
          subtitle: run.subtitle,
          model: run.model,
          modelConfidence: run.modelConfidence,
          contextUsagePercent: run.contextUsagePercent,
          contextWindowTokens: run.contextWindowTokens,
        });
      }
      return;
    }

    const updatedAt = stepTimestamp(step?.metadata) ?? Date.now();

    if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      this.emitLateTurnStartIfNeeded(conversationId, executionId, run, summary, updatedAt);
      const tokenChanged = this.captureStepTokenUsage(run, step, 'primary');
      const output = extractPlannerResponse(step?.plannerResponse);
      const thinking = extractPlannerThinking(step?.plannerResponse);
      const changedThinking = thinking !== undefined && thinking !== run.thinking;
      const changedOutput = output !== undefined && output !== run.output;
      if (!changedThinking && !changedOutput && !tokenChanged) {
        return;
      }

      if (thinking !== undefined) {
        run.thinking = thinking;
      }
      if (output !== undefined) {
        run.output = output;
      }
      run.lastUpdatedAt = updatedAt;

      this._onTurnUpdate.fire({
        conversationId,
        executionId,
        updatedAt,
        title: run.title,
        subtitle: run.subtitle,
        model: run.model,
        modelConfidence: run.modelConfidence,
        contextUsagePercent: run.contextUsagePercent,
        contextWindowTokens: run.contextWindowTokens,
        thinking: run.thinking,
        subagent: run.subagent,
        editor: run.editor,
        output: run.output,
        capturedTokenUsage: { ...run.capturedTokenUsage },
        isComplete: false,
      });
      return;
    }

    const auxiliaryText = extractAuxiliaryStepText(step);
    const auxiliaryKind = classifyAuxiliaryStepType(type);
    if (auxiliaryKind) {
      this.emitLateTurnStartIfNeeded(conversationId, executionId, run, summary, updatedAt);
    }
    const tokenChanged = auxiliaryKind
      ? this.captureStepTokenUsage(run, step, auxiliaryKind)
      : false;
    if (!auxiliaryKind) {
      return;
    }

    const nextValue = auxiliaryText
      ? mergeStepText(auxiliaryKind === 'subagent' ? run.subagent : run.editor, auxiliaryText)
      : auxiliaryKind === 'subagent'
        ? run.subagent
        : run.editor;
    const changedAuxiliary = auxiliaryKind === 'subagent'
      ? nextValue !== run.subagent
      : nextValue !== run.editor;
    if (!changedAuxiliary && !tokenChanged) {
      return;
    }

    if (auxiliaryKind === 'subagent') {
      run.subagent = nextValue;
    } else {
      run.editor = nextValue;
    }
    run.lastUpdatedAt = updatedAt;

    this._onTurnUpdate.fire({
      conversationId,
      executionId,
      updatedAt,
      title: run.title,
      subtitle: run.subtitle,
      model: run.model,
      modelConfidence: run.modelConfidence,
      contextUsagePercent: run.contextUsagePercent,
      contextWindowTokens: run.contextWindowTokens,
      thinking: run.thinking,
      subagent: run.subagent,
      editor: run.editor,
      output: run.output,
      capturedTokenUsage: { ...run.capturedTokenUsage },
      isComplete: false,
    });
  }

  private applyConversationCompletion(conversationId: string, update: any): void {
    const statuses = [
      update?.status,
      update?.executableStatus,
      update?.executorLoopStatus,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const isIdle = statuses.length > 0 && statuses.every((value) => value === 'CASCADE_RUN_STATUS_IDLE');
    if (!isIdle) {
      return;
    }

    const relatedRuns = [...this.runStates.values()]
      .filter((run) =>
        run.conversationId === conversationId
        && run.startedEmitted
        && !run.completed
      );

    for (const run of relatedRuns) {
      this.emitRunCompletion(conversationId, run);
    }
  }

  private applyExecutorCompletions(conversationId: string, update: any): void {
    const executorMetadatas = update?.mainTrajectoryUpdate?.executorMetadatasUpdate?.executorMetadatas;
    if (!Array.isArray(executorMetadatas)) {
      return;
    }

    for (const metadata of executorMetadatas) {
      const executionId = this.extractExecutionId(metadata);
      const terminationReason = typeof metadata?.terminationReason === 'string'
        ? metadata.terminationReason
        : '';
      if (!executionId || !terminationReason) {
        continue;
      }

      const run = this.runStates.get(`${conversationId}:${executionId}`);
      if (!run || !run.startedEmitted || run.completed) {
        continue;
      }

      this.emitRunCompletion(conversationId, run);
    }
  }

  private emitRunCompletion(
    conversationId: string,
    run: ActiveRunState
  ): void {
    if (run.completed) {
      return;
    }

    const firstCompletionRequest = !run.completionRequestedAt;
    run.completionRequestedAt = run.completionRequestedAt ?? Date.now();
    this.syncBrainFallbackForRunSync(run);
    if (this.shouldDelayCompletion(run)) {
      if (firstCompletionRequest) {
        this.output.appendLine(
          `[antigravity-ls] Delaying completion for ${conversationId} while recent brain activity is still arriving.`
        );
      }
      return;
    }

    this.emitRunCompletionNow(conversationId, run);
  }

  private emitRunCompletionNow(
    conversationId: string,
    run: ActiveRunState
  ): void {
    if (run.completed) {
      return;
    }

    run.completed = true;
    run.completedAt = Date.now();
    run.completionRequestedAt = undefined;
    const updatedAt = run.lastUpdatedAt ?? run.promptStartedAt ?? Date.now();
    this._onTurnUpdate.fire({
      conversationId,
      executionId: run.executionId,
      updatedAt,
      title: run.title,
      subtitle: run.subtitle,
      model: run.model,
      modelConfidence: run.modelConfidence,
      contextUsagePercent: run.contextUsagePercent,
      contextWindowTokens: run.contextWindowTokens,
      thinking: run.thinking,
      subagent: run.subagent,
      editor: run.editor,
      output: run.output,
      capturedTokenUsage: { ...run.capturedTokenUsage },
      isComplete: true,
    });
  }

  private async syncBrainFallbacks(): Promise<void> {
    const candidateConversationIds = this.collectBrainFallbackCandidateConversationIds();
    for (const conversationId of candidateConversationIds) {
      try {
        await this.syncBrainFallbackForConversation(conversationId);
      } catch (error) {
        this.output.appendLine(
          `[antigravity-ls] Brain fallback discovery failed for ${conversationId}: ${formatError(error)}`
        );
      }
    }

    const activeRuns = [...this.runStates.values()].filter((run) =>
      run.startedEmitted
      && (
        !run.completed
        || Boolean(run.completionRequestedAt)
        || (
          Math.max(
            run.completedAt ?? 0,
            run.lastUpdatedAt ?? 0,
            run.promptStartedAt ?? 0
          ) > 0
          && Date.now() - Math.max(
            run.completedAt ?? 0,
            run.lastUpdatedAt ?? 0,
            run.promptStartedAt ?? 0
          ) < BRAIN_POST_COMPLETION_SYNC_MS
        )
      )
    );

    for (const run of activeRuns) {
      try {
        await this.syncBrainFallbackForRun(run);
        if (run.completionRequestedAt && !this.shouldDelayCompletion(run)) {
          this.emitRunCompletionNow(run.conversationId, run);
        } else if (!run.completionRequestedAt && this.shouldAutoCompleteBrainRecoveredRun(run)) {
          this.output.appendLine(
            `[antigravity-ls] Auto-finalizing idle brain-backed run for ${run.conversationId}.`
          );
          this.emitRunCompletionNow(run.conversationId, run);
        }
      } catch (error) {
        this.output.appendLine(
          `[antigravity-ls] Brain fallback sync failed for ${run.conversationId}: ${formatError(error)}`
        );
      }
    }
  }

  private collectBrainFallbackCandidateConversationIds(): string[] {
    const conversationIds = new Set<string>();
    const preferredConversationId = this.getPreferredConversationId?.();
    if (preferredConversationId) {
      conversationIds.add(preferredConversationId);
    }

    const recentSummaries = [...this.summaries.values()]
      .sort((left, right) => (right.lastModifiedAt ?? 0) - (left.lastModifiedAt ?? 0))
      .slice(0, MAX_BRAIN_DISCOVERY_CONVERSATIONS);
    for (const summary of recentSummaries) {
      conversationIds.add(summary.conversationId);
    }

    for (const conversationId of this.recentBrainConversationIds) {
      conversationIds.add(conversationId);
    }

    for (const run of this.runStates.values()) {
      conversationIds.add(run.conversationId);
    }

    return [...conversationIds];
  }

  private async syncBrainFallbackForConversation(conversationId: string): Promise<void> {
    const snapshot = await loadBrainFallbackSnapshot(conversationId);
    if (!snapshot) {
      return;
    }

    const summary = this.summaries.get(conversationId);
    const run = this.findOrCreateRunForBrainSnapshot(conversationId, snapshot, summary);
    if (!run) {
      return;
    }

    this.applyBrainFallbackSnapshot(run, snapshot, false);
  }

  private findOrCreateRunForBrainSnapshot(
    conversationId: string,
    snapshot: BrainFallbackSnapshot,
    summary: ConversationSummary | undefined
  ): ActiveRunState | undefined {
    const prompt = normalizeBrainFallbackText(snapshot.prompt);
    if (!prompt) {
      return undefined;
    }

    const normalizedPrompt = prompt.toLowerCase();
    const candidates = [...this.runStates.values()]
      .filter((run) => run.conversationId === conversationId)
      .sort((left, right) => (right.promptStartedAt ?? 0) - (left.promptStartedAt ?? 0));
    const matchingRun = candidates.find((run) => {
      if (
        snapshot.promptStepIndex !== undefined
        && run.promptStepIndex !== undefined
        && snapshot.promptStepIndex === run.promptStepIndex
      ) {
        return true;
      }

      if (
        snapshot.promptStartedAt !== undefined
        && run.promptStartedAt !== undefined
        && Math.abs(snapshot.promptStartedAt - run.promptStartedAt) <= 2_000
      ) {
        return !run.prompt || normalizeBrainFallbackText(run.prompt).toLowerCase() === normalizedPrompt;
      }

      const latestActivityAt = run.lastUpdatedAt ?? run.promptStartedAt ?? 0;
      return Boolean(run.prompt)
        && normalizeBrainFallbackText(run.prompt).toLowerCase() === normalizedPrompt
        && (
          !run.completed
          || (latestActivityAt > 0 && Date.now() - latestActivityAt < BRAIN_LIVE_DISCOVERY_MAX_AGE_MS)
        );
    });
    if (matchingRun) {
      if (snapshot.promptStepIndex !== undefined) {
        matchingRun.promptStepIndex = snapshot.promptStepIndex;
      }
      return matchingRun;
    }

    const snapshotActivityAt = snapshot.updatedAt ?? snapshot.promptStartedAt ?? 0;
    if (snapshotActivityAt > 0 && Date.now() - snapshotActivityAt > BRAIN_LIVE_DISCOVERY_MAX_AGE_MS) {
      return undefined;
    }

    const executionId = `brain:${conversationId}:${snapshot.promptStepIndex ?? snapshot.promptStartedAt ?? Date.now()}`;
    const run = this.ensureRunState(conversationId, executionId);
    run.prompt = prompt;
    run.promptStartedAt = snapshot.promptStartedAt ?? run.promptStartedAt ?? Date.now();
    run.promptStepIndex = snapshot.promptStepIndex ?? run.promptStepIndex;
    run.title = summary?.title ?? run.title;
    run.subtitle = summary?.snippet ?? run.subtitle;

    if (!run.startedEmitted) {
      run.startedEmitted = true;
      this.output.appendLine(
        `[antigravity-ls] Live turn recovered from brain overview for ${conversationId}.`
      );
      this._onTurnStart.fire({
        conversationId,
        executionId,
        prompt,
        startedAt: run.promptStartedAt,
        title: run.title,
        subtitle: run.subtitle,
        model: run.model,
        modelConfidence: run.modelConfidence,
        contextUsagePercent: run.contextUsagePercent,
        contextWindowTokens: run.contextWindowTokens,
      });
    }

    return run;
  }

  private shouldAutoCompleteBrainRecoveredRun(run: ActiveRunState): boolean {
    if (run.completed || !run.startedEmitted || run.completionRequestedAt) {
      return false;
    }

    const latestActivityAt = run.lastUpdatedAt ?? run.promptStartedAt ?? 0;
    if (!latestActivityAt || Date.now() - latestActivityAt < BRAIN_IDLE_AUTOCOMPLETE_MS) {
      return false;
    }

    return Boolean(
      normalizeBrainFallbackText(run.editor)
      || normalizeBrainFallbackText(run.output)
    );
  }

  private shouldDelayCompletion(run: ActiveRunState): boolean {
    if (!run.completionRequestedAt) {
      return false;
    }

    const latestActivityAt = Math.max(
      run.lastUpdatedAt ?? 0,
      run.promptStartedAt ?? 0,
      run.completionRequestedAt
    );
    return Date.now() - latestActivityAt < BRAIN_COMPLETION_GRACE_MS;
  }

  private async syncBrainFallbackForRun(run: ActiveRunState): Promise<void> {
    const snapshot = await loadBrainFallbackSnapshotForRun(run.conversationId, run);
    if (!snapshot) {
      return;
    }

    this.applyBrainFallbackSnapshot(run, snapshot, false);
  }

  private syncBrainFallbackForRunSync(run: ActiveRunState): void {
    const snapshot = loadBrainFallbackSnapshotForRunSync(run.conversationId, run);
    if (!snapshot) {
      return;
    }

    this.applyBrainFallbackSnapshot(run, snapshot, true);
  }

  private applyBrainFallbackSnapshot(
    run: ActiveRunState,
    snapshot: BrainFallbackSnapshot,
    forceLog: boolean
  ): void {
    let changed = false;
    let tokenChanged = false;

    if (!run.prompt && snapshot.prompt) {
      run.prompt = snapshot.prompt;
      changed = true;
    }
    if (!run.promptStartedAt && snapshot.promptStartedAt) {
      run.promptStartedAt = snapshot.promptStartedAt;
    }
    if (snapshot.promptStepIndex !== undefined && run.promptStepIndex !== snapshot.promptStepIndex) {
      run.promptStepIndex = snapshot.promptStepIndex;
    }

    if (snapshot.thinking && snapshot.thinking !== run.thinking) {
      run.thinking = snapshot.thinking;
      changed = true;
    }
    if (snapshot.editor && snapshot.editor !== run.editor) {
      run.editor = snapshot.editor;
      changed = true;
    }
    if (snapshot.output && snapshot.output !== run.output) {
      run.output = snapshot.output;
      changed = true;
    }
    if (snapshot.updatedAt && (!run.lastUpdatedAt || snapshot.updatedAt > run.lastUpdatedAt)) {
      run.lastUpdatedAt = snapshot.updatedAt;
    }

    tokenChanged = this.applySyntheticTextContribution(
      run,
      'brain-fallback-thinking',
      {
        thinkingTokens: estimateTextTokenCount(snapshot.thinking),
        subagentTokens: 0,
        editorTokens: 0,
        outputTokens: 0,
      }
    ) || tokenChanged;
    tokenChanged = this.applySyntheticTextContribution(
      run,
      'brain-fallback-editor',
      {
        thinkingTokens: 0,
        subagentTokens: 0,
        editorTokens: estimateTextTokenCount(snapshot.editor),
        outputTokens: 0,
      }
    ) || tokenChanged;
    tokenChanged = this.applySyntheticTextContribution(
      run,
      'brain-fallback-output',
      {
        thinkingTokens: 0,
        subagentTokens: 0,
        editorTokens: 0,
        outputTokens: estimateTextTokenCount(snapshot.output),
      }
    ) || tokenChanged;

    if (!changed && !tokenChanged) {
      return;
    }

    if (forceLog || snapshot.thinking || snapshot.editor || snapshot.output) {
      this.output.appendLine(
        `[antigravity-ls] Recovered brain fallback for ${run.conversationId}: thinking=${estimateTextTokenCount(snapshot.thinking)} editor=${estimateTextTokenCount(snapshot.editor)} output=${estimateTextTokenCount(snapshot.output)}`
      );
    }

    if (run.startedEmitted) {
      this._onTurnUpdate.fire({
        conversationId: run.conversationId,
        executionId: run.executionId,
        updatedAt: run.lastUpdatedAt ?? run.promptStartedAt ?? Date.now(),
        title: run.title,
        subtitle: run.subtitle,
        model: run.model,
        modelConfidence: run.modelConfidence,
        contextUsagePercent: run.contextUsagePercent,
        contextWindowTokens: run.contextWindowTokens,
        thinking: run.thinking,
        subagent: run.subagent,
        editor: run.editor,
        output: run.output,
        capturedTokenUsage: { ...run.capturedTokenUsage },
        isComplete: run.completed,
      });
    }
  }

  private applySyntheticTextContribution(
    run: ActiveRunState,
    stepKey: string,
    nextContribution: StepTokenContribution
  ): boolean {
    const previousContribution = run.stepTokenContributions.get(stepKey) ?? emptyStepTokenContribution();
    if (stepTokenContributionEquals(previousContribution, nextContribution)) {
      return false;
    }

    run.capturedTokenUsage.thinkingTokens = Math.max(
      0,
      run.capturedTokenUsage.thinkingTokens + nextContribution.thinkingTokens - previousContribution.thinkingTokens
    );
    run.capturedTokenUsage.subagentTokens = Math.max(
      0,
      run.capturedTokenUsage.subagentTokens + nextContribution.subagentTokens - previousContribution.subagentTokens
    );
    run.capturedTokenUsage.editorTokens = Math.max(
      0,
      run.capturedTokenUsage.editorTokens + nextContribution.editorTokens - previousContribution.editorTokens
    );
    run.capturedTokenUsage.outputTokens = Math.max(
      0,
      run.capturedTokenUsage.outputTokens + nextContribution.outputTokens - previousContribution.outputTokens
    );
    run.stepTokenContributions.set(stepKey, nextContribution);
    return true;
  }

  private emitLateTurnStartIfNeeded(
    conversationId: string,
    executionId: string,
    run: ActiveRunState,
    summary: ConversationSummary | undefined,
    startedAt: number
  ): void {
    if (run.startedEmitted) {
      return;
    }

    const recoveredPrompt = run.prompt
      ?? summary?.snippet
      ?? '';
    run.prompt = recoveredPrompt;
    run.promptStartedAt = run.promptStartedAt ?? startedAt;
    run.startedEmitted = true;

    if (!recoveredPrompt) {
      this.output.appendLine(
        `[antigravity-ls] Late-attached live run ${executionId} started without a recovered prompt.`
      );
    }

    this._onTurnStart.fire({
      conversationId,
      executionId,
      prompt: recoveredPrompt,
      startedAt: run.promptStartedAt,
      title: run.title,
      subtitle: run.subtitle,
      model: run.model,
      modelConfidence: run.modelConfidence,
      contextUsagePercent: run.contextUsagePercent,
      contextWindowTokens: run.contextWindowTokens,
    });
  }

  private ensureRunState(conversationId: string, executionId: string): ActiveRunState {
    const key = `${conversationId}:${executionId}`;
    const existing = this.runStates.get(key);
    if (existing) {
      return existing;
    }

    const next: ActiveRunState = {
      conversationId,
      executionId,
      modelConfidence: 'unknown',
      startedEmitted: false,
      completed: false,
      capturedTokenUsage: {
        thinkingTokens: 0,
        subagentTokens: 0,
        editorTokens: 0,
        outputTokens: 0,
      },
      stepTokenContributions: new Map<string, StepTokenContribution>(),
    };
    this.runStates.set(key, next);
    return next;
  }

  private captureStepTokenUsage(
    run: ActiveRunState,
    step: any,
    kind: 'primary' | 'subagent' | 'editor'
  ): boolean {
    const stepKey = buildCountedStepKey(step);
    if (!stepKey) {
      return false;
    }

    const metadata = step?.metadata ?? {};
    const previousContribution = run.stepTokenContributions.get(stepKey) ?? emptyStepTokenContribution();
    const nextContribution = emptyStepTokenContribution();
    let usedEstimatedTokens = false;

    if (kind === 'primary') {
      const usage = metadata?.modelUsage
        ?? step?.plannerResponse?.modelUsage
        ?? step?.plannerResponse?.usage
        ?? step?.plannerResponse?.usageMetadata
        ?? {};
      const totalOutputTokens = firstFiniteNumber(
        usage?.outputTokens,
        usage?.outputTokenCount,
        usage?.candidatesTokenCount,
        usage?.completionTokens,
        usage?.completion_tokens
      ) ?? 0;
      const thinkingTokens = firstFiniteNumber(
        usage?.thinkingOutputTokens,
        usage?.thinkingTokens,
        usage?.reasoningTokens,
        usage?.reasoningOutputTokens,
        usage?.thoughtsTokenCount,
        usage?.candidatesTokensDetails?.thoughtsTokenCount,
        usage?.completionTokensDetails?.reasoningTokens,
        usage?.completion_tokens_details?.reasoning_tokens
      ) ?? 0;
      const responseTokens = firstFiniteNumber(
        usage?.responseOutputTokens,
        usage?.responseTokens,
        usage?.textOutputTokens,
        usage?.visibleOutputTokens
      );
      const outputTokens = responseTokens ?? Math.max(0, totalOutputTokens - thinkingTokens);
      const thinkingText = extractPlannerThinking(step?.plannerResponse);
      const outputText = extractPlannerResponse(step?.plannerResponse);
      nextContribution.thinkingTokens = thinkingTokens > 0
        ? thinkingTokens
        : estimateTextTokenCount(thinkingText);
      nextContribution.outputTokens = outputTokens > 0
        ? outputTokens
        : estimateTextTokenCount(outputText);
      usedEstimatedTokens = (
        (nextContribution.thinkingTokens > 0 && thinkingTokens === 0)
        || (nextContribution.outputTokens > 0 && outputTokens === 0)
      );
    } else {
      const toolTokens = firstFiniteNumber(
        metadata?.toolCallOutputTokens,
        metadata?.toolOutputTokens,
        metadata?.outputTokens
      ) ?? 0;
      const auxiliaryText = extractAuxiliaryStepText(step);
      const estimatedTokens = toolTokens > 0
        ? toolTokens
        : estimateTextTokenCount(auxiliaryText);
      if (kind === 'editor') {
        nextContribution.editorTokens = estimatedTokens;
      } else {
        nextContribution.subagentTokens = estimatedTokens;
      }
      usedEstimatedTokens = estimatedTokens > 0 && toolTokens === 0;
    }

    if (stepTokenContributionEquals(previousContribution, nextContribution)) {
      return false;
    }

    run.capturedTokenUsage.thinkingTokens = Math.max(
      0,
      run.capturedTokenUsage.thinkingTokens + nextContribution.thinkingTokens - previousContribution.thinkingTokens
    );
    run.capturedTokenUsage.subagentTokens = Math.max(
      0,
      run.capturedTokenUsage.subagentTokens + nextContribution.subagentTokens - previousContribution.subagentTokens
    );
    run.capturedTokenUsage.editorTokens = Math.max(
      0,
      run.capturedTokenUsage.editorTokens + nextContribution.editorTokens - previousContribution.editorTokens
    );
    run.capturedTokenUsage.outputTokens = Math.max(
      0,
      run.capturedTokenUsage.outputTokens + nextContribution.outputTokens - previousContribution.outputTokens
    );
    run.stepTokenContributions.set(stepKey, nextContribution);

    if (usedEstimatedTokens) {
      this.output.appendLine(
        `[antigravity-ls] Estimated ${kind} tokens from text for step ${stepKey}: thinking=${nextContribution.thinkingTokens} subagent=${nextContribution.subagentTokens} editor=${nextContribution.editorTokens} output=${nextContribution.outputTokens}`
      );
    }

    return true;
  }

  private extractExecutionId(value: any): string | undefined {
    const candidates = [
      value?.executionId,
      value?.metadata?.executionId,
      value?.chatModel?.executionId,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }

    return undefined;
  }

  private extractModelName(metadata: any): string | undefined {
    const candidates = [
      metadata?.plannerConfig?.modelName,
      metadata?.chatModel?.modelName,
      metadata?.chatModel?.responseModel,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() && !candidate.startsWith('MODEL_PLACEHOLDER_')) {
        return candidate.trim();
      }
    }

    return undefined;
  }

  private requestJson<TResponse>(
    rpcPath: string,
    payload: unknown,
    overrideClientInfo?: LanguageServerClientInfo
  ): Promise<TResponse> {
    const clientInfo = overrideClientInfo ?? this.clientInfo;
    if (!clientInfo) {
      return Promise.reject(new Error('No active Antigravity language server connection.'));
    }

    return new Promise<TResponse>((resolve, reject) => {
      const session = http2.connect(`https://127.0.0.1:${clientInfo.port}`, {
        rejectUnauthorized: false,
      });
      const request = session.request({
        ':method': 'POST',
        ':path': rpcPath,
        'content-type': 'application/json',
        'x-codeium-csrf-token': clientInfo.csrfToken,
      });

      let statusCode = 200;
      const chunks: Buffer[] = [];
      const close = () => {
        try {
          request.close();
        } catch {
          // Best effort only.
        }
        try {
          session.close();
        } catch {
          // Best effort only.
        }
      };

      request.on('response', (headers) => {
        statusCode = Number(headers[':status'] ?? 200);
      });
      request.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        close();

        if (statusCode >= 400) {
          reject(new Error(text || `HTTP ${statusCode}`));
          return;
        }

        try {
          resolve((text ? JSON.parse(text) : {}) as TResponse);
        } catch (error) {
          reject(error);
        }
      });
      request.on('error', (error) => {
        close();
        reject(error);
      });
      session.on('error', (error) => {
        close();
        reject(error);
      });

      request.end(JSON.stringify(payload ?? {}));
    });
  }
}

function frameConnectJson(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const frame = Buffer.allocUnsafe(5 + json.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(json.length, 1);
  json.copy(frame, 5);
  return frame;
}

function extractUserPrompt(userInput: any): string | undefined {
  const itemTexts = Array.isArray(userInput?.items)
    ? userInput.items
      .flatMap((item: any) => {
        if (typeof item?.text === 'string' && item.text.trim()) {
          return [item.text.trim()];
        }
        return [];
      })
    : [];
  const combinedItems = itemTexts.join('\n\n').trim();
  if (combinedItems) {
    return combinedItems;
  }

  if (typeof userInput?.userResponse === 'string' && userInput.userResponse.trim()) {
    return userInput.userResponse.trim();
  }

  return undefined;
}

function extractPlannerResponse(plannerResponse: any): string | undefined {
  const candidates = [
    plannerResponse?.modifiedResponse,
    plannerResponse?.response,
    plannerResponse?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate;
    }
  }

  const typedContent = extractTypedPlannerContent(plannerResponse, 'output');
  if (typedContent) {
    return typedContent;
  }

  return undefined;
}

function extractPlannerThinking(plannerResponse: any): string | undefined {
  const candidates = [
    plannerResponse?.thinking,
    plannerResponse?.reasoning,
    plannerResponse?.reasoningText,
    plannerResponse?.thought,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const typedContent = extractTypedPlannerContent(plannerResponse, 'thinking');
  if (typedContent) {
    return typedContent;
  }

  return undefined;
}

function extractTypedPlannerContent(
  value: any,
  target: 'thinking' | 'output'
): string | undefined {
  const pieces: string[] = [];
  collectTypedPlannerContent(value, target, undefined, pieces, new Set());
  const content = pieces
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return content || undefined;
}

function collectTypedPlannerContent(
  value: any,
  target: 'thinking' | 'output',
  inheritedKind: 'thinking' | 'output' | undefined,
  pieces: string[],
  seen: Set<any>
): void {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value === 'string') {
    if (inheritedKind === target) {
      pieces.push(value);
    }
    return;
  }

  if (typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTypedPlannerContent(item, target, inheritedKind, pieces, seen);
    }
    return;
  }

  const localKind = classifyPlannerContentKind(value) ?? inheritedKind;
  const textFields = target === 'thinking'
    ? ['thinking', 'reasoning', 'reasoningText', 'thought', 'thoughts']
    : ['modifiedResponse', 'response', 'output', 'text', 'content'];

  for (const key of textFields) {
    const fieldValue = value?.[key];
    const fieldKind = localKind ?? classifyPlannerContentKey(key);
    if (typeof fieldValue === 'string' && fieldKind === target) {
      pieces.push(fieldValue);
    }
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    const keyKind = classifyPlannerContentKey(key);
    collectTypedPlannerContent(fieldValue, target, keyKind ?? localKind, pieces, seen);
  }
}

function classifyPlannerContentKind(value: any): 'thinking' | 'output' | undefined {
  const type = String(value?.type ?? value?.kind ?? value?.blockType ?? '').toLowerCase();
  if (/(?:thinking|reasoning|thought)/.test(type)) {
    return 'thinking';
  }
  if (/(?:text|output|response|message|content)/.test(type)) {
    return 'output';
  }
  return undefined;
}

function classifyPlannerContentKey(key: string): 'thinking' | 'output' | undefined {
  const normalized = key.toLowerCase();
  if (/(?:thinking|reasoning|thought)/.test(normalized)) {
    return 'thinking';
  }
  if (/(?:modifiedresponse|response|output|text|content)/.test(normalized)) {
    return 'output';
  }
  return undefined;
}

function classifyAuxiliaryStepType(type: string): 'subagent' | 'editor' | undefined {
  const normalized = type.toLowerCase();
  if (/(?:edit|rewrite|diff|apply|patch)/.test(normalized)) {
    return 'editor';
  }
  if (/(?:subagent|background|tool|terminal|grep|search|lint|command)/.test(normalized)) {
    return 'subagent';
  }
  return undefined;
}

function extractAuxiliaryStepText(step: any): string | undefined {
  const candidates = [
    step?.text,
    step?.response,
    step?.output,
    step?.message,
    step?.toolResponse,
    step?.toolRequest,
    step?.edit,
    step?.diff,
    step?.rewrite,
  ];

  for (const candidate of candidates) {
    const text = readNestedText(candidate);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function readNestedText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const combined = value
      .map((entry) => readNestedText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join('\n\n')
      .trim();
    return combined || undefined;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  for (const key of ['text', 'content', 'message', 'output', 'response', 'diff', 'rewrite', 'patch']) {
    const text = readNestedText((value as Record<string, unknown>)[key]);
    if (text) {
      return text;
    }
  }

  for (const key of ['generatedText', 'insertedText', 'newText', 'replacementText', 'edits', 'changes', 'appliedPatch']) {
    const text = readNestedText((value as Record<string, unknown>)[key]);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function mergeStepText(current: string | undefined, next: string): string {
  if (!current) {
    return next;
  }
  if (current.includes(next)) {
    return current;
  }
  return `${current}\n\n${next}`;
}

function stepTimestamp(metadata: any): number | undefined {
  const candidates = [
    metadata?.completedAt,
    metadata?.finishedGeneratingAt,
    metadata?.viewableAt,
    metadata?.startedAt,
    metadata?.createdAt,
  ];

  for (const candidate of candidates) {
    const parsed = toTimestamp(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

async function loadBrainFallbackSnapshot(
  conversationId: string
): Promise<BrainFallbackSnapshot | undefined> {
  const inputs = await loadBrainSnapshotInputs(conversationId);
  if (!inputs) {
    return undefined;
  }

  return buildBrainFallbackSnapshot(inputs.overviewRaw, inputs.artifactEntries);
}

async function loadBrainFallbackSnapshotForRun(
  conversationId: string,
  run: Pick<ActiveRunState, 'prompt' | 'promptStartedAt' | 'promptStepIndex'>
): Promise<BrainFallbackSnapshot | undefined> {
  const inputs = await loadBrainSnapshotInputs(conversationId);
  if (!inputs) {
    return undefined;
  }

  return buildBrainFallbackSnapshotForRun(inputs.overviewRaw, inputs.artifactEntries, run)
    ?? buildBrainFallbackSnapshot(inputs.overviewRaw, inputs.artifactEntries);
}

async function loadBrainSnapshotInputs(
  conversationId: string
): Promise<{ overviewRaw: string; artifactEntries: BrainArtifactEntry[] } | undefined> {
  const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', conversationId);
  const overviewPath = path.join(brainDir, '.system_generated', 'logs', 'overview.txt');

  const [overviewRaw, brainEntries] = await Promise.all([
    safeReadUtf8(overviewPath),
    safeReadDirEntries(brainDir),
  ]);
  if (!overviewRaw) {
    return undefined;
  }

  const artifactEntries = await loadBrainArtifactEntries(brainDir, brainEntries);

  return { overviewRaw, artifactEntries };
}

async function listRecentBrainConversationIds(limit: number): Promise<string[]> {
  const brainRoot = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const entries = await safeReadDirEntries(brainRoot);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isUuidLike(entry.name))
      .map(async (entry) => {
        const dirPath = path.join(brainRoot, entry.name);
        const stats = await safeStat(dirPath);
        return {
          conversationId: entry.name,
          updatedAt: stats?.mtimeMs ?? 0,
        };
      })
  );

  return candidates
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(0, limit))
    .map((candidate) => candidate.conversationId);
}

function loadBrainFallbackSnapshotSync(
  conversationId: string
): BrainFallbackSnapshot | undefined {
  const inputs = loadBrainSnapshotInputsSync(conversationId);
  if (!inputs) {
    return undefined;
  }

  return buildBrainFallbackSnapshot(inputs.overviewRaw, inputs.artifactEntries);
}

function loadBrainFallbackSnapshotForRunSync(
  conversationId: string,
  run: Pick<ActiveRunState, 'prompt' | 'promptStartedAt' | 'promptStepIndex'>
): BrainFallbackSnapshot | undefined {
  const inputs = loadBrainSnapshotInputsSync(conversationId);
  if (!inputs) {
    return undefined;
  }

  return buildBrainFallbackSnapshotForRun(inputs.overviewRaw, inputs.artifactEntries, run)
    ?? buildBrainFallbackSnapshot(inputs.overviewRaw, inputs.artifactEntries);
}

function loadBrainSnapshotInputsSync(
  conversationId: string
): { overviewRaw: string; artifactEntries: BrainArtifactEntry[] } | undefined {
  const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain', conversationId);
  const overviewPath = path.join(brainDir, '.system_generated', 'logs', 'overview.txt');
  if (!fsSync.existsSync(overviewPath)) {
    return undefined;
  }

  let overviewRaw = '';
  try {
    overviewRaw = fsSync.readFileSync(overviewPath, 'utf8');
  } catch {
    return undefined;
  }

  let brainEntries: fsSync.Dirent[] = [];
  try {
    brainEntries = fsSync.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    brainEntries = [];
  }

  const artifactEntries = loadBrainArtifactEntriesSync(brainDir, brainEntries);

  return { overviewRaw, artifactEntries };
}

function buildBrainFallbackSnapshot(
  overviewRaw: string,
  artifactEntries: BrainArtifactEntry[]
): BrainFallbackSnapshot | undefined {
  const steps = coalesceOverviewLogEntries(parseOverviewLogEntries(overviewRaw));
  const range = findLastOverviewTurnRange(steps);
  if (!range) {
    return undefined;
  }

  return buildBrainFallbackSnapshotFromTurnRange(range, artifactEntries);
}

async function loadBrainArtifactEntries(
  brainDir: string,
  brainEntries: fsSync.Dirent[]
): Promise<BrainArtifactEntry[]> {
  const groups = new Map<string, string[]>();
  for (const entry of brainEntries) {
    if (
      !entry.isFile()
      || entry.name.startsWith('.')
      || entry.name.endsWith('.metadata.json')
      || !isBrainSnapshotContentArtifactFile(entry.name)
    ) {
      continue;
    }

    const baseName = toBrainSnapshotBaseName(entry.name);
    const existing = groups.get(baseName) ?? [];
    existing.push(path.join(brainDir, entry.name));
    groups.set(baseName, existing);
  }

  return Promise.all(
    [...groups.entries()].map(async ([baseName, contentPaths]) => {
      const candidates = await Promise.all(
        contentPaths.map(async (filePath) => ({
          filePath,
          fileName: path.basename(filePath),
          stats: await safeStat(filePath),
        }))
      );
      const currentCandidate = candidates
        .sort((left, right) => {
          const mtimeDiff = (right.stats?.mtimeMs ?? 0) - (left.stats?.mtimeMs ?? 0);
          if (mtimeDiff !== 0) {
            return mtimeDiff;
          }

          return brainResolvedVariantPriority(right.fileName) - brainResolvedVariantPriority(left.fileName);
        })[0];
      const content = await safeReadUtf8(currentCandidate?.filePath ?? '');
      return {
        baseName,
        filePath: currentCandidate?.filePath ?? path.join(brainDir, baseName),
        content: normalizeBrainFallbackText(content),
        updatedAt: currentCandidate?.stats?.mtimeMs ?? 0,
      };
    })
  );
}

function loadBrainArtifactEntriesSync(
  brainDir: string,
  brainEntries: fsSync.Dirent[]
): BrainArtifactEntry[] {
  const groups = new Map<string, string[]>();
  for (const entry of brainEntries) {
    if (
      !entry.isFile()
      || entry.name.startsWith('.')
      || entry.name.endsWith('.metadata.json')
      || !isBrainSnapshotContentArtifactFile(entry.name)
    ) {
      continue;
    }

    const baseName = toBrainSnapshotBaseName(entry.name);
    const existing = groups.get(baseName) ?? [];
    existing.push(path.join(brainDir, entry.name));
    groups.set(baseName, existing);
  }

  return [...groups.entries()].map(([baseName, contentPaths]) => {
    const currentCandidate = contentPaths
      .map((filePath) => {
        let stats: fsSync.Stats | undefined;
        try {
          stats = fsSync.statSync(filePath);
        } catch {
          stats = undefined;
        }

        return {
          filePath,
          fileName: path.basename(filePath),
          stats,
        };
      })
      .sort((left, right) => {
        const mtimeDiff = (right.stats?.mtimeMs ?? 0) - (left.stats?.mtimeMs ?? 0);
        if (mtimeDiff !== 0) {
          return mtimeDiff;
        }

        return brainResolvedVariantPriority(right.fileName) - brainResolvedVariantPriority(left.fileName);
      })[0];

    let content = '';
    try {
      content = fsSync.readFileSync(currentCandidate?.filePath ?? '', 'utf8');
    } catch {
      content = '';
    }

    return {
      baseName,
      filePath: currentCandidate?.filePath ?? path.join(brainDir, baseName),
      content: normalizeBrainFallbackText(content),
      updatedAt: currentCandidate?.stats?.mtimeMs ?? 0,
    };
  });
}

function buildBrainFallbackSnapshotForRun(
  overviewRaw: string,
  artifactEntries: BrainArtifactEntry[],
  run: Pick<ActiveRunState, 'prompt' | 'promptStartedAt' | 'promptStepIndex'>
): BrainFallbackSnapshot | undefined {
  const normalizedPrompt = normalizeBrainFallbackText(run.prompt);
  const promptStartedAt = run.promptStartedAt ?? 0;
  if (!normalizedPrompt || !promptStartedAt) {
    return undefined;
  }

  const steps = coalesceOverviewLogEntries(parseOverviewLogEntries(overviewRaw));
  if (steps.length === 0 && artifactEntries.length === 0) {
    return undefined;
  }
  const range = findOverviewTurnRangeForRun(steps, run);
  if (!range) {
    return undefined;
  }

  const snapshot = buildBrainFallbackSnapshotFromTurnRange(range, artifactEntries);
  if (!snapshot) {
    return undefined;
  }

  return {
    ...snapshot,
    prompt: snapshot.prompt || normalizedPrompt,
    promptStartedAt: snapshot.promptStartedAt ?? promptStartedAt,
    promptStepIndex: snapshot.promptStepIndex ?? run.promptStepIndex,
    updatedAt: snapshot.updatedAt ?? (promptStartedAt || undefined),
  };
}

function parseOverviewLogEntries(overviewRaw: string): OverviewLogEntry[] {
  return overviewRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return [{
          stepIndex: typeof parsed.step_index === 'number' && Number.isFinite(parsed.step_index)
            ? parsed.step_index
            : undefined,
          source: typeof parsed.source === 'string' ? parsed.source : undefined,
          type: typeof parsed.type === 'string' ? parsed.type : undefined,
          status: typeof parsed.status === 'string' ? parsed.status : undefined,
          createdAt: toTimestamp(parsed.created_at),
          content: typeof parsed.content === 'string' ? parsed.content : undefined,
          toolCalls: Array.isArray(parsed.tool_calls)
            ? parsed.tool_calls
              .filter((toolCall): toolCall is { name?: string; args?: Record<string, unknown> } =>
                Boolean(toolCall) && typeof toolCall === 'object'
              )
            : [],
        }];
      } catch {
        return [];
      }
    });
}

function coalesceOverviewLogEntries(entries: OverviewLogEntry[]): OverviewLogEntry[] {
  const order: string[] = [];
  const coalesced = new Map<string, OverviewLogEntry>();

  entries.forEach((entry, index) => {
    const key = Number.isFinite(entry.stepIndex)
      ? `step:${entry.stepIndex}`
      : `entry:${index}`;
    const previous = coalesced.get(key);
    if (!previous) {
      order.push(key);
    }

    coalesced.set(key, {
      stepIndex: entry.stepIndex ?? previous?.stepIndex,
      source: entry.source ?? previous?.source,
      type: entry.type ?? previous?.type,
      status: entry.status ?? previous?.status,
      createdAt: Math.max(entry.createdAt ?? 0, previous?.createdAt ?? 0) || entry.createdAt || previous?.createdAt,
      content: entry.content ?? previous?.content,
      toolCalls: entry.toolCalls.length > 0
        ? entry.toolCalls
        : previous?.toolCalls ?? [],
    });
  });

  return order
    .map((key) => coalesced.get(key))
    .filter((entry): entry is OverviewLogEntry => Boolean(entry));
}

interface OverviewTurnRange {
  promptStep: OverviewLogEntry;
  turnSteps: OverviewLogEntry[];
  nextPromptStartedAt?: number;
}

function findLastOverviewTurnRange(
  steps: OverviewLogEntry[]
): OverviewTurnRange | undefined {
  const ranges = collectOverviewTurnRanges(steps);
  return ranges.length > 0 ? ranges[ranges.length - 1] : undefined;
}

function findOverviewTurnRangeForRun(
  steps: OverviewLogEntry[],
  run: Pick<ActiveRunState, 'prompt' | 'promptStartedAt' | 'promptStepIndex'>
): OverviewTurnRange | undefined {
  const ranges = collectOverviewTurnRanges(steps);
  if (ranges.length === 0) {
    return undefined;
  }

  if (run.promptStepIndex !== undefined) {
    const stepIndexMatch = ranges.find((range) => range.promptStep.stepIndex === run.promptStepIndex);
    if (stepIndexMatch) {
      return stepIndexMatch;
    }
  }

  const normalizedPrompt = normalizeBrainFallbackText(run.prompt).toLowerCase();
  const promptStartedAt = run.promptStartedAt ?? 0;
  const matchingRanges = ranges.filter((range) => {
    const stepPrompt = extractOverviewPrompt(range.promptStep.content);
    return Boolean(stepPrompt) && promptsMatch(normalizedPrompt, stepPrompt ?? '');
  });

  if (matchingRanges.length === 1) {
    return matchingRanges[0];
  }

  if (matchingRanges.length > 1 && promptStartedAt > 0) {
    return matchingRanges.reduce((best, candidate) => {
      const bestDistance = Math.abs((best.promptStep.createdAt ?? 0) - promptStartedAt);
      const candidateDistance = Math.abs((candidate.promptStep.createdAt ?? 0) - promptStartedAt);
      return candidateDistance < bestDistance ? candidate : best;
    });
  }

  if (matchingRanges.length > 1) {
    return matchingRanges[matchingRanges.length - 1];
  }

  if (promptStartedAt > 0) {
    const timeMatch = ranges.find((range) =>
      Math.abs((range.promptStep.createdAt ?? 0) - promptStartedAt) <= 5_000
    );
    if (timeMatch) {
      return timeMatch;
    }
  }

  return undefined;
}

function collectOverviewTurnRanges(
  steps: OverviewLogEntry[]
): OverviewTurnRange[] {
  const userInputIndexes = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.type === 'USER_INPUT' && step.source?.startsWith('USER'));

  return userInputIndexes.map(({ step, index }, position) => {
    const nextUserInputIndex = userInputIndexes[position + 1]?.index;
    return {
      promptStep: step,
      turnSteps: steps.slice(index + 1, nextUserInputIndex),
      nextPromptStartedAt: nextUserInputIndex !== undefined
        ? steps[nextUserInputIndex]?.createdAt
        : undefined,
    };
  });
}

function buildBrainFallbackSnapshotFromTurnRange(
  range: OverviewTurnRange,
  artifactEntries: BrainArtifactEntry[]
): BrainFallbackSnapshot | undefined {
  const prompt = extractOverviewPrompt(range.promptStep.content);
  let thinking = '';
  let editor = '';
  let output = '';
  let updatedAt = range.promptStep.createdAt ?? 0;
  const referencedArtifactPaths = new Set<string>();
  const artifactTimeFloor = Math.max(0, (range.promptStep.createdAt ?? 0) - 2_000);
  const artifactTimeCeiling = range.nextPromptStartedAt !== undefined
    ? range.nextPromptStartedAt + 2_000
    : undefined;

  for (const step of range.turnSteps) {
    updatedAt = Math.max(updatedAt, step.createdAt ?? 0);
    if (step.type !== 'PLANNER_RESPONSE' || step.status !== 'DONE') {
      continue;
    }

    const stepContent = normalizeBrainFallbackText(step.content);
    if (stepContent) {
      output = mergeStepText(output, stepContent);
    }

    for (const toolCall of step.toolCalls) {
      for (const target of resolveOverviewToolCallTarget(toolCall)) {
        referencedArtifactPaths.add(target.filePath);
      }

      if (classifyOverviewToolCall(toolCall) === 'editor') {
        const toolText = buildOverviewToolCallText(toolCall);
        if (toolText) {
          editor = mergeStepText(editor, toolText);
        }
        continue;
      }

      const toolText = buildOverviewThinkingText(toolCall);
      if (toolText) {
        thinking = mergeStepText(thinking, toolText);
      }
    }
  }

  const relevantArtifacts = artifactEntries
    .filter((artifact) =>
      artifact.updatedAt >= artifactTimeFloor
      && (artifactTimeCeiling === undefined || artifact.updatedAt < artifactTimeCeiling)
    )
    .sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return left.updatedAt - right.updatedAt;
      }

      return left.baseName.localeCompare(right.baseName);
    });
  const targetedArtifacts = relevantArtifacts.filter((artifact) => referencedArtifactPaths.has(artifact.filePath));
  const artifactsToMerge = targetedArtifacts.length > 0 ? targetedArtifacts : relevantArtifacts;
  for (const artifact of artifactsToMerge) {
    updatedAt = Math.max(updatedAt, artifact.updatedAt);
    if (!artifact.content) {
      continue;
    }

    if (classifyBrainFallbackArtifact(artifact.baseName, artifact.filePath) === 'thinking') {
      thinking = mergeStepText(thinking, artifact.content);
      continue;
    }

    output = mergeStepText(output, artifact.content);
  }

  const normalizedPrompt = normalizeBrainFallbackText(prompt);
  const normalizedThinking = normalizeBrainFallbackText(thinking);
  const normalizedEditor = normalizeBrainFallbackText(editor);
  const normalizedOutput = normalizeBrainFallbackText(output);
  if (!normalizedPrompt && !normalizedThinking && !normalizedEditor && !normalizedOutput) {
    return undefined;
  }

  return {
    prompt: normalizedPrompt || undefined,
    promptStartedAt: range.promptStep.createdAt,
    promptStepIndex: range.promptStep.stepIndex,
    thinking: normalizedThinking || undefined,
    editor: normalizedEditor || undefined,
    output: normalizedOutput || undefined,
    updatedAt: updatedAt || undefined,
  };
}

function isBrainSnapshotContentArtifactFile(fileName: string): boolean {
  return /\.(md|txt)(?:\.resolved(?:\.\d+)?)?$/i.test(fileName);
}

function toBrainSnapshotBaseName(fileName: string): string {
  return fileName.replace(/\.resolved(?:\.\d+)?$/i, '');
}

function brainResolvedVariantPriority(fileName: string): number {
  if (/\.resolved\.\d+$/i.test(fileName)) {
    return 2;
  }
  if (/\.resolved$/i.test(fileName)) {
    return 1;
  }
  return 0;
}

function extractOverviewPrompt(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }

  const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match?.[1]) {
    return normalizeBrainFallbackText(match[1]);
  }

  return normalizeBrainFallbackText(content);
}

function promptsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeBrainFallbackText(left).toLowerCase();
  const normalizedRight = normalizeBrainFallbackText(right).toLowerCase();
  return Boolean(normalizedLeft)
    && Boolean(normalizedRight)
    && (
      normalizedLeft === normalizedRight
      || normalizedLeft.includes(normalizedRight)
      || normalizedRight.includes(normalizedLeft)
    );
}

function resolveOverviewToolCallTarget(
  toolCall: { name?: string; args?: Record<string, unknown> }
): Array<{ filePath: string }> {
  if (!toolCall?.args || typeof toolCall.args !== 'object') {
    return [];
  }

  const candidates = [
    toolCall.args.TargetFile,
    toolCall.args.AbsolutePath,
    toolCall.args.FilePath,
    toolCall.args.Path,
  ];

  return candidates
    .map((candidate) => decodeOverviewScalar(candidate))
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((filePath) => ({ filePath }));
}

function classifyOverviewToolCall(
  toolCall: { name?: string; args?: Record<string, unknown> }
): 'editor' | undefined {
  if (!toolCall?.name) {
    return undefined;
  }

  if (isOverviewBrainArtifactToolCall(toolCall)) {
    return undefined;
  }

  const normalized = toolCall.name.toLowerCase();
  if (/(?:replace|rewrite|edit|patch|diff|apply|update|modify|write|append)/.test(normalized)) {
    return 'editor';
  }

  return undefined;
}

function isOverviewBrainArtifactToolCall(
  toolCall: { name?: string; args?: Record<string, unknown> }
): boolean {
  const args = toolCall.args ?? {};
  if (decodeOverviewBoolean(args.IsArtifact)) {
    return true;
  }

  return resolveOverviewToolCallTarget(toolCall)
    .some((target) => target.filePath.toLowerCase().includes('/.gemini/antigravity/brain/'));
}

function buildOverviewToolCallText(
  toolCall: { name?: string; args?: Record<string, unknown> }
): string | undefined {
  const args = toolCall.args ?? {};
  const parts: string[] = [];
  const targetFile = resolveOverviewToolCallTarget(toolCall)[0]?.filePath;

  if (toolCall.name) {
    parts.push(toolCall.name);
  }
  if (targetFile) {
    parts.push(targetFile);
  }

  for (const key of [
    'Instruction',
    'Description',
    'toolAction',
    'toolSummary',
    'ReplacementContent',
    'CodeContent',
    'NewContent',
    'TargetContent',
    'Patch',
    'Diff',
    'Content',
  ]) {
    const value = decodeOverviewScalar(args[key]);
    if (value) {
      parts.push(value);
    }
  }

  const content = parts
    .map((part) => normalizeBrainFallbackText(part))
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return content || undefined;
}

function buildOverviewThinkingText(
  toolCall: { name?: string; args?: Record<string, unknown> }
): string | undefined {
  if (isOverviewBrainArtifactToolCall(toolCall)) {
    return undefined;
  }

  const args = toolCall.args ?? {};
  const parts: string[] = [];
  const displayPath = resolveOverviewToolCallTarget(toolCall)[0]?.filePath;

  if (toolCall.name) {
    parts.push(toolCall.name);
  }

  for (const key of ['toolSummary', 'toolAction', 'Instruction', 'Description']) {
    const value = decodeOverviewScalar(args[key]);
    if (value) {
      parts.push(value);
    }
  }

  if (displayPath) {
    parts.push(displayPath);
  }

  const content = parts
    .map((part) => normalizeBrainFallbackText(part))
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return content || undefined;
}

function decodeOverviewScalar(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      // Fall through to plain-string handling.
    }
  }

  return trimmed;
}

function decodeOverviewBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  const decoded = decodeOverviewScalar(value);
  return decoded?.toLowerCase() === 'true';
}

function classifyBrainFallbackArtifact(
  baseName: string,
  filePath: string
): 'thinking' | 'output' {
  const normalizedBaseName = baseName.toLowerCase();
  const normalizedPath = filePath.toLowerCase();
  if (
    normalizedBaseName.includes('plan')
    || normalizedPath.includes('implementation_plan')
  ) {
    return 'thinking';
  }

  return 'output';
}

function normalizeBrainFallbackText(value: string | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').trim();
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function safeReadUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function safeReadDirEntries(dirPath: string): Promise<fsSync.Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(filePath: string): Promise<fsSync.Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}

function buildCountedStepKey(step: any): string | undefined {
  const metadata = step?.metadata ?? {};
  const sourceInfo = metadata?.sourceTrajectoryStepInfo ?? {};
  const stepIndex = sourceInfo?.stepIndex;
  const metadataIndex = sourceInfo?.metadataIndex;
  const executionId = metadata?.executionId ?? step?.executionId;
  const type = typeof step?.type === 'string' ? step.type : '';

  if (!type || typeof executionId !== 'string' || !executionId.trim()) {
    return undefined;
  }

  const indexLabel = [
    Number.isFinite(stepIndex) ? String(stepIndex) : 'step',
    Number.isFinite(metadataIndex) ? String(metadataIndex) : '0',
  ].join(':');

  return `${executionId}:${type}:${indexLabel}`;
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function estimateTextTokenCount(value: string | undefined): number {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.round(normalized.length / 4));
}

function emptyStepTokenContribution(): StepTokenContribution {
  return {
    thinkingTokens: 0,
    subagentTokens: 0,
    editorTokens: 0,
    outputTokens: 0,
  };
}

function stepTokenContributionEquals(
  left: StepTokenContribution,
  right: StepTokenContribution
): boolean {
  return left.thinkingTokens === right.thinkingTokens
    && left.subagentTokens === right.subagentTokens
    && left.editorTokens === right.editorTokens
    && left.outputTokens === right.outputTokens;
}

function dedupeSearchConversationResults(
  results: SearchConversationResult[]
): SearchConversationResult[] {
  const seen = new Set<string>();
  const deduped: SearchConversationResult[] = [];

  for (const result of results) {
    const cascadeId = typeof result?.cascadeId === 'string'
      ? result.cascadeId.trim()
      : '';
    if (!cascadeId || seen.has(cascadeId)) {
      continue;
    }

    seen.add(cascadeId);
    deduped.push(result);
  }

  return deduped;
}

function sanitizeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function sanitizeSnippet(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}
