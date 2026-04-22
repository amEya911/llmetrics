/* eslint-disable @typescript-eslint/no-var-requires */
import type * as httpTypes from 'http';
import type * as http2Types from 'http2';
import type * as netTypes from 'net';
import type * as httpsTypes from 'https';
import type * as diagnosticsChannelTypes from 'diagnostics_channel';

// Use require() so the bundled module bindings stay mutable at runtime.
const diagnosticsChannel: typeof diagnosticsChannelTypes = require('diagnostics_channel');
const http: typeof httpTypes = require('http');
const http2: typeof http2Types = require('http2');
const net: typeof netTypes = require('net');
const https: typeof httpsTypes = require('https');
const zlib: typeof import('zlib') = require('zlib');
import * as vscode from 'vscode';
import { ModelConfidence } from './types';

export const NETWORK_INTERCEPTOR_IGNORE_HEADER = 'x-ai-token-analytics-origin';
export const NETWORK_INTERCEPTOR_IGNORE_VALUE = 'extension';

const WRAPPED_RESPONSE = Symbol('ai-token-analytics.network-response');
const WRAPPED_CLIENT_REQUEST = Symbol('ai-token-analytics.client-request');
const WRAPPED_SERVER_REQUEST = Symbol('ai-token-analytics.server-request');
const WRAPPED_HTTP2_CLIENT_REQUEST = Symbol('ai-token-analytics.http2-client-request');
const WRAPPED_HTTP2_SERVER_STREAM = Symbol('ai-token-analytics.http2-server-stream');
const WRAPPED_LOOPBACK_SOCKET = Symbol('ai-token-analytics.loopback-socket');
const WRAPPED_UNDICI_HANDLER = Symbol('ai-token-analytics.undici-handler');

interface NetworkInterceptorOptions {
  log?: (message: string) => void;
}

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

interface ParsedCursorProxyMetadata {
  conversationId?: string;
  model?: string;
  modelConfidence: ModelConfidence;
}

interface DecodedChunkObserver {
  onData(chunk: Buffer): void;
  onEnd(): void;
  onClose(): void;
  onError(): void;
}

interface UndiciRequestCapture {
  provider: string;
  url: string;
  headers: Record<string, string>;
  bodyChunks: Buffer[];
  requestId?: string;
  responseHeaders?: Record<string, string>;
  responseObserver?: DecodedChunkObserver;
  attemptedRegistration: boolean;
}

interface PrototypeClientRequestCapture {
  requestChunks: Buffer[];
  requestId?: string;
  attemptedRegistration: boolean;
  responseObserved: boolean;
}

