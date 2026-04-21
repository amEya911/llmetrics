/* eslint-disable @typescript-eslint/no-var-requires */
import type * as httpTypes from 'http';
import type * as httpsTypes from 'https';

// Use require() so the bundled module bindings stay mutable at runtime.
const http: typeof httpTypes = require('http');
const https: typeof httpsTypes = require('https');
const zlib: typeof import('zlib') = require('zlib');
import * as vscode from 'vscode';
import { ModelConfidence } from './types';

export const NETWORK_INTERCEPTOR_IGNORE_HEADER = 'x-ai-token-analytics-origin';
export const NETWORK_INTERCEPTOR_IGNORE_VALUE = 'extension';

const WRAPPED_RESPONSE = Symbol('ai-token-analytics.network-response');

interface InterceptedTurnStart {
  requestId: string;
  provider: string;
  url: string;
  prompt: string;
  model?: string;
  modelConfidence: ModelConfidence;
  chatId?: string;
  startedAt: number;
  isStreaming: boolean;
}

interface InterceptedTurnChunk {
  requestId: string;
  provider: string;
  kind: 'agent-thinking' | 'agent-output';
  content: string;
}

interface InterceptedTurnComplete {
  requestId: string;
  provider: string;
  url: string;
  prompt: string;
  model?: string;
  modelConfidence: ModelConfidence;
  chatId?: string;
  startedAt: number;
  completedAt: number;
  thinking: string;
  output: string;
}

interface ParsedRequestPayload {
  prompt?: string;
  model?: string;
  modelConfidence: ModelConfidence;
  chatId?: string;
  isStreaming: boolean;
}

interface ResponsePiece {
  kind: 'agent-thinking' | 'agent-output';
  content: string;
}

interface InterceptedRequestState extends InterceptedTurnStart {
  thinking: string;
  output: string;
  didComplete: boolean;
}

interface NormalizedRequestDetails {
  url: string;
  headers: Record<string, string>;
}

interface DecodedChunkObserver {
  onData(chunk: Buffer): void;
  onEnd(): void;
  onClose(): void;
  onError(): void;
}

/**
 * NetworkInterceptor observes outgoing AI API traffic from the Antigravity
 * extension host without mutating the payloads that the caller sees.
 *
 * The interceptor is intentionally passive:
 * - request bodies are mirrored by patching req.write / req.end
 * - responses are mirrored by wrapping IncomingMessage.emit so we never add
 *   listeners that could change stream timing for the real caller
 * - fetch responses are cloned before being read
 */
export class NetworkInterceptor implements vscode.Disposable {
  private readonly _onTurnStart = new vscode.EventEmitter<InterceptedTurnStart>();
  readonly onTurnStart = this._onTurnStart.event;

  private readonly _onTurnChunk = new vscode.EventEmitter<InterceptedTurnChunk>();
  readonly onTurnChunk = this._onTurnChunk.event;

  private readonly _onTurnComplete = new vscode.EventEmitter<InterceptedTurnComplete>();
  readonly onTurnComplete = this._onTurnComplete.event;

  private readonly originalHttpsRequest: typeof httpsTypes.request;
  private readonly originalHttpsGet: typeof httpsTypes.get;
  private readonly originalHttpRequest: typeof httpTypes.request;
  private readonly originalHttpGet: typeof httpTypes.get;
  private readonly originalFetch?: typeof globalThis.fetch;

  private readonly activeRequests = new Map<string, InterceptedRequestState>();
  private active = false;
  private requestCounter = 0;

