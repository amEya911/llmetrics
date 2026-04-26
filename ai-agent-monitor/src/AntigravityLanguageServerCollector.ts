import * as http2 from 'http2';
import { execFile as execFileCallback } from 'child_process';
import { promises as fs } from 'fs';
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
  source: 'runtime' | 'logs' | 'process-log';
  discoveredAt: number;
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
  capturedTokenUsage: Required<Pick<CapturedTokenUsage, 'thinkingTokens' | 'subagentTokens' | 'editorTokens' | 'outputTokens'>>;
  countedStepKeys: Set<string>;
}

interface StreamState {
  conversationId: string;
  session: http2.ClientHttp2Session;
  request: http2.ClientHttp2Stream;
  buffer: Buffer;
  receivedData: boolean;
}

interface LogCandidate {
  csrfToken: string;
  port: number;
  discoveredAt: number;
  source?: 'logs' | 'process-log';
}

interface ProcessCandidate {
  pid: number;
  csrfToken: string;
  discoveredAt: number;
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
  private discoveryInFlight = false;
  private searchInFlight = false;

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
      return;
    }

    this.searchInFlight = true;
    try {
      await this.refreshConversationSearch();
    } finally {
      this.searchInFlight = false;
    }
  }

  private async validateOrRediscoverClientInfo(): Promise<void> {
    if (this.clientInfo) {
      try {
        await this.requestJson(HEARTBEAT_PATH, {});
        this.lastDiscoveryAt = Date.now();
        return;
      } catch {
        this.clientInfo = undefined;
      }
    }

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

    const logCandidates = await this.readLogCandidates();
    for (const candidate of logCandidates) {
      candidates.push({
        ...candidate,
        source: candidate.source ?? 'logs',
      });
    }

    const deduped = new Map<string, LanguageServerClientInfo>();
    for (const candidate of candidates) {
      deduped.set(`${candidate.port}:${candidate.csrfToken}`, candidate);
    }

    return [...deduped.values()]
      .sort((left, right) => right.discoveredAt - left.discoveredAt);
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

  private async readLogCandidates(): Promise<LogCandidate[]> {
    const roots = [
      path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'logs'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Anti-Gravity', 'logs'),
      path.join(os.homedir(), '.config', 'Antigravity', 'logs'),
      path.join(os.homedir(), '.config', 'Anti-Gravity', 'logs'),
    ];

    const processCandidates = await this.readProcessCandidates();
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
        candidates.push(...await this.readExthostCandidates(exthostPath, processCandidates));
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
        if (!csrfToken) {
          continue;
        }

        candidates.set(pid, {
          pid,
          csrfToken,
          discoveredAt: now,
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

    const results = Array.isArray(response.results) ? response.results : [];
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

    for (const result of chosenResults) {
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
    for (const result of chosenResults.slice(0, 1)) {
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
    };

    this.activeStreams.set(conversationId, streamState);

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
      streamState.buffer = Buffer.concat([streamState.buffer, buffer]);
      streamState.buffer = this.consumeConnectEnvelopes(streamState.buffer, (message) => {
        this.handleStreamMessage(conversationId, message);
      });
    });

    const finish = (error?: unknown) => {
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

    run.completed = true;
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
      countedStepKeys: new Set<string>(),
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
    if (!stepKey || run.countedStepKeys.has(stepKey)) {
      return false;
    }

    const metadata = step?.metadata ?? {};
    let changed = false;

    if (kind === 'primary') {
      const usage = metadata?.modelUsage ?? {};
      const totalOutputTokens = toNumber(usage?.outputTokens) ?? 0;
      const thinkingTokens = toNumber(usage?.thinkingOutputTokens) ?? 0;
      const responseTokens = toNumber(usage?.responseOutputTokens);
      const outputTokens = responseTokens ?? Math.max(0, totalOutputTokens - thinkingTokens);

      if (thinkingTokens > 0 || outputTokens > 0) {
        run.capturedTokenUsage.thinkingTokens += thinkingTokens;
        run.capturedTokenUsage.outputTokens += outputTokens;
        changed = true;
      }
    } else {
      const toolTokens = toNumber(metadata?.toolCallOutputTokens) ?? 0;
      if (toolTokens > 0) {
        if (kind === 'editor') {
          run.capturedTokenUsage.editorTokens += toolTokens;
        } else {
          run.capturedTokenUsage.subagentTokens += toolTokens;
        }
        changed = true;
      }
    }

    if (changed) {
      run.countedStepKeys.add(stepKey);
    }

    return changed;
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