/**
 * NetworkInterceptor observes outgoing AI API traffic from the host
 * extension process without mutating the payloads that the caller sees.
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
  private readonly originalHttp2Connect: typeof http2Types.connect;
  private readonly originalHttpServerEmit: typeof httpTypes.Server.prototype.emit;
  private readonly originalHttp2ServerEmit?: Function;
  private readonly originalHttp2SecureServerEmit?: Function;
  private readonly originalNetServerEmit: typeof netTypes.Server.prototype.emit;
  private readonly originalClientRequestWrite: typeof http.ClientRequest.prototype.write;
  private readonly originalClientRequestEnd: typeof http.ClientRequest.prototype.end;
  private readonly originalClientRequestEmit: typeof http.ClientRequest.prototype.emit;
  private readonly originalClientHttp2SessionRequest?: Function;
  private readonly originalFetch?: typeof globalThis.fetch;
  private readonly undiciRequestCreateChannel?: diagnosticsChannelTypes.Channel;
  private readonly log?: (message: string) => void;

  private readonly activeRequests = new Map<string, InterceptedRequestState>();
  private readonly undiciCaptures = new WeakMap<object, UndiciRequestCapture>();
  private readonly prototypeClientRequestCaptures =
    new WeakMap<httpTypes.ClientRequest, PrototypeClientRequestCapture>();
  private active = false;
  private requestCounter = 0;
  private readonly handleUndiciRequestCreate = (message: unknown): void => {
    try {
      this.interceptUndiciRequest(message);
    } catch {
      // Never interfere with undici request creation.
    }
  };

  private readonly AI_ENDPOINTS: Array<{ pattern: RegExp; provider: string }> = [
    { pattern: /api2\.cursor\.sh/i, provider: 'Cursor' },
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

  constructor(options: NetworkInterceptorOptions = {}) {
    this.log = options.log;
    this.originalHttpsRequest = https.request;
    this.originalHttpsGet = https.get;
    this.originalHttpRequest = http.request;
    this.originalHttpGet = http.get;
    this.originalHttp2Connect = http2.connect;
    this.originalHttpServerEmit = http.Server.prototype.emit;
    this.originalHttp2ServerEmit = (http2 as any).Http2Server?.prototype.emit;
    this.originalHttp2SecureServerEmit = (http2 as any).Http2SecureServer?.prototype.emit;
    this.originalNetServerEmit = net.Server.prototype.emit;
    this.originalClientRequestWrite = http.ClientRequest.prototype.write;
    this.originalClientRequestEnd = http.ClientRequest.prototype.end;
    this.originalClientRequestEmit = http.ClientRequest.prototype.emit;
    this.originalClientHttp2SessionRequest = (http2 as any).ClientHttp2Session?.prototype.request;
    this.undiciRequestCreateChannel = diagnosticsChannel?.channel?.('undici:request:create');

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
    this.patchHttp2();
    this.patchClientRequestPrototype();
    this.patchHttp2SessionPrototype();
    this.patchIncomingHttpServer();
    this.patchIncomingHttp2Server();
    this.patchIncomingNetServer();
    this.subscribeUndiciDiagnostics();

    if (!this.undiciRequestCreateChannel) {
      this.patchFetch();
    }
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
    (http2 as any).connect = this.originalHttp2Connect;
    http.Server.prototype.emit = this.originalHttpServerEmit;
    if (this.originalHttp2ServerEmit && (http2 as any).Http2Server?.prototype) {
      (http2 as any).Http2Server.prototype.emit = this.originalHttp2ServerEmit;
    }
    if (this.originalHttp2SecureServerEmit && (http2 as any).Http2SecureServer?.prototype) {
      (http2 as any).Http2SecureServer.prototype.emit = this.originalHttp2SecureServerEmit;
    }
    net.Server.prototype.emit = this.originalNetServerEmit;
    http.ClientRequest.prototype.write = this.originalClientRequestWrite;
    http.ClientRequest.prototype.end = this.originalClientRequestEnd;
    http.ClientRequest.prototype.emit = this.originalClientRequestEmit;
    if (this.originalClientHttp2SessionRequest && (http2 as any).ClientHttp2Session?.prototype) {
      (http2 as any).ClientHttp2Session.prototype.request = this.originalClientHttp2SessionRequest;
    }
    this.unsubscribeUndiciDiagnostics();

    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
    }

    this.activeRequests.clear();
  }

  private subscribeUndiciDiagnostics(): void {
    this.undiciRequestCreateChannel?.subscribe(this.handleUndiciRequestCreate);
  }

  private unsubscribeUndiciDiagnostics(): void {
    this.undiciRequestCreateChannel?.unsubscribe(this.handleUndiciRequestCreate);
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

  private patchHttp2(): void {
    const self = this;
    const originalConnect = this.originalHttp2Connect;

    (http2 as any).connect = function (...args: any[]): http2Types.ClientHttp2Session {
      const session: http2Types.ClientHttp2Session = originalConnect.apply(this, args as any);
      try {
        self.interceptHttp2Session(session, args);
      } catch {
        // Never interfere with the caller.
      }
      return session;
    };
  }

  private patchClientRequestPrototype(): void {
    const self = this;

    http.ClientRequest.prototype.write = function (chunk: any, ...rest: any[]): boolean {
      try {
        self.capturePrototypeClientRequestChunk(this as httpTypes.ClientRequest, chunk);
      } catch {
        // Never interfere with request writes.
      }

      return (self.originalClientRequestWrite as any).apply(this, [chunk, ...rest]);
    };

    http.ClientRequest.prototype.end = function (...endArgs: any[]): any {
      try {
        const first = endArgs[0];
        if (first !== undefined && first !== null && typeof first !== 'function') {
          self.capturePrototypeClientRequestChunk(this as httpTypes.ClientRequest, first);
        }
        self.registerPrototypeClientRequest(this as httpTypes.ClientRequest);
      } catch {
        // Never interfere with request completion.
      }

      return (self.originalClientRequestEnd as any).apply(this, endArgs);
    };

    http.ClientRequest.prototype.emit = function (
      eventName: string | symbol,
      ...eventArgs: any[]
    ): boolean {
      const request = this as httpTypes.ClientRequest;

      try {
        const capture = self.getPrototypeClientRequestCapture(request);
        if (eventName === 'response' && eventArgs[0]) {
          capture.responseObserved = true;
          const requestId = self.registerPrototypeClientRequest(request);
          if (requestId) {
            self.observeHttpResponse(eventArgs[0] as httpTypes.IncomingMessage, requestId);
          }
        } else if (eventName === 'error' || eventName === 'abort') {
          const requestId = capture.requestId;
          if (requestId) {
            self.completeRequest(requestId);
          }
        } else if (eventName === 'close' && capture.requestId && !capture.responseObserved) {
          self.completeRequest(capture.requestId);
        }
      } catch {
        // Never interfere with request events.
      }

      return (self.originalClientRequestEmit as any).apply(this, [eventName, ...eventArgs]);
    };
  }

  private patchHttp2SessionPrototype(): void {
    const prototype = (http2 as any).ClientHttp2Session?.prototype;
    if (!prototype || !this.originalClientHttp2SessionRequest) {
      return;
    }

    const self = this;
    prototype.request = function (
      headers: http2Types.OutgoingHttpHeaders,
      options?: http2Types.ClientSessionRequestOptions
    ) {
      const stream = self.originalClientHttp2SessionRequest!.call(this, headers, options);
      try {
        const authority = typeof (this as any).origin === 'string'
          ? (this as any).origin
          : '';
        self.interceptHttp2Request(authority, stream, headers);
      } catch {
        // Never interfere with the caller.
      }
      return stream;
    };
  }

  private patchIncomingHttpServer(): void {
    const self = this;
    const originalEmit = this.originalHttpServerEmit;

    http.Server.prototype.emit = function (eventName: string | symbol, ...args: any[]): boolean {
      try {
        if (eventName === 'request' && args[0] && args[1]) {
          self.interceptIncomingServerRequest(
            args[0] as httpTypes.IncomingMessage,
            args[1] as httpTypes.ServerResponse
          );
        }
      } catch {
        // Never interfere with the server lifecycle.
      }

      return (originalEmit as any).apply(this, [eventName, ...args]);
    };
  }

  private patchIncomingHttp2Server(): void {
    const patchPrototype = (
      prototype: { emit: Function } | undefined,
      originalEmit: Function | undefined
    ) => {
      if (!prototype || !originalEmit) {
        return;
      }

      const self = this;
      prototype.emit = function (eventName: string | symbol, ...args: any[]): boolean {
        try {
          if (eventName === 'request' && args[0] && args[1]) {
            self.interceptIncomingServerRequest(
              args[0] as httpTypes.IncomingMessage,
              args[1] as httpTypes.ServerResponse
            );
          } else if (eventName === 'stream' && args[0] && args[1]) {
            self.interceptIncomingHttp2Stream(
              args[0] as http2Types.ServerHttp2Stream,
              args[1] as http2Types.IncomingHttpHeaders
            );
          }
        } catch {
          // Never interfere with the server lifecycle.
        }

        return originalEmit.apply(this, [eventName, ...args]);
      };
    };

    patchPrototype((http2 as any).Http2Server?.prototype, this.originalHttp2ServerEmit);
    patchPrototype((http2 as any).Http2SecureServer?.prototype, this.originalHttp2SecureServerEmit);
  }

  private patchIncomingNetServer(): void {
    const self = this;
    const originalEmit = this.originalNetServerEmit;

    net.Server.prototype.emit = function (eventName: string | symbol, ...args: any[]): boolean {
      try {
        if (eventName === 'connection' && args[0]) {
          self.interceptLoopbackSocket(this as netTypes.Server, args[0] as netTypes.Socket);
        }
      } catch {
        // Never interfere with the server lifecycle.
      }

      return (originalEmit as any).apply(this, [eventName, ...args]);
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
    const wrapped = req as typeof req & { [WRAPPED_CLIENT_REQUEST]?: boolean };
    wrapped[WRAPPED_CLIENT_REQUEST] = true;

    const details = this.extractRequestDetails(args, protocol);
    const endpoint = this.matchEndpoint(details.url, details.headers);
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

        const requestBody = Buffer.concat(bodyChunks);
        this.debugObservedRequest('http-client', details.url, details.headers, requestBody, endpoint.provider);
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

  private interceptHttp2Session(
    session: http2Types.ClientHttp2Session,
    args: any[]
  ): void {
    const authority = this.extractHttp2Authority(args);
    const originalRequest = session.request;

    session.request = ((headers: http2Types.OutgoingHttpHeaders, options?: http2Types.ClientSessionRequestOptions) => {
      const stream = originalRequest.call(session, headers, options);
      try {
        this.interceptHttp2Request(authority, stream, headers);
      } catch {
        // Never interfere with the caller.
      }
      return stream;
    }) as typeof session.request;
  }

  private interceptHttp2Request(
    authority: string,
    stream: http2Types.ClientHttp2Stream,
    headers: http2Types.OutgoingHttpHeaders
  ): void {
    const wrapped = stream as typeof stream & { [WRAPPED_HTTP2_CLIENT_REQUEST]?: boolean };
    if (wrapped[WRAPPED_HTTP2_CLIENT_REQUEST]) {
      return;
    }

    wrapped[WRAPPED_HTTP2_CLIENT_REQUEST] = true;

    const details = this.extractHttp2RequestDetails(authority, headers);
    const endpoint = this.matchEndpoint(details.url, details.headers);
    if (!endpoint || this.shouldIgnoreRequest(details.headers)) {
      return;
    }

    const bodyChunks: Buffer[] = [];
    let requestId: string | undefined;

    const originalWrite = stream.write;
    stream.write = ((chunk: any, ...rest: any[]): boolean => {
      try {
        if (chunk !== undefined && chunk !== null) {
          bodyChunks.push(this.toBuffer(chunk));
        }
      } catch {
        // Ignore malformed chunks.
      }

      return (originalWrite as any).apply(stream, [chunk, ...rest]);
    }) as typeof stream.write;

    const originalEnd = stream.end;
    stream.end = ((...endArgs: any[]): any => {
      try {
        const first = endArgs[0];
        if (first !== undefined && first !== null && typeof first !== 'function') {
          bodyChunks.push(this.toBuffer(first));
        }

        const requestBody = Buffer.concat(bodyChunks);
        this.debugObservedRequest('http2-client', details.url, details.headers, requestBody, endpoint.provider);
        const registered = this.registerRequest(endpoint.provider, details.url, details.headers, requestBody);
        requestId = registered?.requestId;
      } catch {
        // Never break the request lifecycle.
      }

      return (originalEnd as any).apply(stream, endArgs);
    }) as typeof stream.end;

    const originalEmit = stream.emit;
    let observer: DecodedChunkObserver | undefined;

    stream.emit = ((eventName: string | symbol, ...eventArgs: any[]): boolean => {
      try {
        if (eventName === 'response' && requestId) {
          const responseHeaders = this.normalizeHeaders(eventArgs[0]);
          observer = this.createResponseObserver(
            requestId,
            this.firstHeaderValue(responseHeaders['content-type']),
            this.firstHeaderValue(responseHeaders['content-encoding'])
          );
        } else if (eventName === 'data' && observer && eventArgs[0] !== undefined) {
          observer.onData(this.toBuffer(eventArgs[0]));
        } else if (eventName === 'end' && observer) {
          observer.onEnd();
        } else if (eventName === 'close' && observer) {
          observer.onClose();
        } else if ((eventName === 'error' || eventName === 'aborted') && observer) {
          observer.onError();
        }
      } catch {
        // Ignore observer failures.
      }

      return originalEmit.call(stream, eventName, ...eventArgs);
    }) as typeof stream.emit;

    stream.once('error', () => {
      if (requestId) {
        this.completeRequest(requestId);
      }
    });
    stream.once('close', () => {
      if (requestId && !observer) {
        this.completeRequest(requestId);
      }
    });
  }

  private capturePrototypeClientRequestChunk(
    req: httpTypes.ClientRequest,
    chunk: unknown
  ): void {
    const wrapped = req as typeof req & { [WRAPPED_CLIENT_REQUEST]?: boolean };
    if (wrapped[WRAPPED_CLIENT_REQUEST] || chunk === undefined || chunk === null) {
      return;
    }

    const capture = this.getPrototypeClientRequestCapture(req);
    capture.requestChunks.push(this.toBuffer(chunk));
  }

  private registerPrototypeClientRequest(req: httpTypes.ClientRequest): string | undefined {
    const wrapped = req as typeof req & { [WRAPPED_CLIENT_REQUEST]?: boolean };
    if (wrapped[WRAPPED_CLIENT_REQUEST]) {
      return undefined;
    }

    const capture = this.getPrototypeClientRequestCapture(req);
    if (capture.requestId) {
      return capture.requestId;
    }
    if (capture.attemptedRegistration) {
      return undefined;
    }

    capture.attemptedRegistration = true;
    const details = this.extractClientRequestDetails(req);
    const endpoint = this.matchEndpoint(details.url, details.headers);
    if (!endpoint || this.shouldIgnoreRequest(details.headers)) {
      return undefined;
    }

    this.debugObservedRequest(
      'prototype-client-request',
      details.url,
      details.headers,
      Buffer.concat(capture.requestChunks),
      endpoint.provider
    );
    const registered = this.registerRequest(
      endpoint.provider,
      details.url,
      details.headers,
      Buffer.concat(capture.requestChunks)
    );
    capture.requestId = registered?.requestId;
    return capture.requestId;
  }

  private getPrototypeClientRequestCapture(
    req: httpTypes.ClientRequest
  ): PrototypeClientRequestCapture {
    const existing = this.prototypeClientRequestCaptures.get(req);
    if (existing) {
      return existing;
    }

    const next: PrototypeClientRequestCapture = {
      requestChunks: [],
      attemptedRegistration: false,
      responseObserved: false,
    };
    this.prototypeClientRequestCaptures.set(req, next);
    return next;
  }

  private extractClientRequestDetails(req: httpTypes.ClientRequest): NormalizedRequestDetails {
    const requestRecord = req as httpTypes.ClientRequest & Record<string, unknown>;
    const headers = typeof req.getHeaders === 'function'
      ? this.normalizeHeaders(req.getHeaders())
      : this.normalizeHeaders(requestRecord._headers);
    const protocol = this.extractClientRequestProtocol(req);
    const rawHost = headers.host
      ?? (typeof requestRecord.host === 'string' ? requestRecord.host : undefined)
      ?? (typeof requestRecord.hostname === 'string' ? requestRecord.hostname : undefined)
      ?? (typeof requestRecord.servername === 'string' ? requestRecord.servername : undefined)
      ?? '';
    const path = typeof req.path === 'string'
      ? req.path
      : typeof requestRecord.path === 'string'
        ? requestRecord.path
        : typeof requestRecord._path === 'string'
          ? requestRecord._path
          : '/';
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    if (!rawHost) {
      return {
        url: `${protocol}://${normalizedPath}`,
        headers,
      };
    }

    const host = typeof requestRecord.port === 'number' && !rawHost.includes(':')
      ? `${rawHost}:${requestRecord.port}`
      : rawHost;

    return {
      url: `${protocol}://${host}${normalizedPath}`,
      headers,
    };
  }

  private extractClientRequestProtocol(req: httpTypes.ClientRequest): 'http' | 'https' {
    const requestRecord = req as httpTypes.ClientRequest & Record<string, unknown>;
    const protocolValue = typeof requestRecord.protocol === 'string'
      ? requestRecord.protocol
      : typeof requestRecord.agent === 'object' && requestRecord.agent
        && typeof (requestRecord.agent as Record<string, unknown>).protocol === 'string'
        ? String((requestRecord.agent as Record<string, unknown>).protocol)
        : undefined;

    if (protocolValue?.startsWith('https')) {
      return 'https';
    }
    if (protocolValue?.startsWith('http')) {
      return 'http';
    }

    const socket = req.socket as (httpTypes.ClientRequest['socket'] & { encrypted?: boolean }) | undefined;
    return socket?.encrypted ? 'https' : 'http';
  }

  private interceptIncomingServerRequest(
    req: httpTypes.IncomingMessage,
    res: httpTypes.ServerResponse
  ): void {
    const wrapped = req as typeof req & { [WRAPPED_SERVER_REQUEST]?: boolean };
    if (wrapped[WRAPPED_SERVER_REQUEST]) {
      return;
    }

    wrapped[WRAPPED_SERVER_REQUEST] = true;

    const details = this.extractIncomingRequestDetails(req);
    const endpoint = this.matchEndpoint(details.url, details.headers);
    if (!endpoint || this.shouldIgnoreRequest(details.headers)) {
      return;
    }

    const requestChunks: Buffer[] = [];
    const pendingResponseChunks: Buffer[] = [];
    let requestId: string | undefined;
    let responseObserver: DecodedChunkObserver | undefined;
    let responseEnded = false;
    let responseClosed = false;
    let responseErrored = false;

    const flushPendingResponse = () => {
      if (!requestId) {
        return;
      }

      const observer = this.ensureServerResponseObserver(requestId, res, responseObserver);
      responseObserver = observer;
      while (pendingResponseChunks.length > 0) {
        observer.onData(pendingResponseChunks.shift()!);
      }
      if (responseEnded) {
        observer.onEnd();
      } else if (responseErrored) {
        observer.onError();
      } else if (responseClosed) {
        observer.onClose();
      }
    };

    const originalRequestEmit = req.emit;
    req.emit = ((eventName: string | symbol, ...eventArgs: any[]): boolean => {
      try {
        if (eventName === 'data' && eventArgs[0] !== undefined) {
          requestChunks.push(this.toBuffer(eventArgs[0]));
        } else if (eventName === 'end') {
          const requestBody = Buffer.concat(requestChunks);
          this.debugObservedRequest(
            'incoming-http-server',
            details.url,
            details.headers,
            requestBody,
            endpoint.provider
          );
          const registered = this.registerRequest(
            endpoint.provider,
            details.url,
            details.headers,
            requestBody
          );
          requestId = registered?.requestId;
          flushPendingResponse();
        } else if ((eventName === 'error' || eventName === 'aborted') && requestId) {
          this.completeRequest(requestId);
        }
      } catch {
        // Ignore observer failures.
      }

      return originalRequestEmit.call(req, eventName, ...eventArgs);
    }) as typeof req.emit;

    const originalWrite = res.write;
    res.write = ((chunk: any, ...rest: any[]): boolean => {
      try {
        const buffer = this.toBuffer(chunk);
        if (requestId) {
          responseObserver = this.ensureServerResponseObserver(requestId, res, responseObserver);
          responseObserver.onData(buffer);
        } else {
          pendingResponseChunks.push(buffer);
        }
      } catch {
        // Ignore malformed chunks.
      }

      return (originalWrite as any).apply(res, [chunk, ...rest]);
    }) as typeof res.write;

    const originalEnd = res.end;
    res.end = ((...endArgs: any[]): any => {
      try {
        const first = endArgs[0];
        if (first !== undefined && first !== null && typeof first !== 'function') {
          const buffer = this.toBuffer(first);
          if (requestId) {
            responseObserver = this.ensureServerResponseObserver(requestId, res, responseObserver);
            responseObserver.onData(buffer);
          } else {
            pendingResponseChunks.push(buffer);
          }
        }
      } catch {
        // Ignore malformed chunks.
      }

      const result = (originalEnd as any).apply(res, endArgs);

      if (requestId) {
        responseObserver = this.ensureServerResponseObserver(requestId, res, responseObserver);
        responseObserver.onEnd();
      } else {
        responseEnded = true;
      }

      return result;
    }) as typeof res.end;

    res.once('close', () => {
      responseClosed = true;
      if (!requestId) {
        return;
      }

      if (responseObserver) {
        responseObserver.onClose();
      } else {
        this.completeRequest(requestId);
      }
    });
    res.once('error', () => {
      responseErrored = true;
      if (!requestId) {
        return;
      }

      if (responseObserver) {
        responseObserver.onError();
      } else {
        this.completeRequest(requestId);
      }
    });
  }

  private interceptIncomingHttp2Stream(
    stream: http2Types.ServerHttp2Stream,
    headers: http2Types.IncomingHttpHeaders
  ): void {
    const wrapped = stream as typeof stream & { [WRAPPED_HTTP2_SERVER_STREAM]?: boolean };
    if (wrapped[WRAPPED_HTTP2_SERVER_STREAM]) {
      return;
    }

    wrapped[WRAPPED_HTTP2_SERVER_STREAM] = true;

    const details = this.extractIncomingHttp2StreamDetails(headers);
    const endpoint = this.matchEndpoint(details.url, details.headers);
    if (!endpoint || this.shouldIgnoreRequest(details.headers)) {
      return;
    }

    const requestChunks: Buffer[] = [];
    const pendingResponseChunks: Buffer[] = [];
    let requestId: string | undefined;
    let responseObserver: DecodedChunkObserver | undefined;
    let responseHeaders: Record<string, string> = {};
    let responseEnded = false;
    let responseClosed = false;
    let responseErrored = false;

    const flushPendingResponse = () => {
      if (!requestId) {
        return;
      }

      const observer = this.ensureHttp2StreamResponseObserver(
        requestId,
        responseHeaders,
        responseObserver
      );
      responseObserver = observer;
      while (pendingResponseChunks.length > 0) {
        observer.onData(pendingResponseChunks.shift()!);
      }
      if (responseEnded) {
        observer.onEnd();
      } else if (responseErrored) {
        observer.onError();
      } else if (responseClosed) {
        observer.onClose();
      }
    };

    const originalEmit = stream.emit;
    stream.emit = ((eventName: string | symbol, ...eventArgs: any[]): boolean => {
      try {
        if (eventName === 'data' && eventArgs[0] !== undefined) {
          requestChunks.push(this.toBuffer(eventArgs[0]));
        } else if (eventName === 'end') {
          const requestBody = Buffer.concat(requestChunks);
          this.debugObservedRequest(
            'incoming-http2-server',
            details.url,
            details.headers,
            requestBody,
            endpoint.provider
          );
          const registered = this.registerRequest(
            endpoint.provider,
            details.url,
            details.headers,
            requestBody
          );
          requestId = registered?.requestId;
          flushPendingResponse();
        } else if ((eventName === 'error' || eventName === 'aborted') && requestId) {
          this.completeRequest(requestId);
        }
      } catch {
        // Ignore observer failures.
      }

      return originalEmit.call(stream, eventName, ...eventArgs);
    }) as typeof stream.emit;

    const originalRespond = stream.respond;
    stream.respond = ((responseHeadersArg: http2Types.OutgoingHttpHeaders, options?: http2Types.ServerStreamResponseOptions): void => {
      try {
        responseHeaders = {
          ...responseHeaders,
          ...this.normalizeHeaders(responseHeadersArg),
        };
      } catch {
        // Ignore malformed response headers.
      }

      return originalRespond.call(stream, responseHeadersArg, options);
    }) as typeof stream.respond;

    const originalAdditionalHeaders = stream.additionalHeaders;
    stream.additionalHeaders = ((additionalHeadersArg: http2Types.OutgoingHttpHeaders): void => {
      try {
        responseHeaders = {
          ...responseHeaders,
          ...this.normalizeHeaders(additionalHeadersArg),
        };
      } catch {
        // Ignore malformed response headers.
      }

      return originalAdditionalHeaders.call(stream, additionalHeadersArg);
    }) as typeof stream.additionalHeaders;

    const originalWrite = stream.write;
    stream.write = ((chunk: any, ...rest: any[]): boolean => {
      try {
        const buffer = this.toBuffer(chunk);
        if (requestId) {
          responseObserver = this.ensureHttp2StreamResponseObserver(
            requestId,
            responseHeaders,
            responseObserver
          );
          responseObserver.onData(buffer);
        } else {
          pendingResponseChunks.push(buffer);
        }
      } catch {
        // Ignore malformed chunks.
      }

      return (originalWrite as any).apply(stream, [chunk, ...rest]);
    }) as typeof stream.write;

    const originalEnd = stream.end;
    stream.end = ((...endArgs: any[]): any => {
      try {
        const first = endArgs[0];
        if (first !== undefined && first !== null && typeof first !== 'function') {
          const buffer = this.toBuffer(first);
          if (requestId) {
            responseObserver = this.ensureHttp2StreamResponseObserver(
              requestId,
              responseHeaders,
              responseObserver
            );
            responseObserver.onData(buffer);
          } else {
            pendingResponseChunks.push(buffer);
          }
        }
      } catch {
        // Ignore malformed chunks.
      }

      const result = (originalEnd as any).apply(stream, endArgs);

      if (requestId) {
        responseObserver = this.ensureHttp2StreamResponseObserver(
          requestId,
          responseHeaders,
          responseObserver
        );
        responseObserver.onEnd();
      } else {
        responseEnded = true;
      }

      return result;
    }) as typeof stream.end;

    stream.once('close', () => {
      responseClosed = true;
      if (!requestId) {
        return;
      }

      if (responseObserver) {
        responseObserver.onClose();
      } else {
        this.completeRequest(requestId);
      }
    });
    stream.once('error', () => {
      responseErrored = true;
      if (!requestId) {
        return;
      }

      if (responseObserver) {
        responseObserver.onError();
      } else {
        this.completeRequest(requestId);
      }
    });
  }

  private interceptLoopbackSocket(
    server: netTypes.Server,
    socket: netTypes.Socket
  ): void {
    if (!this.log) {
      return;
    }

    const wrapped = socket as typeof socket & { [WRAPPED_LOOPBACK_SOCKET]?: boolean };
    if (wrapped[WRAPPED_LOOPBACK_SOCKET]) {
      return;
    }

    const localAddress = socket.localAddress;
    const remoteAddress = socket.remoteAddress;
    if (!this.isLoopbackAddress(localAddress) && !this.isLoopbackAddress(remoteAddress)) {
      return;
    }

    wrapped[WRAPPED_LOOPBACK_SOCKET] = true;

    const serverAddress = server.address();
    const listenerPort = typeof serverAddress === 'object' && serverAddress
      ? serverAddress.port
      : socket.localPort;
    let inboundCount = 0;
    let outboundCount = 0;

    const describeConnection = () => {
      const from = `${remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
      const to = `${localAddress ?? 'unknown'}:${listenerPort ?? socket.localPort ?? 0}`;
      return `${from} -> ${to}`;
    };

    const logSocketChunk = (direction: 'in' | 'out', chunk: unknown) => {
      if (direction === 'in' && inboundCount >= 3) {
        return;
      }
      if (direction === 'out' && outboundCount >= 3) {
        return;
      }

      const preview = this.previewSocketChunk(chunk);
      if (!preview) {
        return;
      }

      if (direction === 'in') {
        inboundCount += 1;
      } else {
        outboundCount += 1;
      }

      this.debug(`[cursor-network] Loopback socket ${describeConnection()} ${direction}: ${preview}`);
    };

    const originalEmit = socket.emit;
    socket.emit = ((eventName: string | symbol, ...eventArgs: any[]): boolean => {
      try {
        if (eventName === 'data' && eventArgs[0] !== undefined) {
          logSocketChunk('in', eventArgs[0]);
        }
      } catch {
        // Ignore socket observer failures.
      }

      return (originalEmit as any).apply(socket, [eventName, ...eventArgs]);
    }) as typeof socket.emit;

    const originalWrite = socket.write;
    socket.write = ((chunk: any, ...rest: any[]): boolean => {
      try {
        logSocketChunk('out', chunk);
      } catch {
        // Ignore socket observer failures.
      }

      return (originalWrite as any).apply(socket, [chunk, ...rest]);
    }) as typeof socket.write;
  }

  private interceptUndiciRequest(message: unknown): void {
    const request = (message as { request?: unknown } | undefined)?.request;
    if (!request || typeof request !== 'object') {
      return;
    }

    if (this.undiciCaptures.has(request)) {
      return;
    }

    const details = this.extractUndiciRequestDetails(request as Record<string, unknown>);
    const endpoint = this.matchEndpoint(details.url, details.headers);
    if (!endpoint || this.shouldIgnoreRequest(details.headers)) {
      return;
    }

    const capture: UndiciRequestCapture = {
      provider: endpoint.provider,
      url: details.url,
      headers: details.headers,
      bodyChunks: [],
      attemptedRegistration: false,
    };

    this.undiciCaptures.set(request, capture);
    this.wrapUndiciRequestBody(request as Record<string, unknown>, capture);
    this.wrapUndiciRequestHandler(request as Record<string, unknown>, capture);
  }

  private extractUndiciRequestDetails(
    request: Record<string, unknown>
  ): NormalizedRequestDetails {
    const origin = typeof request.origin === 'string' ? request.origin : '';
    const path = typeof request.path === 'string' ? request.path : '/';
    const headers = this.normalizeHeaders(request.headers);

    if (!origin) {
      return { url: path, headers };
    }

    try {
      return {
        url: new URL(path, origin).toString(),
        headers,
      };
    } catch {
      return {
        url: `${origin}${path}`,
        headers,
      };
    }
  }

  private wrapUndiciRequestBody(
    request: Record<string, unknown>,
    capture: UndiciRequestCapture
  ): void {
    const body = request.body;
    if (body === undefined || body === null) {
      this.ensureUndiciRequestRegistered(capture);
      return;
    }

    const iterator = this.asIterable(body);
    if (!iterator) {
      try {
        capture.bodyChunks.push(this.toBuffer(body));
      } catch {
        // Ignore malformed request bodies.
      }
      this.ensureUndiciRequestRegistered(capture);
      return;
    }

    const self = this;
    request.body = (async function* () {
      try {
        for await (const chunk of iterator as AsyncIterable<unknown>) {
          try {
            capture.bodyChunks.push(self.toBuffer(chunk));
          } catch {
            // Ignore malformed request chunks.
          }
          yield chunk;
        }
      } finally {
        self.ensureUndiciRequestRegistered(capture);
      }
    })();
  }

  private wrapUndiciRequestHandler(
    request: Record<string, unknown>,
    capture: UndiciRequestCapture
  ): void {
    const handlerSymbol = Reflect.ownKeys(request)
      .find((key) => String(key) === 'Symbol(handler)');
    if (!handlerSymbol) {
      return;
    }

    const handler = (request as Record<PropertyKey, unknown>)[handlerSymbol] as
      | Record<PropertyKey, unknown>
      | undefined;
    if (!handler || handler[WRAPPED_UNDICI_HANDLER]) {
      return;
    }

    handler[WRAPPED_UNDICI_HANDLER] = true;

    const originalOnHeaders = typeof handler.onHeaders === 'function'
      ? handler.onHeaders.bind(handler)
      : undefined;
    handler.onHeaders = (...args: any[]) => {
      try {
        this.ensureUndiciRequestRegistered(capture);
        capture.responseHeaders = this.normalizeHeaders(args[1]);
        capture.responseObserver = this.ensureUndiciResponseObserver(capture);
      } catch {
        // Ignore undici observer failures.
      }

      return originalOnHeaders?.(...args);
    };

    const originalOnData = typeof handler.onData === 'function'
      ? handler.onData.bind(handler)
      : undefined;
    handler.onData = (chunk: unknown) => {
      try {
        this.ensureUndiciRequestRegistered(capture);
        const observer = this.ensureUndiciResponseObserver(capture);
        observer?.onData(this.toBuffer(chunk));
      } catch {
        // Ignore undici observer failures.
      }

      return originalOnData?.(chunk);
    };

    const originalOnComplete = typeof handler.onComplete === 'function'
      ? handler.onComplete.bind(handler)
      : undefined;
    handler.onComplete = (...args: any[]) => {
      try {
        this.ensureUndiciRequestRegistered(capture);
        const observer = this.ensureUndiciResponseObserver(capture);
        if (observer) {
          observer.onEnd();
        } else if (capture.requestId) {
          this.completeRequest(capture.requestId);
        }
      } catch {
        // Ignore undici observer failures.
      }

      return originalOnComplete?.(...args);
    };

    const originalOnError = typeof handler.onError === 'function'
      ? handler.onError.bind(handler)
      : undefined;
    handler.onError = (error: unknown) => {
      try {
        const observer = this.ensureUndiciResponseObserver(capture);
        if (observer) {
          observer.onError();
        } else if (capture.requestId) {
          this.completeRequest(capture.requestId);
        }
      } catch {
        // Ignore undici observer failures.
      }

      return originalOnError?.(error);
    };
  }

  private ensureUndiciRequestRegistered(
    capture: UndiciRequestCapture
  ): InterceptedRequestState | undefined {
    if (capture.requestId) {
      return this.activeRequests.get(capture.requestId);
    }

    if (capture.attemptedRegistration) {
      return undefined;
    }

    capture.attemptedRegistration = true;
    this.debugObservedRequest(
      'undici',
      capture.url,
      capture.headers,
      Buffer.concat(capture.bodyChunks),
      capture.provider
    );
    const registered = this.registerRequest(
      capture.provider,
      capture.url,
      capture.headers,
      Buffer.concat(capture.bodyChunks)
    );
    capture.requestId = registered?.requestId;
    return registered;
  }

  private ensureUndiciResponseObserver(
    capture: UndiciRequestCapture
  ): DecodedChunkObserver | undefined {
    if (capture.responseObserver) {
      return capture.responseObserver;
    }

    if (!capture.requestId) {
      return undefined;
    }

    const contentType = this.firstHeaderValue(capture.responseHeaders?.['content-type']);
    const contentEncoding = this.firstHeaderValue(capture.responseHeaders?.['content-encoding']);
    const state = this.activeRequests.get(capture.requestId);
    const isStreaming = Boolean(state?.isStreaming)
      || /text\/event-stream/i.test(contentType)
      || /stream/i.test(contentType)
      || /ndjson/i.test(contentType)
      || this.isConnectJsonContentType(contentType);

    capture.responseObserver = this.createResponseObserver(
      capture.requestId,
      contentType,
      contentEncoding,
      isStreaming
    );
    return capture.responseObserver;
  }

  private async captureFetchRequest(
    input: any,
    init?: any
  ): Promise<{ requestId: string; isStreaming: boolean } | undefined> {
    const url = this.extractFetchUrl(input);
    const headers = await this.extractFetchHeaders(input, init);
    const endpoint = this.matchEndpoint(url, headers);
    if (!endpoint) {
      return undefined;
    }

    if (this.shouldIgnoreRequest(headers)) {
      return undefined;
    }

    const body = await this.readFetchBody(input, init);
    this.debugObservedRequest('fetch', url, headers, body, endpoint.provider);
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
    const isConnectJson = this.isConnectJsonContentType(contentType);
    const isStreaming = isStreamingHint
      || /text\/event-stream/i.test(contentType)
      || /stream/i.test(contentType)
      || /ndjson/i.test(contentType)
      || isConnectJson;

    if (!isStreaming) {
      const body = Buffer.from(await response.arrayBuffer());
      const pieces = this.extractResponsePiecesFromBody(body, contentType);
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

    if (isConnectJson) {
      let buffer: Buffer = Buffer.alloc(0);

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer = Buffer.concat([buffer, Buffer.from(value)]);
        const extracted = this.extractConnectStreamingPieces(buffer, false);
        buffer = extracted.remainder;

        for (const piece of extracted.pieces) {
          this.appendResponsePiece(requestId, piece);
        }
      }

      if (buffer.length > 0) {
        const finalPieces = this.extractConnectStreamingPieces(buffer, true);
        for (const piece of finalPieces.pieces) {
          this.appendResponsePiece(requestId, piece);
        }
      }

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
      || /ndjson/i.test(contentType)
      || this.isConnectJsonContentType(contentType);

    const observer = this.createResponseObserver(
      requestId,
      contentType,
      contentEncoding,
      isStreaming
    );
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

  private createResponseObserver(
    requestId: string,
    contentType: string,
    encoding: string,
    isStreaming = true
  ): DecodedChunkObserver {
    return isStreaming
      ? this.createStreamingObserver(requestId, encoding, contentType)
      : this.createBufferedObserver(requestId, encoding, contentType);
  }

  private createStreamingObserver(
    requestId: string,
    encoding: string,
    contentType: string
  ): DecodedChunkObserver {
    if (this.isConnectJsonContentType(contentType)) {
      let buffer: Buffer = Buffer.alloc(0);

      return this.createBufferObserver(
        encoding,
        (chunk) => {
          this.debugResponseChunk(requestId, contentType, chunk);
          buffer = Buffer.concat([buffer, chunk]);
          const extracted = this.extractConnectStreamingPieces(buffer, false);
          buffer = extracted.remainder;

          for (const piece of extracted.pieces) {
            this.appendResponsePiece(requestId, piece);
          }
        },
        () => {
          if (buffer.length > 0) {
            const extracted = this.extractConnectStreamingPieces(buffer, true);
            for (const piece of extracted.pieces) {
              this.appendResponsePiece(requestId, piece);
            }
          }

          this.debugResponseBoundary(requestId, 'complete', contentType);
          this.completeRequest(requestId);
        }
      );
    }

    let buffer = '';

    return this.createDecodedObserver(
      encoding,
      (text) => {
        this.debugResponseChunk(requestId, contentType, text);
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

        this.debugResponseBoundary(requestId, 'complete', contentType);
        this.completeRequest(requestId);
      }
    );
  }

  private createBufferedObserver(
    requestId: string,
    encoding: string,
    contentType: string
  ): DecodedChunkObserver {
    if (this.isConnectJsonContentType(contentType)) {
      const chunks: Buffer[] = [];

      return this.createBufferObserver(
        encoding,
        (chunk) => {
          this.debugResponseChunk(requestId, contentType, chunk);
          chunks.push(chunk);
        },
        () => {
          const pieces = this.extractResponsePiecesFromBody(Buffer.concat(chunks), contentType);
          for (const piece of pieces) {
            this.appendResponsePiece(requestId, piece);
          }

          this.debugResponseBoundary(requestId, 'complete', contentType);
          this.completeRequest(requestId);
        }
      );
    }

    let body = '';

    return this.createDecodedObserver(
      encoding,
      (text) => {
        this.debugResponseChunk(requestId, contentType, text);
        body += text;
      },
      () => {
        const pieces = this.extractResponsePieces(body);
        for (const piece of pieces) {
          this.appendResponsePiece(requestId, piece);
        }

        this.debugResponseBoundary(requestId, 'complete', contentType);
        this.completeRequest(requestId);
      }
    );
  }

  private createBufferObserver(
    encoding: string,
    onBuffer: (chunk: Buffer) => void,
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
      return {
        onData: onBuffer,
        onEnd: finish,
        onClose: finish,
        onError: finish,
      };
    }

    const inflate = this.createInflateStream(normalizedEncoding);
    if (!inflate) {
      return this.createBufferObserver('', onBuffer, onFinished);
    }

    inflate.on('data', (chunk: Buffer) => {
      onBuffer(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
    body: string | Buffer
  ): InterceptedRequestState | undefined {
    const payload = this.parseRequestPayload(body, url, headers);
    if (!payload.prompt?.trim()) {
      if (provider === 'Cursor') {
        this.logCursorMiss(url, headers, body);
      }
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

  private extractHttp2Authority(args: any[]): string {
    const first = args[0];

    try {
      if (typeof first === 'string' || first instanceof URL) {
        return new URL(String(first)).toString();
      }
    } catch {
      // Ignore malformed authority.
    }

    return '';
  }

  private extractHttp2RequestDetails(
    authority: string,
    headers: http2Types.OutgoingHttpHeaders
  ): NormalizedRequestDetails {
    const normalizedHeaders = this.normalizeHeaders(headers);
    const rawPath = typeof headers[':path'] === 'string' ? headers[':path'] : '/';
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const fallbackProtocol = authority.startsWith('http://') ? 'http' : 'https';

    if (authority) {
      try {
        const url = new URL(authority);
        url.pathname = path.split('?')[0] || '/';
        url.search = path.includes('?') ? `?${path.split('?').slice(1).join('?')}` : '';

        return {
          url: url.toString(),
          headers: normalizedHeaders,
        };
      } catch {
        // Fall through to host reconstruction.
      }
    }

    const host = typeof headers[':authority'] === 'string'
      ? headers[':authority']
      : normalizedHeaders.host ?? '';

    return {
      url: `${fallbackProtocol}://${host}${path}`,
      headers: normalizedHeaders,
    };
  }

  private extractIncomingRequestDetails(req: httpTypes.IncomingMessage): NormalizedRequestDetails {
    const headers = this.normalizeHeaders(req.headers);
    const host = headers[':authority'] ?? headers.host ?? '127.0.0.1';
    const path = req.url ?? '/';

    return {
      url: `http://${host}${path}`,
      headers,
    };
  }

  private extractIncomingHttp2StreamDetails(
    headers: http2Types.IncomingHttpHeaders
  ): NormalizedRequestDetails {
    const normalizedHeaders = this.normalizeHeaders(headers);
    const host = normalizedHeaders[':authority'] ?? normalizedHeaders.host ?? '127.0.0.1';
    const path = normalizedHeaders[':path'] ?? '/';
    const scheme = normalizedHeaders[':scheme'] ?? 'https';

    return {
      url: `${scheme}://${host}${path}`,
      headers: normalizedHeaders,
    };
  }

  private ensureServerResponseObserver(
    requestId: string,
    res: httpTypes.ServerResponse,
    existing?: DecodedChunkObserver
  ): DecodedChunkObserver {
    if (existing) {
      return existing;
    }

    const contentType = String(res.getHeader('content-type') ?? '');
    const contentEncoding = String(res.getHeader('content-encoding') ?? '');
    const state = this.activeRequests.get(requestId);
    const isStreaming = Boolean(state?.isStreaming)
      || /text\/event-stream/i.test(contentType)
      || /stream/i.test(contentType)
      || /ndjson/i.test(contentType)
      || this.isConnectJsonContentType(contentType);

    return this.createResponseObserver(
      requestId,
      contentType,
      contentEncoding,
      isStreaming
    );
  }

  private ensureHttp2StreamResponseObserver(
    requestId: string,
    headers: Record<string, string>,
    existing?: DecodedChunkObserver
  ): DecodedChunkObserver {
    if (existing) {
      return existing;
    }

    const contentType = this.firstHeaderValue(headers['content-type']);
    const contentEncoding = this.firstHeaderValue(headers['content-encoding']);
    const state = this.activeRequests.get(requestId);
    const isStreaming = Boolean(state?.isStreaming)
      || /text\/event-stream/i.test(contentType)
      || /stream/i.test(contentType)
      || /ndjson/i.test(contentType)
      || this.isConnectJsonContentType(contentType);

    return this.createResponseObserver(
      requestId,
      contentType,
      contentEncoding,
      isStreaming
    );
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

  private asIterable(value: unknown): AsyncIterable<unknown> | Iterable<unknown> | undefined {
    if (value && typeof value === 'object') {
      const asyncIterator = (value as AsyncIterable<unknown>)[Symbol.asyncIterator];
      if (typeof asyncIterator === 'function') {
        return value as AsyncIterable<unknown>;
      }

      const iterator = (value as Iterable<unknown>)[Symbol.iterator];
      if (typeof iterator === 'function') {
        return value as Iterable<unknown>;
      }
    }

    return undefined;
  }

  private parseRequestPayload(
    body: string | Buffer,
    url: string,
    headers: Record<string, string>
  ): ParsedRequestPayload {
    const parsedCandidates = this.parseBodyCandidates(body, headers);
    const cursorProxy = this.parseCursorProxyMetadata(headers);
    const prompt = this.extractPromptFromCandidates(parsedCandidates);
    const bodyModel = this.findStringByKeys(parsedCandidates, [
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
    const headerModel = cursorProxy.model ?? this.extractModelFromHeaders(headers);
    const urlModel = this.extractModelFromUrl(url);
    const chatId = cursorProxy.conversationId ?? this.findStringByKeys(parsedCandidates, [
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
    const isStreaming = this.findBooleanByKeys(parsedCandidates, ['stream', 'streaming'])
      ?? /stream/i.test(url);
    const modelConfidence: ModelConfidence = bodyModel
      ? 'exact'
      : cursorProxy.model
        ? cursorProxy.modelConfidence
        : headerModel || urlModel
          ? 'inferred'
          : 'unknown';

    return {
      prompt,
      model: bodyModel ?? headerModel ?? urlModel,
      modelConfidence,
      chatId: chatId && chatId.trim().length <= 200 ? chatId.trim() : undefined,
      isStreaming,
    };
  }

  private parseBodyCandidates(
    body: string | Buffer,
    headers: Record<string, string>
  ): any[] {
    if (Buffer.isBuffer(body)) {
      const contentType = headers['content-type'] ?? '';
      if (this.isConnectJsonContentType(contentType)) {
        return this.extractConnectJsonPayloads(body);
      }

      const text = body.toString('utf8');
      return this.parseJsonCandidatesFromText(text);
    }

    return this.parseJsonCandidatesFromText(body);
  }

  private parseJsonCandidatesFromText(text: string): any[] {
    if (!text) {
      return [];
    }

    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }

  private extractConnectJsonPayloads(buffer: Buffer): any[] {
    const parsed: any[] = [];

    for (const payload of this.extractConnectJsonPayloadTexts(buffer)) {
      try {
        parsed.push(JSON.parse(payload));
      } catch {
        // Ignore invalid JSON payload frames.
      }
    }

    return parsed;
  }

  private extractConnectJsonPayloadTexts(buffer: Buffer): string[] {
    const payloads: string[] = [];
    let offset = 0;

    while (offset + 5 <= buffer.length) {
      const flags = buffer.readUInt8(offset);
      const length = buffer.readUInt32BE(offset + 1);
      if (offset + 5 + length > buffer.length) {
        break;
      }

      const payload = buffer.subarray(offset + 5, offset + 5 + length);
      offset += 5 + length;

      if ((flags & 0x02) !== 0) {
        continue;
      }

      payloads.push(payload.toString('utf8'));
    }

    return payloads;
  }

  private parseCursorProxyMetadata(headers: Record<string, string>): ParsedCursorProxyMetadata {
    const rawHeader = headers['x-api-key'];
    if (!rawHeader) {
      return { modelConfidence: 'unknown' };
    }

    try {
      const parsed = JSON.parse(rawHeader);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.authToken !== 'string') {
        return { modelConfidence: 'unknown' };
      }

      const requestedModel = parsed.requestedModel;
      const requestedModelId = requestedModel && typeof requestedModel === 'object'
        && typeof requestedModel.modelId === 'string'
        ? requestedModel.modelId.trim()
        : undefined;
      const primaryModelName = typeof parsed.primaryModelName === 'string'
        ? parsed.primaryModelName.trim()
        : undefined;
      const conversationId = typeof parsed.conversationId === 'string'
        ? parsed.conversationId.trim()
        : undefined;

      return {
        conversationId: conversationId || undefined,
        model: requestedModelId || primaryModelName || undefined,
        modelConfidence: requestedModelId
          ? 'exact'
          : primaryModelName
            ? 'inferred'
            : 'unknown',
      };
    } catch {
      return { modelConfidence: 'unknown' };
    }
  }

  private hasCursorProxyAuthHeader(headers: Record<string, string>): boolean {
    const rawHeader = headers['x-api-key'];
    if (!rawHeader) {
      return false;
    }

    try {
      const parsed = JSON.parse(rawHeader);
      return !!parsed && typeof parsed === 'object' && typeof parsed.authToken === 'string';
    } catch {
      return false;
    }
  }

  private extractPromptFromCandidates(candidates: any[]): string | undefined {
    for (const candidate of candidates) {
      const prompt = this.extractPrompt(candidate);
      if (prompt) {
        return prompt;
      }
    }

    return undefined;
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

  private extractResponsePiecesFromBody(
    body: Buffer,
    contentType: string
  ): ResponsePiece[] {
    if (this.isConnectJsonContentType(contentType)) {
      return this.extractConnectJsonPayloadTexts(body)
        .flatMap((payload) => this.extractResponsePieces(payload));
    }

    return this.extractResponsePieces(body.toString('utf8'));
  }

  private extractConnectStreamingPieces(
    buffer: Buffer,
    flush: boolean
  ): { pieces: ResponsePiece[]; remainder: Buffer } {
    const pieces: ResponsePiece[] = [];
    let offset = 0;

    while (offset + 5 <= buffer.length) {
      const flags = buffer.readUInt8(offset);
      const length = buffer.readUInt32BE(offset + 1);
      if (offset + 5 + length > buffer.length) {
        break;
      }

      const payload = buffer.subarray(offset + 5, offset + 5 + length);
      offset += 5 + length;

      if ((flags & 0x02) !== 0) {
        continue;
      }

      pieces.push(...this.extractResponsePieces(payload.toString('utf8')));
    }

    return {
      pieces,
      remainder: flush ? Buffer.alloc(0) : buffer.subarray(offset),
    };
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

  private isConnectJsonContentType(contentType: string): boolean {
    return /application\/connect\+json/i.test(contentType);
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
      if (value.length > 0 && !Array.isArray(value[0])) {
        for (let index = 0; index + 1 < value.length; index += 2) {
          normalized[this.headerValueToText(value[index]).toLowerCase()] =
            this.headerValueToText(value[index + 1]);
        }
        return normalized;
      }

      for (const entry of value) {
        if (!Array.isArray(entry) || entry.length < 2) {
          continue;
        }

        normalized[this.headerValueToText(entry[0]).toLowerCase()] =
          this.headerValueToText(entry[1]);
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

  private headerValueToText(value: unknown): string {
    if (Buffer.isBuffer(value)) {
      return value.toString('utf8');
    }

    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    }

    if (value instanceof ArrayBuffer) {
      return Buffer.from(value).toString('utf8');
    }

    return String(value ?? '');
  }

  private matchEndpoint(
    url: string,
    headers: Record<string, string> = {}
  ): { pattern: RegExp; provider: string } | undefined {
    if (!url) {
      return undefined;
    }

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if ((hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1')
        && this.hasCursorProxyAuthHeader(headers)) {
        return {
          pattern: /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i,
          provider: 'Cursor',
        };
      }
    } catch {
      // Ignore malformed URLs.
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

  private logCursorMiss(
    url: string,
    headers: Record<string, string>,
    body: string | Buffer
  ): void {
    if (!this.log) {
      return;
    }

    const contentType = headers['content-type'] ?? 'unknown';
    const preview = this.previewRequestBody(body, headers);
    const shortUrl = this.summarizeUrl(url);
    const previewSuffix = preview ? `, preview ${preview}` : '';

    this.debug(
      `[cursor-network] Matched live request without prompt (${shortUrl}, content-type ${contentType}${previewSuffix})\nheaders=${this.safeJson(headers)}\nbody=${this.formatDebugBody(body, headers)}`
    );
  }

  private debugObservedRequest(
    transport: string,
    url: string,
    headers: Record<string, string>,
    body: string | Buffer,
    provider?: string
  ): void {
    this.debug(
      [
        `[cursor-network] Outgoing request via ${transport}${provider ? ` (${provider})` : ''}: ${url || '<unknown url>'}`,
        `headers=${this.safeJson(headers)}`,
        `body=${this.formatDebugBody(body, headers)}`,
      ].join('\n')
    );
  }

  private debugResponseChunk(
    requestId: string,
    contentType: string,
    chunk: string | Buffer
  ): void {
    const state = this.activeRequests.get(requestId);
    const label = state
      ? `${state.provider} ${this.summarizeUrl(state.url)}`
      : requestId;

    this.debug(
      [
        `[cursor-network] Response chunk for ${label} (request ${requestId}, content-type ${contentType || 'unknown'})`,
        this.formatDebugChunk(chunk, contentType),
      ].join('\n')
    );
  }

  private debugResponseBoundary(
    requestId: string,
    phase: 'complete',
    contentType: string
  ): void {
    const state = this.activeRequests.get(requestId);
    const label = state
      ? `${state.provider} ${this.summarizeUrl(state.url)}`
      : requestId;

    this.debug(
      `[cursor-network] Response ${phase} for ${label} (request ${requestId}, content-type ${contentType || 'unknown'})`
    );
  }

  private formatDebugBody(
    body: string | Buffer,
    headers: Record<string, string>
  ): string {
    if (Buffer.isBuffer(body)) {
      if (this.isConnectJsonContentType(headers['content-type'] ?? '')) {
        const payloads = this.extractConnectJsonPayloadTexts(body);
        if (payloads.length > 0) {
          return payloads
            .map((payload, index) => `connect-frame-${index + 1}=${this.prettifyDebugText(payload)}`)
            .join('\n');
        }
      }

      return this.formatDebugChunk(body, headers['content-type'] ?? '');
    }

    return this.prettifyDebugText(body);
  }

  private formatDebugChunk(
    chunk: string | Buffer,
    contentType: string
  ): string {
    if (typeof chunk === 'string') {
      return this.prettifyDebugText(chunk);
    }

    if (this.isConnectJsonContentType(contentType)) {
      const payloads = this.extractConnectJsonPayloadTexts(chunk);
      if (payloads.length > 0) {
        return payloads
          .map((payload, index) => `connect-frame-${index + 1}=${this.prettifyDebugText(payload)}`)
          .join('\n');
      }
    }

    if (this.looksPrintable(chunk)) {
      return this.prettifyDebugText(chunk.toString('utf8'));
    }

    return `hex:${chunk.toString('hex')}`;
  }

  private prettifyDebugText(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return '<empty>';
    }

    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }

  private looksPrintable(buffer: Buffer): boolean {
    if (buffer.length === 0) {
      return true;
    }

    const text = buffer.toString('utf8');
    const nonPrintable = text.replace(/[\x20-\x7e\n\r\t]/g, '');
    return nonPrintable.length <= Math.max(2, text.length * 0.1);
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private previewRequestBody(
    body: string | Buffer,
    headers: Record<string, string>
  ): string | undefined {
    let text = '';

    if (Buffer.isBuffer(body)) {
      if (this.isConnectJsonContentType(headers['content-type'] ?? '')) {
        text = this.extractConnectJsonPayloadTexts(body).join(' ');
      } else {
        text = body.toString('utf8');
      }
    } else {
      text = body;
    }

    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 220);
    return preview || undefined;
  }

  private previewSocketChunk(chunk: unknown): string | undefined {
    const buffer = this.toBuffer(chunk);
    if (buffer.length === 0) {
      return undefined;
    }

    const text = buffer.toString('utf8').replace(/\s+/g, ' ').trim();
    if (/[A-Za-z0-9/{\[\]:]/.test(text)) {
      return text.slice(0, 220);
    }

    const hexPreview = buffer.subarray(0, 48).toString('hex');
    return hexPreview ? `hex:${hexPreview}` : undefined;
  }

  private summarizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  private createRequestId(): string {
    this.requestCounter += 1;
    return `network:${Date.now()}:${this.requestCounter}`;
  }

  private debug(message: string): void {
    try {
      this.log?.(message);
    } catch {
      // Never let logging interfere with interception.
    }
  }

  private isLoopbackAddress(value: string | undefined): boolean {
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
  }
}