  private readonly AI_ENDPOINTS: Array<{ pattern: RegExp; provider: string }> = [
    { pattern: /generativelanguage\.googleapis\.com/i, provider: 'Gemini' },
    { pattern: /aiplatform\.googleapis\.com/i, provider: 'Vertex AI' },
    { pattern: /api\.openai\.com/i, provider: 'OpenAI' },
    { pattern: /api\.anthropic\.com/i, provider: 'Anthropic' },
    { pattern: /api\.cohere\.ai/i, provider: 'Cohere' },
    { pattern: /api\.mistral\.ai/i, provider: 'Mistral' },
    { pattern: /api\.together\.ai/i, provider: 'Together' },
    { pattern: /api\.groq\.com/i, provider: 'Groq' },
    { pattern: /api\.fireworks\.ai/i, provider: 'Fireworks' },
    { pattern: /api\.deepseek\.com/i, provider: 'DeepSeek' },
    { pattern: /api\.perplexity\.ai/i, provider: 'Perplexity' },
    { pattern: /localhost.*\/(v1|api)\/(chat|completions|generate)/i, provider: 'Local LLM' },
    { pattern: /127\.0\.0\.1.*\/(v1|api)\/(chat|completions|generate)/i, provider: 'Local LLM' },
  ];

  constructor() {
    this.originalHttpsRequest = https.request;
    this.originalHttpsGet = https.get;
    this.originalHttpRequest = http.request;
    this.originalHttpGet = http.get;

    if (typeof globalThis.fetch === 'function') {
      this.originalFetch = globalThis.fetch.bind(globalThis);
    }
  }

  start(): void {
    if (this.active) {
      return;
    }

    this.active = true;
    this.patchModule(https, this.originalHttpsRequest, this.originalHttpsGet, 'https');
    this.patchModule(http, this.originalHttpRequest, this.originalHttpGet, 'http');
    this.patchFetch();
  }

  stop(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    (https as any).request = this.originalHttpsRequest;
    (https as any).get = this.originalHttpsGet;
    (http as any).request = this.originalHttpRequest;
    (http as any).get = this.originalHttpGet;

    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
    }

