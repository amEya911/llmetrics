import * as http2 from 'http2';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatError } from './stateSqlite';
import { ModelConfidence } from './types';

const HEARTBEAT_PATH = '/exa.language_server_pb.LanguageServerService/Heartbeat';
const SEARCH_CONVERSATIONS_PATH = '/exa.language_server_pb.LanguageServerService/SearchConversations';
const STREAM_AGENT_STATE_UPDATES_PATH = '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates';

const DISCOVERY_INTERVAL_MS = 2_000;
const SEARCH_INTERVAL_MS = 3_000;
const STREAM_RETRY_MS = 3_000;
const CONNECT_END_STREAM_FLAG = 0x02;

interface CollectorOptions {
  output: vscode.OutputChannel;
  getWorkspacePaths: () => string[];
  getPreferredConversationId?: () => string | undefined;
}

interface LanguageServerClientInfo {
  csrfToken: string;
  port: number;
  source: 'runtime' | 'logs';
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
  output?: string;
  model?: string;
  modelConfidence: ModelConfidence;
  title?: string;
  subtitle?: string;
  contextUsagePercent?: number;
  contextWindowTokens?: number;
  startedEmitted: boolean;
  completed: boolean;
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
  output?: string;
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
        source: 'logs',
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

    const candidates: LogCandidate[] = [];
    for (const root of roots) {
      let entries: string[];
      try {
        entries = await fs.readdir(root);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const logPath = path.join(root, entry, 'ls-main.log');
        let raw: string;
        let stats;
        try {
          [raw, stats] = await Promise.all([
            fs.readFile(logPath, 'utf8'),
            fs.stat(logPath),
          ]);
        } catch {
          continue;
        }

        const csrfToken = raw.match(/Args:\s+.*--csrf_token\s+([a-f0-9-]+)/i)?.[1];
        const portMatches = [...raw.matchAll(/(?:LS started on port|listening on random port at)\s+(\d+)\s+for HTTPS|LS started on port\s+(\d+)/gi)];
        const port = [...portMatches]
          .map((match) => Number(match[1] ?? match[2]))
          .filter((value) => Number.isFinite(value) && value > 0)
          .pop();

        if (!csrfToken || !port) {
          continue;
        }

        candidates.push({
          csrfToken,
          port,
          discoveredAt: stats.mtimeMs,
        });
      }
    }

    return candidates
      .sort((left, right) => right.discoveredAt - left.discoveredAt);
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
          output: run.output,
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

    if (type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      return;
    }

    const output = extractPlannerResponse(step?.plannerResponse);
    const updatedAt = stepTimestamp(step?.metadata) ?? Date.now();
    const isComplete = status === 'CORTEX_STEP_STATUS_DONE';

    if (!run.startedEmitted && run.prompt) {
      run.startedEmitted = true;
      this._onTurnStart.fire({
        conversationId,
        executionId,
        prompt: run.prompt,
        startedAt: run.promptStartedAt ?? updatedAt,
        title: run.title,
        subtitle: run.subtitle,
        model: run.model,
        modelConfidence: run.modelConfidence,
        contextUsagePercent: run.contextUsagePercent,
        contextWindowTokens: run.contextWindowTokens,
      });
    }

    const changedOutput = output !== undefined && output !== run.output;
    const completionChanged = isComplete && !run.completed;
    if (!changedOutput && !completionChanged) {
      return;
    }

    if (output !== undefined) {
      run.output = output;
    }
    run.completed = run.completed || isComplete;

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
      output: run.output,
      isComplete: run.completed,
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
    };
    this.runStates.set(key, next);
    return next;
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