    this.activeRequests.clear();
  }

  dispose(): void {
    this.stop();
    this._onTurnStart.dispose();
    this._onTurnChunk.dispose();
    this._onTurnComplete.dispose();
  }

  private patchModule(
    mod: any,
    originalRequest: Function,
    originalGet: Function,
    protocol: 'http' | 'https'
  ): void {
    const self = this;

    mod.request = function (...args: any[]): httpTypes.ClientRequest {
      const req: httpTypes.ClientRequest = originalRequest.apply(this, args as any);
      try {
        self.interceptOutgoingRequest(req, args, protocol);
      } catch {
        // Never interfere with the caller.
      }
      return req;
    };

    mod.get = function (...args: any[]): httpTypes.ClientRequest {
      const req: httpTypes.ClientRequest = originalGet.apply(this, args as any);
      try {
        self.interceptOutgoingRequest(req, args, protocol);
      } catch {
        // Never interfere with the caller.
      }
      return req;
    };
  }

  private patchFetch(): void {
    if (typeof globalThis.fetch !== 'function' || !this.originalFetch) {
      return;
    }

    const self = this;
    const originalFetch = this.originalFetch;

    globalThis.fetch = (async function (input: any, init?: any): Promise<Response> {
      const intercepted = await self.captureFetchRequest(input, init);
      let response: Response;

      try {
        response = await originalFetch(input, init);
      } catch (error) {
        if (intercepted) {
          self.completeRequest(intercepted.requestId);
        }
        throw error;
      }

      if (intercepted) {
        try {
          await self.observeFetchResponse(intercepted.requestId, response.clone(), intercepted.isStreaming);
        } catch {
          self.completeRequest(intercepted.requestId);
        }
      }

      return response;
    }) as typeof globalThis.fetch;
  }

  private interceptOutgoingRequest(
    req: httpTypes.ClientRequest,
    args: any[],
    protocol: 'http' | 'https'
  ): void {
    const details = this.extractRequestDetails(args, protocol);
    const endpoint = this.matchEndpoint(details.url);
    if (!endpoint || this.shouldIgnoreRequest(details.headers)) {
      return;
    }

    const bodyChunks: Buffer[] = [];
    let requestId: string | undefined;

    const originalWrite = req.write;
    req.write = ((chunk: any, ...rest: any[]): boolean => {
      try {
        if (chunk !== undefined && chunk !== null) {
          bodyChunks.push(this.toBuffer(chunk));
        }
      } catch {
        // Ignore malformed chunks.
      }

      return (originalWrite as any).apply(req, [chunk, ...rest]);
    }) as typeof req.write;

    const originalEnd = req.end;
    req.end = ((...endArgs: any[]): any => {
      try {
        const first = endArgs[0];
        if (first !== undefined && first !== null && typeof first !== 'function') {
          bodyChunks.push(this.toBuffer(first));
        }

        const requestBody = Buffer.concat(bodyChunks).toString('utf8');
        const registered = this.registerRequest(endpoint.provider, details.url, details.headers, requestBody);
        requestId = registered?.requestId;
      } catch {
        // Never break the request lifecycle.
      }

      return (originalEnd as any).apply(req, endArgs);
    }) as typeof req.end;

    req.once('response', (res: httpTypes.IncomingMessage) => {
      if (!requestId) {
        return;
      }

      try {
        this.observeHttpResponse(res, requestId);
      } catch {
        this.completeRequest(requestId);
      }
    });

    req.once('error', () => {
      if (requestId) {
        this.completeRequest(requestId);
      }
    });
  }

  private async captureFetchRequest(
    input: any,
    init?: any
  ): Promise<{ requestId: string; isStreaming: boolean } | undefined> {
    const url = this.extractFetchUrl(input);
    const endpoint = this.matchEndpoint(url);
    if (!endpoint) {
      return undefined;
    }

    const headers = await this.extractFetchHeaders(input, init);
    if (this.shouldIgnoreRequest(headers)) {
      return undefined;
    }

    const body = await this.readFetchBody(input, init);
    const registered = this.registerRequest(endpoint.provider, url, headers, body);
    if (!registered) {
      return undefined;
    }

    return {
      requestId: registered.requestId,
      isStreaming: registered.isStreaming,
    };
  }

  private async observeFetchResponse(
    requestId: string,
    response: Response,
    isStreamingHint: boolean
  ): Promise<void> {
    const contentType = response.headers.get('content-type') || '';
    const isStreaming = isStreamingHint
      || /text\/event-stream/i.test(contentType)
      || /stream/i.test(contentType)
      || /ndjson/i.test(contentType);

    if (!isStreaming) {
      const body = await response.text();
      const pieces = this.extractResponsePieces(body);
      for (const piece of pieces) {
        this.appendResponsePiece(requestId, piece);
      }
      this.completeRequest(requestId);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      this.completeRequest(requestId);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const extracted = this.extractStreamingPieces(buffer, false);
      buffer = extracted.remainder;

      for (const piece of extracted.pieces) {
        this.appendResponsePiece(requestId, piece);
      }
    }

    buffer += decoder.decode();
    const finalPieces = this.extractStreamingPieces(buffer, true);
    for (const piece of finalPieces.pieces) {
      this.appendResponsePiece(requestId, piece);
    }

    this.completeRequest(requestId);
  }

  private observeHttpResponse(res: httpTypes.IncomingMessage, requestId: string): void {
    const wrapped = res as typeof res & { [WRAPPED_RESPONSE]?: boolean };
    if (wrapped[WRAPPED_RESPONSE]) {
      return;
    }

    wrapped[WRAPPED_RESPONSE] = true;

    const contentType = this.firstHeaderValue(res.headers['content-type']);
    const contentEncoding = this.firstHeaderValue(res.headers['content-encoding']);
    const state = this.activeRequests.get(requestId);
    const isStreaming = Boolean(state?.isStreaming)
      || /text\/event-stream/i.test(contentType)
      || /stream/i.test(contentType)
      || /ndjson/i.test(contentType);

    const observer = isStreaming
      ? this.createStreamingObserver(requestId, contentEncoding)
      : this.createBufferedObserver(requestId, contentEncoding);
    const originalEmit = res.emit;

    res.emit = ((eventName: string | symbol, ...eventArgs: any[]): boolean => {
      try {
        if (eventName === 'data' && eventArgs[0] !== undefined) {
          observer.onData(this.toBuffer(eventArgs[0]));
        } else if (eventName === 'end') {
          observer.onEnd();
        } else if (eventName === 'close') {
          observer.onClose();
        } else if (eventName === 'error' || eventName === 'aborted') {
          observer.onError();
        }
      } catch {
        // Ignore observer failures.
      }

      return originalEmit.call(res, eventName, ...eventArgs);
    }) as typeof res.emit;
  }

  private createStreamingObserver(requestId: string, encoding: string): DecodedChunkObserver {
    let buffer = '';

    return this.createDecodedObserver(
      encoding,
      (text) => {
        buffer += text;
        const extracted = this.extractStreamingPieces(buffer, false);
        buffer = extracted.remainder;

        for (const piece of extracted.pieces) {
          this.appendResponsePiece(requestId, piece);
        }
      },
      () => {
        if (buffer) {
          const extracted = this.extractStreamingPieces(buffer, true);
          for (const piece of extracted.pieces) {
            this.appendResponsePiece(requestId, piece);
          }
        }

        this.completeRequest(requestId);
      }
    );
  }

  private createBufferedObserver(requestId: string, encoding: string): DecodedChunkObserver {
    let body = '';

    return this.createDecodedObserver(
      encoding,
      (text) => {
        body += text;
      },
      () => {
        const pieces = this.extractResponsePieces(body);
        for (const piece of pieces) {
          this.appendResponsePiece(requestId, piece);
        }

        this.completeRequest(requestId);
      }
    );
  }

  private createDecodedObserver(
    encoding: string,
    onText: (text: string) => void,
    onFinished: () => void
  ): DecodedChunkObserver {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      onFinished();
    };

    const normalizedEncoding = encoding.toLowerCase();
    if (!normalizedEncoding || normalizedEncoding === 'identity') {
      const decoder = new TextDecoder();

      return {
        onData: (chunk) => {
          onText(decoder.decode(chunk, { stream: true }));
        },
        onEnd: () => {
          const remaining = decoder.decode();
          if (remaining) {
            onText(remaining);
          }
          finish();
        },
        onClose: finish,
        onError: finish,
      };
    }

    const inflate = this.createInflateStream(normalizedEncoding);
    if (!inflate) {
      return this.createDecodedObserver('', onText, onFinished);
    }

    inflate.on('data', (chunk: Buffer) => {
      onText(chunk.toString('utf8'));
    });
    inflate.on('end', finish);
    inflate.on('close', finish);
    inflate.on('error', finish);

    return {
      onData: (chunk) => {
        inflate.write(chunk);
      },
      onEnd: () => {
        inflate.end();
      },
      onClose: () => {
        inflate.end();
      },
      onError: () => {
        inflate.destroy();
        finish();
      },
    };
  }

  private createInflateStream(encoding: string):
    | import('stream').Transform
    | undefined {
    switch (encoding) {
      case 'gzip':
      case 'x-gzip':
        return zlib.createGunzip();
      case 'br':
        return zlib.createBrotliDecompress();
      case 'deflate':
      case 'x-deflate':
        return zlib.createInflate();
      default:
        return undefined;
    }
  }

  private registerRequest(
    provider: string,
    url: string,
    headers: Record<string, string>,
    body: string
  ): InterceptedRequestState | undefined {
    const payload = this.parseRequestPayload(body, url, headers);
    if (!payload.prompt?.trim()) {
      return undefined;
    }

    const requestId = this.createRequestId();
    const state: InterceptedRequestState = {
      requestId,
      provider,
      url,
      prompt: payload.prompt.trim(),
      model: payload.model,
      modelConfidence: payload.modelConfidence,
      chatId: payload.chatId,
      startedAt: Date.now(),
      isStreaming: payload.isStreaming,
      thinking: '',
      output: '',
      didComplete: false,
    };

    this.activeRequests.set(requestId, state);
    this._onTurnStart.fire({
      requestId,
      provider,
      url,
      prompt: state.prompt,
      model: state.model,
      modelConfidence: state.modelConfidence,
      chatId: state.chatId,
      startedAt: state.startedAt,
      isStreaming: state.isStreaming,
    });

    return state;
  }

  private appendResponsePiece(requestId: string, piece: ResponsePiece): void {
    if (!piece.content) {
      return;
    }

    const state = this.activeRequests.get(requestId);
    if (!state || state.didComplete) {
      return;
    }

    if (piece.kind === 'agent-thinking') {
      state.thinking += piece.content;
    } else {
      state.output += piece.content;
    }

    this._onTurnChunk.fire({
      requestId,
      provider: state.provider,
      kind: piece.kind,
      content: piece.content,
    });
  }

  private completeRequest(requestId: string): void {
    const state = this.activeRequests.get(requestId);
    if (!state || state.didComplete) {
      return;
    }

    state.didComplete = true;
    this._onTurnComplete.fire({
      requestId,
      provider: state.provider,
      url: state.url,
      prompt: state.prompt,
      model: state.model,
      modelConfidence: state.modelConfidence,
      chatId: state.chatId,
      startedAt: state.startedAt,
      completedAt: Date.now(),
      thinking: state.thinking,
      output: state.output,
    });
    this.activeRequests.delete(requestId);
  }

  private extractRequestDetails(
    args: any[],
    protocol: 'http' | 'https'
  ): NormalizedRequestDetails {
    const first = args[0];
    const second = args[1];

    if (typeof first === 'string' || first instanceof URL) {
      const base = new URL(String(first));
      const overrides = second && typeof second === 'object' ? second : undefined;
      const url = new URL(base.toString());

      if (typeof overrides?.protocol === 'string') {
        url.protocol = overrides.protocol;
      }
      if (typeof overrides?.hostname === 'string') {
        url.hostname = overrides.hostname;
      } else if (typeof overrides?.host === 'string') {
        url.host = overrides.host;
      }
      if (typeof overrides?.port === 'string' || typeof overrides?.port === 'number') {
        url.port = String(overrides.port);
      }
      if (typeof overrides?.path === 'string') {
        const pathValue = overrides.path.startsWith('/') ? overrides.path : `/${overrides.path}`;
        url.pathname = pathValue;
      }

      return {
        url: url.toString(),
        headers: this.normalizeHeaders(overrides?.headers),
      };
    }

    if (first && typeof first === 'object') {
      const host = first.hostname || first.host || '';
      const port = first.port ? `:${first.port}` : '';
      const requestPath = typeof first.path === 'string'
        ? first.path
        : typeof first.pathname === 'string'
          ? `${first.pathname}${first.search ?? ''}`
          : '/';

      return {
        url: `${protocol}://${host}${port}${requestPath}`,
        headers: this.normalizeHeaders(first.headers),
      };
    }

    return {
      url: '',
      headers: {},
    };
  }

  private extractFetchUrl(input: any): string {
    try {
      if (typeof input === 'string') {
        return input;
      }

      if (input instanceof URL) {
        return input.toString();
      }

      if (input && typeof input === 'object' && typeof input.url === 'string') {
        return input.url;
      }
    } catch {
      // Ignore malformed fetch input.
    }

    return '';
  }

  private async extractFetchHeaders(
    input: any,
    init?: any
  ): Promise<Record<string, string>> {
    const combined: Record<string, string> = {};

    if (input && typeof input === 'object' && 'headers' in input) {
      Object.assign(combined, this.normalizeHeaders((input as Request).headers));
    }

    if (init?.headers) {
      Object.assign(combined, this.normalizeHeaders(init.headers));
    }

    return combined;
  }

  private async readFetchBody(input: any, init?: any): Promise<string> {
    if (init?.body !== undefined && init?.body !== null) {
      return this.readArbitraryBody(init.body);
    }

    if (input instanceof Request) {
      try {
        return await input.clone().text();
      } catch {
        return '';
      }
    }

    return '';
  }

  private readArbitraryBody(body: unknown): string {
    if (typeof body === 'string') {
      return body;
    }

    if (body instanceof URLSearchParams) {
      return body.toString();
    }

    if (Buffer.isBuffer(body)) {
      return body.toString('utf8');
    }

    if (ArrayBuffer.isView(body)) {
      return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
    }

    if (body instanceof ArrayBuffer) {
      return Buffer.from(body).toString('utf8');
    }

    return String(body ?? '');
  }

  private parseRequestPayload(
    body: string,
    url: string,
    headers: Record<string, string>
  ): ParsedRequestPayload {
    let parsed: any;

    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }

    const prompt = this.extractPrompt(parsed);
    const bodyModel = this.findStringByKeys(parsed, [
      'model',
      'modelName',
      'modelId',
      'model_id',
      'selectedModel',
      'selected_model',
      'agentModel',
      'agent_model',
      'llmModel',
      'llm_model',
    ]);
    const headerModel = this.extractModelFromHeaders(headers);
    const urlModel = this.extractModelFromUrl(url);
    const chatId = this.findStringByKeys(parsed, [
      'trajectoryId',
      'trajectory_id',
      'conversationId',
      'conversation_id',
      'chatId',
      'chat_id',
      'threadId',
      'thread_id',
      'sessionId',
      'session_id',
      'dialogId',
      'dialog_id',
    ]);
    const isStreaming = this.findBooleanByKeys(parsed, ['stream', 'streaming'])
      ?? /stream/i.test(url);

    return {
      prompt,
      model: bodyModel ?? headerModel ?? urlModel,
      modelConfidence: bodyModel
        ? 'exact'
        : headerModel || urlModel
          ? 'inferred'
          : 'unknown',
      chatId: chatId && chatId.trim().length <= 200 ? chatId.trim() : undefined,
      isStreaming,
    };
  }

  private extractPrompt(parsed: any): string | undefined {
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }

    const fromMessages = this.extractLastUserMessage(parsed.messages);
    if (fromMessages) {
      return fromMessages;
    }

    const fromInputArray = this.extractLastUserMessage(parsed.input);
    if (fromInputArray) {
      return fromInputArray;
    }

    if (Array.isArray(parsed.contents)) {
      const lastUserContent = [...parsed.contents]
        .reverse()
        .find((candidate) => candidate?.role === 'user');
      const contentText = this.readTextLike(lastUserContent?.parts);
      if (contentText) {
        return contentText;
      }
    }

    if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
      return parsed.prompt;
    }

    if (typeof parsed.input === 'string' && parsed.input.trim()) {
      return parsed.input;
    }

    if (typeof parsed.query === 'string' && parsed.query.trim()) {
      return parsed.query;
    }

    return undefined;
  }

  private extractLastUserMessage(messages: unknown): string | undefined {
    if (!Array.isArray(messages)) {
      return undefined;
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }

      const role = (candidate as any).role;
      if (role !== 'user' && role !== 'input_user') {
        continue;
      }

      const content = this.readTextLike((candidate as any).content);
      if (content) {
        return content;
      }
    }

    return undefined;
  }

  private extractStreamingPieces(
    buffer: string,
    flush: boolean
  ): { pieces: ResponsePiece[]; remainder: string } {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const remainder = flush ? '' : (lines.pop() ?? '');
    const pieces: ResponsePiece[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('event:') || line.startsWith(':')) {
        continue;
      }

      pieces.push(...this.parseStreamingLine(line));
    }

    if (flush && remainder.trim()) {
      pieces.push(...this.parseStreamingLine(remainder.trim()));
    }

    return { pieces, remainder };
  }

  private parseStreamingLine(line: string): ResponsePiece[] {
    if (line === '[DONE]' || line === 'data: [DONE]') {
      return [];
    }

    if (line.startsWith('data:')) {
      return this.extractResponsePieces(line.slice(5).trim());
    }

    return this.extractResponsePieces(line);
  }

  private extractResponsePieces(raw: string): ResponsePiece[] {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '[DONE]') {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      return this.extractResponsePiecesFromJson(parsed);
    } catch {
      return [{ kind: 'agent-output', content: raw }];
    }
  }

  private extractResponsePiecesFromJson(value: any): ResponsePiece[] {
    if (!value || typeof value !== 'object') {
      return [];
    }

    if (value.choices?.[0]) {
      const choice = value.choices[0];
      return this.compactPieces([
        { kind: 'agent-thinking', content: this.readTextLike(choice.delta?.reasoning_content ?? choice.delta?.reasoning) },
        { kind: 'agent-output', content: this.readTextLike(choice.delta?.content) },
        { kind: 'agent-output', content: this.readTextLike(choice.message?.content) },
        { kind: 'agent-output', content: this.readTextLike(choice.text) },
      ]);
    }

    if (value.delta || value.content || typeof value.completion === 'string') {
      return this.compactPieces([
        { kind: 'agent-thinking', content: this.readTextLike(value.delta?.thinking) },
        { kind: 'agent-output', content: this.readTextLike(value.delta?.text) },
        { kind: 'agent-output', content: this.readTextLike(value.content) },
        { kind: 'agent-output', content: this.readTextLike(value.completion) },
      ]);
    }

    if (value.candidates?.[0]?.content?.parts) {
      const pieces: ResponsePiece[] = [];
      for (const part of value.candidates[0].content.parts) {
        if (typeof part?.thought === 'string' && part.thought) {
          pieces.push({ kind: 'agent-thinking', content: part.thought });
        }
        if (typeof part?.text === 'string' && part.text) {
          pieces.push({ kind: 'agent-output', content: part.text });
        }
      }
      return pieces;
    }

    if (typeof value.output_text === 'string') {
      return [{ kind: 'agent-output', content: value.output_text }];
    }

    if (Array.isArray(value.output)) {
      return this.compactPieces(value.output.flatMap((item: any) => {
        const content = Array.isArray(item?.content) ? item.content : [];
        return content.map((part: any) => ({
          kind: part?.type === 'reasoning' ? 'agent-thinking' : 'agent-output',
          content: this.readTextLike(part?.text ?? part?.content ?? part),
        }));
      }));
    }

    if (value.response?.output) {
      return this.extractResponsePiecesFromJson({ output: value.response.output });
    }

    return this.compactPieces([
      { kind: 'agent-output', content: this.readTextLike(value.text) },
      { kind: 'agent-output', content: this.readTextLike(value.response) },
      { kind: 'agent-output', content: this.readTextLike(value.output) },
      { kind: 'agent-output', content: this.readTextLike(value.result) },
      { kind: 'agent-output', content: this.readTextLike(value.generated_text) },
    ]);
  }

  private compactPieces(pieces: Array<{ kind: 'agent-thinking' | 'agent-output'; content?: string }>): ResponsePiece[] {
    return pieces.flatMap((piece) => {
      if (!piece.content) {
        return [];
      }

      return [{
        kind: piece.kind,
        content: piece.content,
      }];
    });
  }

  private readTextLike(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      return value
        .map((entry) => this.readTextLike(entry))
        .filter(Boolean)
        .join('\n');
    }

    if (value && typeof value === 'object') {
      if (typeof (value as any).text === 'string') {
        return (value as any).text;
      }
      if (typeof (value as any).content === 'string') {
        return (value as any).content;
      }
      if (typeof (value as any).output_text === 'string') {
        return (value as any).output_text;
      }
    }

    return '';
  }

  private findStringByKeys(
    value: unknown,
    keys: string[],
    depth = 0
  ): string | undefined {
    if (!value || depth > 5) {
      return undefined;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = this.findStringByKeys(entry, keys, depth + 1);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    }

    if (typeof value !== 'object') {
      return undefined;
    }

    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    for (const nested of Object.values(value as Record<string, unknown>)) {
      const result = this.findStringByKeys(nested, keys, depth + 1);
      if (result) {
        return result;
      }
    }

    return undefined;
  }

  private findBooleanByKeys(
    value: unknown,
    keys: string[],
    depth = 0
  ): boolean | undefined {
    if (!value || depth > 5) {
      return undefined;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = this.findBooleanByKeys(entry, keys, depth + 1);
        if (nested !== undefined) {
          return nested;
        }
      }
      return undefined;
    }

    if (typeof value !== 'object') {
      return undefined;
    }

    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === 'boolean') {
        return candidate;
      }
    }

    for (const nested of Object.values(value as Record<string, unknown>)) {
      const result = this.findBooleanByKeys(nested, keys, depth + 1);
      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  private extractModelFromHeaders(headers: Record<string, string>): string | undefined {
    const candidate = headers['x-model']
      || headers['openai-model']
      || headers['anthropic-model']
      || headers['x-anthropic-model']
      || headers['x-google-model']
      || headers['x-vertex-model'];

    return candidate?.trim() || undefined;
  }

  private extractModelFromUrl(url: string): string | undefined {
    const modelsPath = url.match(/\/models\/([^/:?]+)/i);
    if (modelsPath?.[1]) {
      return decodeURIComponent(modelsPath[1]);
    }

    const modelQuery = url.match(/[?&]model=([^&]+)/i);
    if (modelQuery?.[1]) {
      return decodeURIComponent(modelQuery[1]);
    }

    return undefined;
  }

  private shouldIgnoreRequest(headers: Record<string, string>): boolean {
    return headers[NETWORK_INTERCEPTOR_IGNORE_HEADER] === NETWORK_INTERCEPTOR_IGNORE_VALUE;
  }

  private normalizeHeaders(value: unknown): Record<string, string> {
    const normalized: Record<string, string> = {};

    if (!value) {
      return normalized;
    }

    if (typeof Headers !== 'undefined' && value instanceof Headers) {
      value.forEach((headerValue, headerName) => {
        normalized[headerName.toLowerCase()] = headerValue;
      });
      return normalized;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!Array.isArray(entry) || entry.length < 2) {
          continue;
        }

        normalized[String(entry[0]).toLowerCase()] = String(entry[1]);
      }
      return normalized;
    }

    if (typeof value === 'object') {
      for (const [headerName, headerValue] of Object.entries(value as Record<string, unknown>)) {
        if (headerValue === undefined || headerValue === null) {
          continue;
        }

        normalized[headerName.toLowerCase()] = Array.isArray(headerValue)
          ? headerValue.join(', ')
          : String(headerValue);
      }
    }

    return normalized;
  }

  private matchEndpoint(url: string): { pattern: RegExp; provider: string } | undefined {
    if (!url) {
      return undefined;
    }

    return this.AI_ENDPOINTS.find((endpoint) => endpoint.pattern.test(url));
  }

  private firstHeaderValue(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }

    return value ?? '';
  }

  private toBuffer(chunk: unknown): Buffer {
    if (Buffer.isBuffer(chunk)) {
      return chunk;
    }

    if (ArrayBuffer.isView(chunk)) {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }

    if (chunk instanceof ArrayBuffer) {
      return Buffer.from(chunk);
    }

    return Buffer.from(String(chunk ?? ''));
  }

  private createRequestId(): string {
    this.requestCounter += 1;
    return `network:${Date.now()}:${this.requestCounter}`;
  }
}
