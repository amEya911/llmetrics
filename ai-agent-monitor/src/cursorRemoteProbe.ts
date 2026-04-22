/* eslint-disable @typescript-eslint/no-var-requires */
import type * as httpTypes from 'http';
import type * as http2Types from 'http2';
import type * as netTypes from 'net';
import type * as httpsTypes from 'https';
import type * as diagnosticsChannelTypes from 'diagnostics_channel';
import type * as inspectorTypes from 'inspector';
import type * as vscodeTypes from 'vscode';

const diagnosticsChannel: typeof diagnosticsChannelTypes = require('diagnostics_channel');
const fs: typeof import('fs') = require('fs');
const http: typeof httpTypes = require('http');
const http2: typeof http2Types = require('http2');
const inspector: typeof inspectorTypes = require('inspector');
const net: typeof netTypes = require('net');
const https: typeof httpsTypes = require('https');
const zlib: typeof import('zlib') = require('zlib');

type ModelConfidence = 'exact' | 'inferred' | 'unknown';
type PromptCaptureConfidence = 'none' | 'weak' | 'strong' | 'exact';

export interface CursorRemoteProbeOptions {
  diagnosticLogPath?: string;
  eventLogPath: string;
  role: string;
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
  fallbackOutput: string;
  promptConfidence: PromptCaptureConfidence;
  didComplete: boolean;
  didStartEvent: boolean;
}

interface PromptExtractionResult {
  prompt: string;
  confidence: PromptCaptureConfidence;
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
  transport: string;
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

interface PendingCursorTurnSeed {
  prompt?: string;
  model?: string;
  modelConfidence: ModelConfidence;
  chatId?: string;
  observedAt: number;
}

const GLOBAL_STATE_KEY = '__aiTokenAnalyticsCursorRemoteProbe';
const WRAPPED_RESPONSE = Symbol('ai-token-analytics.cursor-remote.response');
const WRAPPED_CLIENT_REQUEST = Symbol('ai-token-analytics.cursor-remote.client-request');
const WRAPPED_SERVER_REQUEST = Symbol('ai-token-analytics.cursor-remote.server-request');
const WRAPPED_HTTP2_CLIENT_REQUEST = Symbol('ai-token-analytics.cursor-remote.http2-request');
const WRAPPED_HTTP2_SERVER_STREAM = Symbol('ai-token-analytics.cursor-remote.http2-server-stream');
const WRAPPED_LOOPBACK_SOCKET = Symbol('ai-token-analytics.cursor-remote.loopback-socket');
const WRAPPED_UNDICI_HANDLER = Symbol('ai-token-analytics.cursor-remote.undici-handler');
const WRAPPED_CONNECT_TRANSPORT = Symbol('ai-token-analytics.cursor-remote.connect-transport');
const WRAPPED_CONNECT_RESPONSE = Symbol('ai-token-analytics.cursor-remote.connect-response');
const WRAPPED_CONNECT_STREAM = Symbol('ai-token-analytics.cursor-remote.connect-stream');

interface CursorConnectInvocation {
  kind: 'unary' | 'stream';
  source: string;
  serviceName: string;
  methodName: string;
  transportHost?: string;
  headers: Record<string, string>;
  input: unknown;
  plainInput: unknown;
  requestId?: string;
}

class CursorRemoteProbe {
  private readonly options: CursorRemoteProbeOptions;
  private readonly originalHttpsRequest: typeof https.request;
  private readonly originalHttpsGet: typeof https.get;
  private readonly originalHttpRequest: typeof http.request;
  private readonly originalHttpGet: typeof http.get;
  private readonly originalHttp2Connect: typeof http2.connect;
  private readonly originalHttpServerEmit: typeof http.Server.prototype.emit;
  private readonly originalHttp2ServerEmit?: Function;
  private readonly originalHttp2SecureServerEmit?: Function;
  private readonly originalNetServerEmit: typeof net.Server.prototype.emit;
  private readonly originalClientRequestWrite: typeof http.ClientRequest.prototype.write;
  private readonly originalClientRequestEnd: typeof http.ClientRequest.prototype.end;
  private readonly originalClientRequestEmit: typeof http.ClientRequest.prototype.emit;
  private readonly originalClientHttp2SessionRequest?: Function;
  private readonly originalFetch?: typeof globalThis.fetch;
  private readonly undiciRequestCreateChannel?: diagnosticsChannelTypes.Channel;
  private readonly cursorApi?: any;
  private readonly originalRegisterConnectTransportProvider?: Function;

  private readonly activeRequests = new Map<string, InterceptedRequestState>();
  private readonly pendingCursorTurnSeeds = new Map<string, PendingCursorTurnSeed>();
  private readonly undiciCaptures = new WeakMap<object, UndiciRequestCapture>();
  private readonly prototypeClientRequestCaptures =
    new WeakMap<httpTypes.ClientRequest, PrototypeClientRequestCapture>();
  private cursorModelHint?: {
    model: string;
    confidence: ModelConfidence;
    observedAt: number;
  };

  private requestCounter = 0;
  private active = false;
  private patchedRegisterConnectTransportProvider?: Function;
  private readonly handleUndiciRequestCreate = (message: unknown): void => {
    try {
      this.interceptUndiciRequest(message);
    } catch (error) {
      this.logProbeError('undici-create', error);
    }
  };

  constructor(options: CursorRemoteProbeOptions) {
    this.options = options;
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

    try {
      const vscodeModule: typeof vscodeTypes = require('vscode');
      const cursorApi = (vscodeModule as any)?.cursor;
      if (cursorApi && typeof cursorApi.registerConnectTransportProvider === 'function') {
        this.cursorApi = cursorApi;
        this.originalRegisterConnectTransportProvider =
          cursorApi.registerConnectTransportProvider.bind(cursorApi);
      }
    } catch {
      // The remote probe can still operate without the Cursor API surface.
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
    this.patchCursorConnectTransportProvider();
    this.tryWrapExistingCursorTransportCandidates();

    if (!this.undiciRequestCreateChannel) {
      this.patchFetch();
    }

    this.writeDiagnostic({
      phase: 'install',
      role: this.options.role,
      pid: process.pid,
    });
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

    if (
      this.cursorApi
      && this.originalRegisterConnectTransportProvider
      && this.patchedRegisterConnectTransportProvider
      && this.cursorApi.registerConnectTransportProvider === this.patchedRegisterConnectTransportProvider
    ) {
      this.cursorApi.registerConnectTransportProvider = this.originalRegisterConnectTransportProvider;
    }
    this.patchedRegisterConnectTransportProvider = undefined;
  }

  private patchCursorConnectTransportProvider(): void {
    if (!this.cursorApi || !this.originalRegisterConnectTransportProvider || this.patchedRegisterConnectTransportProvider) {
      return;
    }

    this.writeDiagnostic({
      phase: 'cursor-connect-provider-detected',
      cursorApiKeys: this.listPropertyNames(this.cursorApi),
      role: this.options.role,
      pid: process.pid,
    });

    this.patchedRegisterConnectTransportProvider = (transport: unknown) => {
      const wrapped = this.wrapCursorConnectTransport(transport, 'registerConnectTransportProvider');
      this.writeDiagnostic({
        phase: 'cursor-connect-provider-register',
        isWrapped: wrapped !== transport,
        role: this.options.role,
        pid: process.pid,
      });
      return this.originalRegisterConnectTransportProvider!(wrapped);
    };

    this.cursorApi.registerConnectTransportProvider = this.patchedRegisterConnectTransportProvider;
    this.writeDiagnostic({
      phase: 'cursor-connect-provider-patched',
      role: this.options.role,
      pid: process.pid,
    });
  }

  private tryWrapExistingCursorTransportCandidates(): void {
    if (!this.cursorApi) {
      return;
    }

    for (const key of this.listPropertyNames(this.cursorApi)) {
      let value: unknown;
      try {
        value = this.cursorApi[key];
      } catch {
        continue;
      }

      if (!this.isConnectTransport(value)) {
        continue;
      }

      const wrapped = this.wrapCursorConnectTransport(value, `cursorApi.${key}`);
      if (wrapped === value) {
        continue;
      }

      try {
        this.cursorApi[key] = wrapped;
        this.writeDiagnostic({
          phase: 'cursor-connect-provider-existing-wrap',
          key,
          role: this.options.role,
          pid: process.pid,
        });
      } catch {
        this.writeDiagnostic({
          phase: 'cursor-connect-provider-existing-readonly',
          key,
          role: this.options.role,
          pid: process.pid,
        });
      }
    }
  }

  private installAlwaysLocalInternalTransportHooks(): void {
    if (this.options.role !== 'always-local') {
      return;
    }

    void this.installAlwaysLocalInternalTransportHooksAsync().catch((error) => {
      this.writeDiagnostic({
        phase: 'cursor-connect-internal-hook-failed',
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        role: this.options.role,
        pid: process.pid,
      });
    });
  }

  private async installAlwaysLocalInternalTransportHooksAsync(): Promise<void> {
    const patchPrototypeFunction = String(function patchAiConnectHandlerPrototype(stateKey: string) {
      const state = (globalThis as Record<string, any>)[stateKey];
      const probe = state?.probe;
      if (!probe) {
        return { ok: false, reason: 'probe-missing' };
      }

      if ((this as Record<string, unknown>).__aiTokenAnalyticsWrappedCreateMultiProxyTransport) {
        return { ok: true, alreadyWrapped: true };
      }

      const originalCreateMultiProxyTransport = (this as Record<string, unknown>).createMultiProxyTransport;
      if (typeof originalCreateMultiProxyTransport !== 'function') {
        return { ok: false, reason: 'createMultiProxyTransport-missing' };
      }

      (this as Record<string, unknown>).createMultiProxyTransport = function (...args: unknown[]) {
        const transport = (originalCreateMultiProxyTransport as (...callArgs: unknown[]) => unknown)
          .apply(this, args);
        try {
          return probe.wrapCursorConnectTransport(
            transport,
            'always-local.createMultiProxyTransport'
          );
        } catch {
          return transport;
        }
      };
      (this as Record<string, unknown>).__aiTokenAnalyticsWrappedCreateMultiProxyTransport = true;

      return {
        ok: true,
        alreadyWrapped: false,
      };
    });

    const patchInstanceFunction = String(function patchAiConnectHandlerInstance(stateKey: string) {
      const state = (globalThis as Record<string, any>)[stateKey];
      const probe = state?.probe;
      if (!probe) {
        return { ok: false, reason: 'probe-missing' };
      }

      const wrapCarrier = (carrier: unknown, label: string): boolean => {
        if (!carrier || typeof carrier !== 'object') {
          return false;
        }

        const carrierRecord = carrier as Record<string, unknown>;
        const current = carrierRecord.transport && typeof carrierRecord.transport === 'object'
          ? carrierRecord.transport
          : carrier;
        if (!current || typeof current !== 'object') {
          return false;
        }

        const wrapped = probe.wrapCursorConnectTransport(current, label);
        if (wrapped === current) {
          return false;
        }

        if (carrierRecord.transport === current) {
          carrierRecord.transport = wrapped;
        } else {
          const wrappedRecord = wrapped as Record<string, unknown>;
          if (typeof carrierRecord.unary === 'function' && typeof wrappedRecord.unary === 'function') {
            carrierRecord.unary = wrappedRecord.unary;
          }
          if (typeof carrierRecord.stream === 'function' && typeof wrappedRecord.stream === 'function') {
            carrierRecord.stream = wrappedRecord.stream;
          }
          if (typeof wrappedRecord.getTransportHost === 'function') {
            carrierRecord.getTransportHost = wrappedRecord.getTransportHost;
          }
        }

        return true;
      };

      const patchMap = (value: unknown, prefix: string, patched: string[]): void => {
        if (!value || typeof value !== 'object') {
          return;
        }

        for (const [key, carrier] of Object.entries(value as Record<string, unknown>)) {
          if (wrapCarrier(carrier, `${prefix}.${key}`)) {
            patched.push(`${prefix}.${key}`);
          }
        }
      };

      const patched: string[] = [];
      if (wrapCarrier((this as Record<string, unknown>)._backendTransport, 'always-local._backendTransport')) {
        patched.push('_backendTransport');
      }
      if (wrapCarrier((this as Record<string, unknown>)._bidiTransport, 'always-local._bidiTransport')) {
        patched.push('_bidiTransport');
      }

      patchMap((this as Record<string, unknown>).transportConfig, 'always-local.transportConfig', patched);
      patchMap(
        (this as Record<string, unknown>)._overrideMethodNameToTransportMap,
        'always-local.overrideMethod',
        patched
      );
      patchMap(
        (this as Record<string, unknown>)._overrideServiceNameToTransportMapLowerPriorityThanMethodOverrides,
        'always-local.overrideService',
        patched
      );

      return {
        ok: true,
        patched,
      };
    });

    const result = await this.withSelfInspectorSession(async (call) => {
      const activateEval = await call('Runtime.evaluate', {
        expression: `(() => {
  const Module = process.getBuiltinModule('module');
  const req = Module.createRequire('/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-always-local/dist/main.js');
  const main = req('/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-always-local/dist/main.js');
  return main.activate;
})()`,
        objectGroup: 'ai-token-analytics',
        returnByValue: false,
        awaitPromise: true,
      });

      const activateObjectId = activateEval?.result?.result?.objectId;
      if (!activateObjectId) {
        throw new Error('Cursor always-local activate() function was not reachable.');
      }

      const activateProperties = await call('Runtime.getProperties', {
        objectId: activateObjectId,
        ownProperties: false,
        generatePreview: false,
      });
      const scopesObjectId = activateProperties?.result?.internalProperties
        ?.find((property: any) => property?.name === '[[Scopes]]')
        ?.value?.objectId;
      if (!scopesObjectId) {
        throw new Error('Cursor always-local activate() scopes were not available.');
      }

      const scopesProperties = await call('Runtime.getProperties', {
        objectId: scopesObjectId,
        ownProperties: true,
        generatePreview: false,
      });
      const bundleScopeObjectId = scopesProperties?.result?.result
        ?.find((property: any) => property?.name === '1')
        ?.value?.objectId;
      if (!bundleScopeObjectId) {
        throw new Error('Cursor always-local webpack scope was not available.');
      }

      const bundleScopeProperties = await call('Runtime.getProperties', {
        objectId: bundleScopeObjectId,
        ownProperties: true,
        generatePreview: false,
      });
      const internalRequireObjectId = bundleScopeProperties?.result?.result
        ?.find((property: any) => property?.name === 'n')
        ?.value?.objectId;
      if (!internalRequireObjectId) {
        throw new Error('Cursor always-local internal webpack require() was not available.');
      }

      const transportModule = await call('Runtime.callFunctionOn', {
        objectId: internalRequireObjectId,
        functionDeclaration: 'function(moduleId) { return this(moduleId); }',
        arguments: [{ value: 2006 }],
        returnByValue: false,
        awaitPromise: true,
      });
      const transportModuleObjectId = transportModule?.result?.result?.objectId;
      if (!transportModuleObjectId) {
        throw new Error('Cursor always-local transport module 2006 was not reachable.');
      }

      const transportModuleProperties = await call('Runtime.getProperties', {
        objectId: transportModuleObjectId,
        ownProperties: true,
        generatePreview: false,
      });
      const handlerClassObjectId = transportModuleProperties?.result?.result
        ?.find((property: any) => property?.name === 'AiConnectTransportHandler')
        ?.value?.objectId;
      if (!handlerClassObjectId) {
        throw new Error('Cursor always-local AiConnectTransportHandler export was not reachable.');
      }

      const handlerClassProperties = await call('Runtime.getProperties', {
        objectId: handlerClassObjectId,
        ownProperties: true,
        generatePreview: false,
      });
      const prototypeObjectId = handlerClassProperties?.result?.result
        ?.find((property: any) => property?.name === 'prototype')
        ?.value?.objectId;
      if (!prototypeObjectId) {
        throw new Error('Cursor always-local AiConnectTransportHandler prototype was not reachable.');
      }

      const prototypePatch = await call('Runtime.callFunctionOn', {
        objectId: prototypeObjectId,
        functionDeclaration: patchPrototypeFunction,
        arguments: [{ value: GLOBAL_STATE_KEY }],
        returnByValue: true,
        awaitPromise: true,
      });

      const instances = await call('Runtime.queryObjects', {
        prototypeObjectId,
        objectGroup: 'ai-token-analytics',
      });
      const instancesObjectId = instances?.result?.objects?.objectId;
      if (!instancesObjectId) {
        throw new Error('Cursor always-local AiConnectTransportHandler instances were not reachable.');
      }

      const instanceArrayProperties = await call('Runtime.getProperties', {
        objectId: instancesObjectId,
        ownProperties: true,
        generatePreview: false,
      });
      const instanceEntries = (instanceArrayProperties?.result?.result ?? [])
        .filter((property: any) => /^\d+$/.test(property?.name ?? ''))
        .filter((property: any) => property?.value?.objectId);

      const instancePatches: unknown[] = [];
      for (const entry of instanceEntries) {
        const patchResult = await call('Runtime.callFunctionOn', {
          objectId: entry.value.objectId,
          functionDeclaration: patchInstanceFunction,
          arguments: [{ value: GLOBAL_STATE_KEY }],
          returnByValue: true,
          awaitPromise: true,
        });
        instancePatches.push(patchResult?.result?.result?.value);
      }

      return {
        prototypePatch: prototypePatch?.result?.result?.value,
        instanceCount: instanceEntries.length,
        instancePatches,
      };
    });

    this.writeDiagnostic({
      phase: 'cursor-connect-internal-hook-installed',
      result,
      role: this.options.role,
      pid: process.pid,
    });
  }

  private async withSelfInspectorSession<T>(
    callback: (
      call: (method: string, params?: Record<string, unknown>) => Promise<any>
    ) => Promise<T>
  ): Promise<T> {
    const session = new inspector.Session();
    session.connect();

    const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      return new Promise((resolve, reject) => {
        session.post(method, params as any, (error, result) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(result);
        });
      });
    };

    try {
      return await callback(call);
    } finally {
      session.disconnect();
    }
  }

  private wrapCursorConnectTransport(transport: unknown, source: string): unknown {
    if (!this.isConnectTransport(transport)) {
      return transport;
    }

    const maybeTransport = transport as Record<PropertyKey, unknown>;
    if (maybeTransport[WRAPPED_CONNECT_TRANSPORT]) {
      return transport;
    }

    const wrapped = Object.create(transport) as Record<PropertyKey, unknown>;
    wrapped[WRAPPED_CONNECT_TRANSPORT] = true;
    wrapped.stream = (...args: unknown[]) => {
      return this.handleCursorConnectInvocation(
        transport as { stream: (...callArgs: unknown[]) => unknown },
        'stream',
        args,
        source
      );
    };
    wrapped.unary = (...args: unknown[]) => {
      return this.handleCursorConnectInvocation(
        transport as { unary: (...callArgs: unknown[]) => unknown },
        'unary',
        args,
        source
      );
    };
    if (typeof maybeTransport.getTransportHost === 'function') {
      wrapped.getTransportHost = (...args: unknown[]) => {
        return (transport as any).getTransportHost(...args);
      };
    }

    return wrapped;
  }

  private handleCursorConnectInvocation(
    transport: { stream?: (...callArgs: unknown[]) => unknown; unary?: (...callArgs: unknown[]) => unknown; getTransportHost?: (...callArgs: unknown[]) => unknown },
    kind: 'unary' | 'stream',
    args: unknown[],
    source: string
  ): unknown {
    const invocation = this.describeCursorConnectInvocation(transport, kind, args, source);
    this.rememberCursorTurnSeed(invocation);
    const shouldCapture = this.shouldCaptureCursorConnectInvocation(invocation);
    const interceptedRequestId = shouldCapture
      ? this.registerCursorConnectRequest(invocation)
      : undefined;
    const originalMethod = kind === 'stream' ? transport.stream : transport.unary;

    this.writeDiagnostic({
      phase: 'cursor-connect-call',
      kind,
      source,
      serviceName: invocation.serviceName,
      methodName: invocation.methodName,
      transportHost: invocation.transportHost,
      headers: invocation.headers,
      requestId: invocation.requestId,
      shouldCapture,
      inputPreview: this.previewUnknown(invocation.plainInput ?? invocation.input),
      role: this.options.role,
      pid: process.pid,
    });

    if (typeof originalMethod !== 'function') {
      return undefined;
    }

    try {
      const result = originalMethod.apply(transport, args as any);
      return kind === 'stream'
        ? this.wrapCursorConnectStreamResult(result, invocation, interceptedRequestId)
        : this.wrapCursorConnectUnaryResult(result, invocation, interceptedRequestId);
    } catch (error) {
      this.writeDiagnostic({
        phase: 'cursor-connect-call-error',
        kind,
        serviceName: invocation.serviceName,
        methodName: invocation.methodName,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        role: this.options.role,
        pid: process.pid,
      });
      if (interceptedRequestId) {
        this.completeRequest(interceptedRequestId);
      }
      throw error;
    }
  }

  private describeCursorConnectInvocation(
    transport: { getTransportHost?: (...callArgs: unknown[]) => unknown },
    kind: 'unary' | 'stream',
    args: unknown[],
    source: string
  ): CursorConnectInvocation {
    const service = args[0] as Record<string, unknown> | undefined;
    const method = args[1] as Record<string, unknown> | undefined;
    const headers = this.normalizeConnectHeaders(args[4]);
    const input = args[5];
    const plainInput = this.coerceToPlainObject(input);
    const serviceName = typeof service?.typeName === 'string'
      ? service.typeName
      : typeof service?.name === 'string'
        ? service.name
        : 'unknown-service';
    const methodName = typeof method?.name === 'string'
      ? method.name
      : 'unknown-method';
    const transportHost = this.resolveConnectTransportHost(transport, serviceName, methodName);
    const requestId = headers['x-request-id']
      || this.findStringByKeys(plainInput, ['requestId', 'request_id', 'invocationId', 'invocation_id']);

    return {
      kind,
      source,
      serviceName,
      methodName,
      transportHost,
      headers,
      input,
      plainInput,
      requestId: typeof requestId === 'string' && requestId.trim() ? requestId.trim() : undefined,
    };
  }

  private shouldCaptureCursorConnectInvocation(invocation: CursorConnectInvocation): boolean {
    const normalizedService = invocation.serviceName.toLowerCase();
    const normalizedMethod = invocation.methodName.toLowerCase();
    return normalizedService.includes('chatservice')
      || normalizedService.includes('backgroundcomposerservice')
      || normalizedService.includes('agentservice')
      || normalizedMethod.includes('streamunifiedchatwithtools')
      || normalizedMethod.includes('streamconversation')
      || normalizedMethod.includes('attachbackgroundcomposer')
      || normalizedMethod === 'run';
  }

  private registerCursorConnectRequest(invocation: CursorConnectInvocation): string {
    const payload = this.parseCursorConnectPayload(invocation);
    const seed = this.consumeCursorTurnSeed(invocation);
    if (!payload.prompt && seed?.prompt) {
      payload.prompt = seed.prompt;
    }
    if (!payload.model && seed?.model) {
      payload.model = seed.model;
      payload.modelConfidence = seed.modelConfidence;
    }
    if (!payload.chatId && seed?.chatId) {
      payload.chatId = seed.chatId;
    }
    const modelHint = this.shouldApplyCursorModelHint(invocation)
      ? this.getRecentCursorModelHint()
      : undefined;
    if (!payload.model && modelHint) {
      payload.model = modelHint.model;
      payload.modelConfidence = 'inferred';
    }
    const requestId = this.createRequestId();
    const url = this.buildCursorConnectUrl(invocation);
    const hasPrompt = Boolean(payload.prompt?.trim());
    const state: InterceptedRequestState = {
      requestId,
      provider: 'Cursor',
      url,
      prompt: payload.prompt?.trim() ?? '',
      model: payload.model,
      modelConfidence: payload.modelConfidence,
      chatId: payload.chatId,
      startedAt: Date.now(),
      isStreaming: true,
      thinking: '',
      output: '',
      fallbackOutput: '',
      promptConfidence: hasPrompt ? 'exact' : 'none',
      didComplete: false,
      didStartEvent: hasPrompt,
    };

    this.activeRequests.set(requestId, state);
    this.writeDiagnostic({
      phase: 'cursor-connect-request',
      requestId,
      transport: 'cursor-connect',
      serviceName: invocation.serviceName,
      methodName: invocation.methodName,
      url,
      headers: invocation.headers,
      role: this.options.role,
      pid: process.pid,
      hasPrompt,
      model: payload.model,
      chatId: payload.chatId,
      input: this.serializeUnknown(invocation.plainInput ?? invocation.input),
      inputPreview: this.previewUnknown(invocation.plainInput ?? invocation.input),
    });

    if (hasPrompt) {
      this.writeEvent({
        phase: 'turn-start',
        role: this.options.role,
        pid: process.pid,
        requestId: state.requestId,
        provider: state.provider,
        url: state.url,
        prompt: state.prompt,
        model: state.model,
        modelConfidence: state.modelConfidence,
        chatId: state.chatId,
        startedAt: state.startedAt,
        isStreaming: state.isStreaming,
      });
    } else {
      this.writeDiagnostic({
        phase: 'cursor-connect-request-no-prompt',
        requestId,
        serviceName: invocation.serviceName,
        methodName: invocation.methodName,
        role: this.options.role,
        pid: process.pid,
      });
    }

    return requestId;
  }

  private rememberCursorTurnSeed(invocation: CursorConnectInvocation): void {
    const normalizedService = invocation.serviceName.toLowerCase();
    const normalizedMethod = invocation.methodName.toLowerCase();
    if (!normalizedService.includes('aiservice') || normalizedMethod !== 'nametab') {
      return;
    }

    const seedId = invocation.requestId?.trim();
    if (!seedId) {
      return;
    }

    const payload = this.parseCursorConnectPayload(invocation);
    if (!payload.prompt && !payload.model && !payload.chatId) {
      return;
    }

    this.pendingCursorTurnSeeds.set(seedId, {
      prompt: payload.prompt?.trim() || undefined,
      model: payload.model,
      modelConfidence: payload.modelConfidence,
      chatId: payload.chatId,
      observedAt: Date.now(),
    });

    this.writeDiagnostic({
      phase: 'cursor-turn-seed',
      sourceServiceName: invocation.serviceName,
      sourceMethodName: invocation.methodName,
      seedId,
      prompt: payload.prompt,
      model: payload.model,
      chatId: payload.chatId,
      role: this.options.role,
      pid: process.pid,
    });
  }

  private consumeCursorTurnSeed(invocation: CursorConnectInvocation): PendingCursorTurnSeed | undefined {
    const seedKeys = [
      invocation.headers['x-original-request-id'],
      invocation.headers['x-request-id'],
      invocation.requestId,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());

    for (const key of seedKeys) {
      const seed = this.pendingCursorTurnSeeds.get(key);
      if (!seed) {
        continue;
      }

      this.pendingCursorTurnSeeds.delete(key);
      if (Date.now() - seed.observedAt > 2 * 60 * 1000) {
        return undefined;
      }

      return seed;
    }

    return undefined;
  }

  private wrapCursorConnectUnaryResult(
    result: unknown,
    invocation: CursorConnectInvocation,
    requestId: string | undefined
  ): unknown {
    if (typeof (result as PromiseLike<unknown>)?.then !== 'function') {
      if (requestId) {
        this.completeRequest(requestId);
      }
      return result;
    }

    return Promise.resolve(result)
      .then((response) => {
        const plainResponse = this.coerceToPlainObject(response);
        this.maybeUpdateCursorModelHint(invocation, plainResponse);
        this.writeDiagnostic({
          phase: 'cursor-connect-unary-response',
          serviceName: invocation.serviceName,
          methodName: invocation.methodName,
          responsePreview: this.previewUnknown(plainResponse),
          role: this.options.role,
          pid: process.pid,
        });
        if (requestId) {
          this.completeRequest(requestId);
        }
        return response;
      })
      .catch((error) => {
        this.writeDiagnostic({
          phase: 'cursor-connect-unary-error',
          serviceName: invocation.serviceName,
          methodName: invocation.methodName,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
          role: this.options.role,
          pid: process.pid,
        });
        if (requestId) {
          this.completeRequest(requestId);
        }
        throw error;
      });
  }

  private wrapCursorConnectStreamResult(
    result: unknown,
    invocation: CursorConnectInvocation,
    requestId: string | undefined
  ): unknown {
    const wrapResponse = (response: unknown): unknown => {
      const plainResponse = this.coerceToPlainObject(response);
      this.maybeApplyCursorResponseMetadata(requestId, plainResponse);
      this.writeDiagnostic({
        phase: 'cursor-connect-stream-response',
        serviceName: invocation.serviceName,
        methodName: invocation.methodName,
        responseKeys: this.listPropertyNames(response),
        responsePreview: this.previewUnknown(plainResponse),
        role: this.options.role,
        pid: process.pid,
      });

      if (!requestId) {
        return response;
      }

      if (this.isAsyncIterable(response)) {
        return this.wrapCursorConnectMessageStream(response as AsyncIterable<unknown>, invocation, requestId);
      }

      if (!response || typeof response !== 'object') {
        this.completeRequest(requestId);
        return response;
      }

      const maybeResponse = response as Record<PropertyKey, unknown>;
      if (maybeResponse[WRAPPED_CONNECT_RESPONSE]) {
        return response;
      }

      const wrapped = Object.create(response) as Record<PropertyKey, unknown>;
      wrapped[WRAPPED_CONNECT_RESPONSE] = true;

      if (this.isAsyncIterable(maybeResponse.message)) {
        wrapped.message = this.wrapCursorConnectMessageStream(
          maybeResponse.message as AsyncIterable<unknown>,
          invocation,
          requestId
        );
      } else {
        this.completeRequest(requestId);
      }

      return wrapped;
    };

    if (typeof (result as PromiseLike<unknown>)?.then !== 'function') {
      return wrapResponse(result);
    }

    return Promise.resolve(result)
      .then((response) => wrapResponse(response))
      .catch((error) => {
        this.writeDiagnostic({
          phase: 'cursor-connect-stream-error',
          serviceName: invocation.serviceName,
          methodName: invocation.methodName,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
          role: this.options.role,
          pid: process.pid,
        });
        if (requestId) {
          this.completeRequest(requestId);
        }
        throw error;
      });
  }

  private async *wrapCursorConnectMessageStream(
    stream: AsyncIterable<unknown>,
    invocation: CursorConnectInvocation,
    requestId: string
  ): AsyncGenerator<unknown, void, unknown> {
    const maybeStream = stream as unknown as Record<PropertyKey, unknown>;
    if (maybeStream[WRAPPED_CONNECT_STREAM]) {
      for await (const message of stream) {
        yield message;
      }
      return;
    }

    maybeStream[WRAPPED_CONNECT_STREAM] = true;
    let chunkCount = 0;
    try {
      for await (const message of stream) {
        chunkCount += 1;
        const plainMessage = this.coerceToPlainObject(message);
        this.inspectCursorConnectStreamMessage(requestId, plainMessage);
        const pieces = this.extractCursorConnectResponsePieces(plainMessage);
        for (const piece of pieces) {
          this.appendResponsePiece(requestId, piece);
        }

        this.writeDiagnostic({
          phase: 'cursor-connect-stream-message',
          serviceName: invocation.serviceName,
          methodName: invocation.methodName,
          requestId,
          chunkCount,
          pieceCount: pieces.length,
          preview: this.previewUnknown(plainMessage),
          payload: chunkCount <= 4 ? this.serializeUnknown(plainMessage) : undefined,
          role: this.options.role,
          pid: process.pid,
        });

        yield message;
      }
    } catch (error) {
      this.writeDiagnostic({
        phase: 'cursor-connect-stream-iteration-error',
        serviceName: invocation.serviceName,
        methodName: invocation.methodName,
        requestId,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        role: this.options.role,
        pid: process.pid,
      });
      throw error;
    } finally {
      this.writeDiagnostic({
        phase: 'cursor-connect-stream-complete',
        serviceName: invocation.serviceName,
        methodName: invocation.methodName,
        requestId,
        chunkCount,
        role: this.options.role,
        pid: process.pid,
      });
      this.completeRequest(requestId);
    }
  }

  private shouldApplyCursorModelHint(invocation: CursorConnectInvocation): boolean {
    const normalizedService = invocation.serviceName.toLowerCase();
    const normalizedMethod = invocation.methodName.toLowerCase();
    return normalizedService.includes('agentservice')
      || normalizedService.includes('chatservice')
      || normalizedService.includes('backgroundcomposerservice')
      || normalizedMethod === 'run'
      || normalizedMethod.includes('streamconversation')
      || normalizedMethod.includes('streamunifiedchatwithtools');
  }

  private getRecentCursorModelHint(): { model: string; confidence: ModelConfidence } | undefined {
    if (!this.cursorModelHint) {
      return undefined;
    }

    if (Date.now() - this.cursorModelHint.observedAt > 2 * 60 * 1000) {
      return undefined;
    }

    return {
      model: this.cursorModelHint.model,
      confidence: this.cursorModelHint.confidence,
    };
  }

  private maybeUpdateCursorModelHint(
    invocation: CursorConnectInvocation,
    response: unknown
  ): void {
    const normalizedMethod = invocation.methodName.toLowerCase();
    if (
      normalizedMethod !== 'getdefaultmodel'
      && normalizedMethod !== 'getdefaultmodelnudgedata'
      && normalizedMethod !== 'getselectedmodel'
    ) {
      return;
    }

    const model = this.extractCursorModelCandidate(response);
    if (!model) {
      return;
    }

    this.cursorModelHint = {
      model,
      confidence: normalizedMethod === 'getdefaultmodel' ? 'exact' : 'inferred',
      observedAt: Date.now(),
    };

    this.writeDiagnostic({
      phase: 'cursor-model-hint',
      serviceName: invocation.serviceName,
      methodName: invocation.methodName,
      model,
      confidence: this.cursorModelHint.confidence,
      role: this.options.role,
      pid: process.pid,
    });
  }

  private maybeApplyCursorResponseMetadata(
    requestId: string | undefined,
    response: unknown
  ): void {
    if (!requestId) {
      return;
    }

    const state = this.activeRequests.get(requestId);
    if (!state) {
      return;
    }

    if (!state.model) {
      const model = this.extractCursorModelCandidate(response);
      if (model) {
        state.model = model;
        state.modelConfidence = 'inferred';
      }
    }

    if (!state.chatId) {
      const chatId = this.findStringByKeys(response, [
        'conversationId',
        'conversation_id',
        'composerId',
        'composer_id',
        'chatId',
        'chat_id',
        'threadId',
        'thread_id',
      ]);
      if (chatId && chatId.trim().length <= 200) {
        state.chatId = chatId.trim();
      }
    }

    this.emitTurnStartIfReady(requestId);
  }

  private inspectCursorConnectStreamMessage(
    requestId: string,
    message: unknown
  ): void {
    const state = this.activeRequests.get(requestId);
    if (!state || state.didComplete) {
      return;
    }

    const promptCandidate = this.extractCursorPromptFromStreamMessage(message);
    if (
      promptCandidate
      && this.isBetterPromptCandidate(promptCandidate.confidence, state.promptConfidence)
    ) {
      state.prompt = promptCandidate.prompt;
      state.promptConfidence = promptCandidate.confidence;
    }

    if (!state.fallbackOutput) {
      const fallbackOutput = this.extractCursorAssistantFallbackFromStreamMessage(message);
      if (fallbackOutput) {
        state.fallbackOutput = fallbackOutput;
      }
    }

    if (!state.model) {
      const model = this.extractCursorModelCandidate(message) ?? this.getRecentCursorModelHint()?.model;
      if (model) {
        state.model = model;
        state.modelConfidence = 'inferred';
      }
    }

    if (!state.chatId) {
      const chatId = this.findStringByKeys(message, [
        'conversationId',
        'conversation_id',
        'composerId',
        'composer_id',
        'chatId',
        'chat_id',
        'threadId',
        'thread_id',
      ]);
      if (chatId && chatId.trim().length <= 200) {
        state.chatId = chatId.trim();
      }
    }

    this.emitTurnStartIfReady(requestId);
  }

  private emitTurnStartIfReady(requestId: string): void {
    const state = this.activeRequests.get(requestId);
    if (!state || state.didStartEvent) {
      return;
    }

    if (!state.prompt.trim()) {
      return;
    }

    if (!this.isPromptReadyForEmission(state.promptConfidence)) {
      return;
    }

    state.didStartEvent = true;
    this.writeEvent({
      phase: 'turn-start',
      role: this.options.role,
      pid: process.pid,
      requestId: state.requestId,
      provider: state.provider,
      url: state.url,
      prompt: state.prompt,
      model: state.model,
      modelConfidence: state.modelConfidence,
      chatId: state.chatId,
      startedAt: state.startedAt,
      isStreaming: state.isStreaming,
    });

    if (state.thinking) {
      this.writeEvent({
        phase: 'turn-chunk',
        role: this.options.role,
        pid: process.pid,
        requestId: state.requestId,
        provider: state.provider,
        kind: 'agent-thinking',
        content: state.thinking,
      });
    }

    if (state.output) {
      this.writeEvent({
        phase: 'turn-chunk',
        role: this.options.role,
        pid: process.pid,
        requestId: state.requestId,
        provider: state.provider,
        kind: 'agent-output',
        content: state.output,
      });
    }
  }

  private extractCursorPromptFromStreamMessage(value: unknown): PromptExtractionResult | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const interactionUpdate = (value as Record<string, unknown>).interactionUpdate;
    if (interactionUpdate && typeof interactionUpdate === 'object') {
      const userMessageAppended = (interactionUpdate as Record<string, unknown>).userMessageAppended;
      const text = this.sanitizeCursorPromptText(
        this.readTextLike((userMessageAppended as any)?.userMessage ?? userMessageAppended)
      );
      if (text) {
        return {
          prompt: text,
          confidence: 'exact',
        };
      }
    }

    const kvServerMessage = (value as Record<string, unknown>).kvServerMessage;
    if (kvServerMessage && typeof kvServerMessage === 'object') {
      const blobText = this.decodeCursorBlobDataToText((kvServerMessage as any)?.setBlobArgs?.blobData);
      if (!blobText) {
        return undefined;
      }

      const jsonEnvelope = this.extractCursorBlobJsonEnvelope(blobText);
      if (jsonEnvelope) {
        if (jsonEnvelope.role !== 'user') {
          return undefined;
        }

        const directText = this.sanitizeCursorPromptText(jsonEnvelope.text);
        return directText
          ? {
            prompt: directText,
            confidence: 'exact',
          }
          : undefined;
      }

      const lexicalText = this.extractCursorLexicalText(blobText);
      if (lexicalText) {
        return {
          prompt: lexicalText,
          confidence: 'strong',
        };
      }

      const fallbackText = this.extractCursorLeadingPrintableText(blobText);
      return fallbackText
        ? {
          prompt: fallbackText,
          confidence: 'weak',
        }
        : undefined;
    }

    return undefined;
  }

  private extractCursorAssistantFallbackFromStreamMessage(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const kvServerMessage = (value as Record<string, unknown>).kvServerMessage;
    if (!kvServerMessage || typeof kvServerMessage !== 'object') {
      return undefined;
    }

    const blobText = this.decodeCursorBlobDataToText((kvServerMessage as any)?.setBlobArgs?.blobData);
    if (!blobText) {
      return undefined;
    }

    const jsonEnvelope = this.extractCursorBlobJsonEnvelope(blobText);
    if (jsonEnvelope?.role === 'assistant') {
      return jsonEnvelope.text;
    }

    return undefined;
  }

  private decodeCursorBlobDataToText(blobData: unknown): string | undefined {
    if (typeof blobData !== 'string' || !blobData.trim()) {
      return undefined;
    }

    try {
      return Buffer.from(blobData, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  private extractCursorLexicalText(blobText: string): string | undefined {
    const rootIndex = blobText.indexOf('{"root":');
    if (rootIndex === -1) {
      return undefined;
    }

    for (let end = blobText.lastIndexOf('}'); end > rootIndex; end = blobText.lastIndexOf('}', end - 1)) {
      const candidate = blobText.slice(rootIndex, end + 1);
      try {
        const parsed = JSON.parse(candidate);
        const text = this.collectCursorLexicalText(parsed.root);
        const sanitized = this.sanitizeCursorPromptText(text);
        if (sanitized) {
          return sanitized;
        }
      } catch {
        // Keep trimming the suffix until the lexical JSON parses.
      }
    }

    return undefined;
  }

  private collectCursorLexicalText(node: unknown): string {
    if (!node || typeof node !== 'object') {
      return '';
    }

    const parts: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') {
        return;
      }

      if (typeof (value as any).text === 'string' && (value as any).text.trim()) {
        parts.push((value as any).text.trim());
      }

      if (Array.isArray((value as any).children)) {
        for (const child of (value as any).children) {
          visit(child);
        }
      }
    };

    visit(node);
    return parts.join('\n').trim();
  }

  private extractCursorBlobContentTextFromJson(
    blobText: string,
    expectedRole: 'user' | 'assistant'
  ): string | undefined {
    const envelope = this.extractCursorBlobJsonEnvelope(blobText);
    if (!envelope || envelope.role !== expectedRole) {
      return undefined;
    }

    return expectedRole === 'user'
      ? this.sanitizeCursorPromptText(envelope.text)
      : envelope.text;
  }

  private extractCursorBlobJsonEnvelope(blobText: string): { role?: string; text?: string } | undefined {
    const trimmed = blobText.trim();
    if (!trimmed.startsWith('{')) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed) as {
        role?: string;
        content?: string | Array<{ type?: string; text?: string; content?: string }>;
      };

      let text = '';
      if (typeof parsed.content === 'string') {
        text = parsed.content.trim();
      } else if (Array.isArray(parsed.content)) {
        text = parsed.content
          .map((entry) => {
            if (typeof entry?.text === 'string') {
              return entry.text;
            }
            if (typeof entry?.content === 'string') {
              return entry.content;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim();
      }

      return {
        role: typeof parsed.role === 'string' ? parsed.role : undefined,
        text: text || undefined,
      };
    } catch {
      return undefined;
    }
  }

  private extractCursorLeadingPrintableText(blobText: string): string | undefined {
    const matches = blobText.match(/[\x20-\x7E]{8,}/g) ?? [];
    for (const match of matches) {
      const trimmed = match.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith('{') || trimmed.startsWith('file://') || trimmed.startsWith('msg_')) {
        continue;
      }
      if (/^[0-9a-f-]{20,}$/i.test(trimmed)) {
        continue;
      }

      const sanitized = this.sanitizeCursorPromptText(trimmed);
      if (sanitized) {
        return sanitized;
      }
    }

    return undefined;
  }

  private sanitizeCursorPromptText(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
      return undefined;
    }

    if (
      trimmed.startsWith('<open_and_recently_viewed_files>')
      || trimmed.startsWith('<user_info>')
      || trimmed.startsWith('<agent_transcripts>')
      || trimmed.startsWith('<agent_skills>')
      || trimmed.startsWith('<general>')
      || trimmed.startsWith('<system-communication>')
      || trimmed.startsWith('<persistence>')
      || trimmed.startsWith('<editing_constraints>')
      || trimmed.startsWith('<special_user_requests>')
      || trimmed.startsWith('<mode_selection>')
      || trimmed.startsWith('<linter_errors>')
      || trimmed.startsWith('<terminal_files_information>')
      || trimmed.startsWith('<working_with_the_user>')
      || trimmed.startsWith('<main_goal>')
      || trimmed.startsWith('You are Codex ')
      || trimmed.includes('<user_info>')
      || trimmed.includes('<agent_transcripts>')
      || trimmed.includes('<agent_skills>')
      || trimmed.includes('Workspace Path:')
      || trimmed.includes('Terminals folder:')
      || trimmed.includes('Agent transcripts (past chats)')
      || /^[A-Za-z_+-]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(trimmed)
      || trimmed.startsWith('file://')
      || trimmed.includes('file:///')
      || this.looksLikeFileSystemPath(trimmed)
      || trimmed.includes('open_and_recently_viewed_files')
      || trimmed.includes('User currently')
    ) {
      return undefined;
    }

    return trimmed;
  }

  private looksLikeFileSystemPath(value: string): boolean {
    const unquoted = value.replace(/^['"]+|['"]+$/g, '').trim();
    if (!unquoted) {
      return false;
    }

    return /^\/(?:[^/\r\n]+\/)+[^/\r\n]*$/.test(unquoted)
      || /^[A-Za-z]:\\(?:[^\\\r\n]+\\)+[^\\\r\n]*$/.test(unquoted);
  }

  private isPromptReadyForEmission(confidence: PromptCaptureConfidence): boolean {
    return confidence === 'strong' || confidence === 'exact';
  }

  private isBetterPromptCandidate(
    nextConfidence: PromptCaptureConfidence,
    currentConfidence: PromptCaptureConfidence
  ): boolean {
    return this.getPromptConfidenceRank(nextConfidence) > this.getPromptConfidenceRank(currentConfidence);
  }

  private getPromptConfidenceRank(confidence: PromptCaptureConfidence): number {
    switch (confidence) {
      case 'exact':
        return 3;
      case 'strong':
        return 2;
      case 'weak':
        return 1;
      default:
        return 0;
    }
  }

  private extractCursorModelCandidate(value: unknown): string | undefined {
    const candidate = this.findStringByKeys(value, [
      'defaultModel',
      'default_model',
      'selectedModel',
      'selected_model',
      'primaryModelName',
      'primary_model_name',
      'modelId',
      'model_id',
      'modelName',
      'model_name',
      'model',
    ]);

    if (!candidate) {
      return undefined;
    }

    const trimmed = candidate.trim();
    return trimmed && trimmed.length <= 120 ? trimmed : undefined;
  }

  private parseCursorConnectPayload(invocation: CursorConnectInvocation): ParsedRequestPayload {
    const value = invocation.plainInput ?? invocation.input;
    const prompt = this.extractPromptFromCandidates([value]);
    const model = this.findStringByKeys(value, [
      'model',
      'modelName',
      'modelId',
      'model_id',
      'selectedModel',
      'selected_model',
      'requestedModel',
      'primaryModelName',
      'agentModel',
      'agent_model',
      'llmModel',
      'llm_model',
    ]);
    const chatId = this.findStringByKeys(value, [
      'conversationId',
      'conversation_id',
      'composerId',
      'composer_id',
      'trajectoryId',
      'trajectory_id',
      'chatId',
      'chat_id',
      'threadId',
      'thread_id',
      'sessionId',
      'session_id',
    ]);
    return {
      prompt,
      model,
      modelConfidence: model ? 'exact' : 'unknown',
      chatId: chatId && chatId.trim().length <= 200 ? chatId.trim() : undefined,
      isStreaming: true,
    };
  }

  private buildCursorConnectUrl(invocation: CursorConnectInvocation): string {
    const host = invocation.transportHost;
    if (!host) {
      return `cursor-connect://${invocation.serviceName}/${invocation.methodName}`;
    }

    if (/^https?:\/\//i.test(host)) {
      return `${host.replace(/\/+$/, '')}/${invocation.serviceName}/${invocation.methodName}`;
    }

    return `https://${host.replace(/\/+$/, '')}/${invocation.serviceName}/${invocation.methodName}`;
  }

  private extractCursorConnectResponsePieces(value: unknown): ResponsePiece[] {
    const plainValue = this.coerceToPlainObject(value);
    if (!plainValue || typeof plainValue !== 'object') {
      return [];
    }

    const interactionUpdate = (plainValue as Record<string, unknown>).interactionUpdate;
    if (interactionUpdate && typeof interactionUpdate === 'object') {
      return this.extractCursorInteractionUpdatePieces(interactionUpdate);
    }

    const envelope = this.getCaseEnvelope(plainValue);
    if (envelope) {
      switch (envelope.caseName.toLowerCase()) {
        case 'thinkingdelta':
        case 'reasoningdelta':
          return this.compactPieces([
            { kind: 'agent-thinking', content: this.readTextLike(envelope.value) },
          ]);
        case 'textdelta':
        case 'contentdelta':
        case 'outputdelta':
        case 'messagedelta':
          return this.compactPieces([
            { kind: 'agent-output', content: this.readTextLike(envelope.value) },
          ]);
        case 'thinkingcompleted':
        case 'turnended':
        case 'done':
          return [];
        default: {
          const nestedPieces = this.extractResponsePiecesFromJson(envelope.value);
          if (nestedPieces.length > 0) {
            return nestedPieces;
          }
        }
      }
    }

    return this.extractResponsePiecesFromJson(plainValue);
  }

  private extractCursorInteractionUpdatePieces(value: unknown): ResponsePiece[] {
    if (!value || typeof value !== 'object') {
      return [];
    }

    const update = value as Record<string, unknown>;
    return this.compactPieces([
      { kind: 'agent-thinking', content: this.readTextLike(update.thinkingDelta) },
      { kind: 'agent-thinking', content: this.readTextLike(update.reasoningDelta) },
      { kind: 'agent-output', content: this.readTextLike((update.textDelta as any)?.text ?? update.textDelta) },
      { kind: 'agent-output', content: this.readTextLike((update.contentDelta as any)?.text ?? update.contentDelta) },
      { kind: 'agent-output', content: this.readTextLike((update.outputDelta as any)?.text ?? update.outputDelta) },
      { kind: 'agent-output', content: this.readTextLike((update.messageDelta as any)?.text ?? update.messageDelta) },
    ]);
  }

  private subscribeUndiciDiagnostics(): void {
    this.undiciRequestCreateChannel?.subscribe(this.handleUndiciRequestCreate);
  }

  private unsubscribeUndiciDiagnostics(): void {
    this.undiciRequestCreateChannel?.unsubscribe(this.handleUndiciRequestCreate);
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
      } catch (error) {
        self.logProbeError(`${protocol}-request`, error);
      }
      return req;
    };

    mod.get = function (...args: any[]): httpTypes.ClientRequest {
      const req: httpTypes.ClientRequest = originalGet.apply(this, args as any);
      try {
        self.interceptOutgoingRequest(req, args, protocol);
      } catch (error) {
        self.logProbeError(`${protocol}-get`, error);
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
      } catch (error) {
        self.logProbeError('http2-connect', error);
      }
      return session;
    };
  }

  private patchClientRequestPrototype(): void {
    const self = this;

    http.ClientRequest.prototype.write = function (chunk: any, ...rest: any[]): boolean {
      try {
        self.capturePrototypeClientRequestChunk(this as httpTypes.ClientRequest, chunk);
      } catch (error) {
        self.logProbeError('client-request-write', error);
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
      } catch (error) {
        self.logProbeError('client-request-end', error);
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
            self.observeHttpResponse(
              eventArgs[0] as httpTypes.IncomingMessage,
              requestId,
              'prototype-client-request'
            );
          }
        } else if (eventName === 'error' || eventName === 'abort') {
          if (capture.requestId) {
            self.completeRequest(capture.requestId);
          }
        } else if (eventName === 'close' && capture.requestId && !capture.responseObserved) {
          self.completeRequest(capture.requestId);
        }
      } catch (error) {
        self.logProbeError('client-request-emit', error);
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
      } catch (error) {
        self.logProbeError('http2-session-request', error);
      }
      return stream;
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
        } catch (error) {
          self.logProbeError('fetch-response', error);
          self.completeRequest(intercepted.requestId);
        }
      }

      return response;
    }) as typeof globalThis.fetch;
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
      } catch (error) {
        self.logProbeError('incoming-http-server', error);
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
        } catch (error) {
          self.logProbeError('incoming-http2-server', error);
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
      } catch (error) {
        self.logProbeError('incoming-net-server', error);
      }

      return (originalEmit as any).apply(this, [eventName, ...args]);
    };
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
        // Ignore malformed request chunks.
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
        requestId = this.registerRequest(
          endpoint.provider,
          protocol,
          details.url,
          details.headers,
          requestBody
        )?.requestId;
      } catch (error) {
        this.logProbeError(`${protocol}-request-end`, error);
      }

      return (originalEnd as any).apply(req, endArgs);
    }) as typeof req.end;

    req.once('response', (res: httpTypes.IncomingMessage) => {
      if (!requestId) {
        return;
      }

      try {
        this.observeHttpResponse(res, requestId, `${protocol}-client`);
      } catch (error) {
        this.logProbeError(`${protocol}-response`, error);
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
      } catch (error) {
        this.logProbeError('http2-session-intercept', error);
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
        // Ignore malformed request chunks.
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
        requestId = this.registerRequest(
          endpoint.provider,
          'http2',
          details.url,
          details.headers,
          requestBody
        )?.requestId;
      } catch (error) {
        this.logProbeError('http2-request-end', error);
      }

      return (originalEnd as any).apply(stream, endArgs);
    }) as typeof stream.end;

    const originalEmit = stream.emit;
    let observer: DecodedChunkObserver | undefined;

    stream.emit = ((eventName: string | symbol, ...eventArgs: any[]): boolean => {
      try {
        if (eventName === 'response' && requestId) {
          const responseHeaders = this.normalizeHeaders(eventArgs[0]);
          this.writeDiagnostic({
            phase: 'response-headers',
            requestId,
            transport: 'http2',
            url: details.url,
            headers: responseHeaders,
            statusCode: responseHeaders[':status']
              ? Number.parseInt(responseHeaders[':status'], 10)
              : undefined,
            role: this.options.role,
            pid: process.pid,
          });
          observer = this.createResponseObserver(
            requestId,
            'http2',
            details.url,
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
      } catch (error) {
        this.logProbeError('http2-stream-emit', error);
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
      transport: 'undici',
      url: details.url,
      headers: details.headers,
      bodyChunks: [],
      attemptedRegistration: false,
    };

    this.undiciCaptures.set(request, capture);
    this.wrapUndiciRequestBody(request as Record<string, unknown>, capture);
    this.wrapUndiciRequestHandler(request as Record<string, unknown>, capture);
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
        if (capture.requestId) {
          this.writeDiagnostic({
            phase: 'response-headers',
            requestId: capture.requestId,
            transport: capture.transport,
            url: capture.url,
            headers: capture.responseHeaders,
            statusCode: typeof args[0] === 'number' ? args[0] : undefined,
            role: this.options.role,
            pid: process.pid,
          });
        }
        capture.responseObserver = this.ensureUndiciResponseObserver(capture);
      } catch (error) {
        this.logProbeError('undici-onHeaders', error);
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
      } catch (error) {
        this.logProbeError('undici-onData', error);
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
      } catch (error) {
        this.logProbeError('undici-onComplete', error);
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
      } catch (observerError) {
        this.logProbeError('undici-onError', observerError);
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
    const registered = this.registerRequest(
      capture.provider,
      capture.transport,
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
      capture.transport,
      capture.url,
      contentType,
      contentEncoding,
      isStreaming
    );
    return capture.responseObserver;
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

    const registered = this.registerRequest(
      endpoint.provider,
      'prototype-client-request',
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

  private async captureFetchRequest(
    input: any,
    init?: any
  ): Promise<{ requestId: string; isStreaming: boolean } | undefined> {
    const url = this.extractFetchUrl(input);
    const headers = await this.extractFetchHeaders(input, init);
    const endpoint = this.matchEndpoint(url, headers);
    if (!endpoint || this.shouldIgnoreRequest(headers)) {
      return undefined;
    }

    const body = await this.readFetchBody(input, init);
    const registered = this.registerRequest(endpoint.provider, 'fetch', url, headers, body);
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
    const state = this.activeRequests.get(requestId);
    const url = state?.url ?? '';
    const contentType = response.headers.get('content-type') || '';
    const contentEncoding = response.headers.get('content-encoding') || '';
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const isConnectJson = this.isConnectJsonContentType(contentType);
    const isStreaming = isStreamingHint
      || /text\/event-stream/i.test(contentType)
      || /stream/i.test(contentType)
      || /ndjson/i.test(contentType)
      || isConnectJson;

    this.writeDiagnostic({
      phase: 'response-headers',
      requestId,
      transport: 'fetch',
      url,
      statusCode: response.status,
      headers: responseHeaders,
      role: this.options.role,
      pid: process.pid,
    });

    if (!isStreaming) {
      const body = Buffer.from(await response.arrayBuffer());
      this.writeResponseChunkDiagnostic(requestId, 'fetch', url, contentType, body);
      const pieces = this.extractResponsePiecesFromBody(body, contentType);
      for (const piece of pieces) {
        this.appendResponsePiece(requestId, piece);
      }
      this.writeDiagnostic({
        phase: 'response-end',
        requestId,
        transport: 'fetch',
        url,
        role: this.options.role,
        pid: process.pid,
      });
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

        const chunk = Buffer.from(value);
        this.writeResponseChunkDiagnostic(requestId, 'fetch', url, contentType, chunk);
        buffer = Buffer.concat([buffer, chunk]);
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

      this.writeDiagnostic({
        phase: 'response-end',
        requestId,
        transport: 'fetch',
        url,
        role: this.options.role,
        pid: process.pid,
      });
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

      const chunk = Buffer.from(value);
      this.writeResponseChunkDiagnostic(requestId, 'fetch', url, contentType, chunk);
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

    this.writeDiagnostic({
      phase: 'response-end',
      requestId,
      transport: 'fetch',
      url,
      role: this.options.role,
      pid: process.pid,
    });
    this.completeRequest(requestId);
  }

  private observeHttpResponse(
    res: httpTypes.IncomingMessage,
    requestId: string,
    transport: string
  ): void {
    const wrapped = res as typeof res & { [WRAPPED_RESPONSE]?: boolean };
    if (wrapped[WRAPPED_RESPONSE]) {
      return;
    }

    wrapped[WRAPPED_RESPONSE] = true;
    const state = this.activeRequests.get(requestId);
    const url = state?.url ?? '';
    const contentType = this.firstHeaderValue(res.headers['content-type']);
    const contentEncoding = this.firstHeaderValue(res.headers['content-encoding']);
    const isStreaming = Boolean(state?.isStreaming)
      || /text\/event-stream/i.test(contentType)
      || /stream/i.test(contentType)
      || /ndjson/i.test(contentType)
      || this.isConnectJsonContentType(contentType);

    this.writeDiagnostic({
      phase: 'response-headers',
      requestId,
      transport,
      url,
      statusCode: res.statusCode,
      headers: this.normalizeHeaders(res.headers),
      role: this.options.role,
      pid: process.pid,
    });

    const observer = this.createResponseObserver(
      requestId,
      transport,
      url,
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
      } catch (error) {
        this.logProbeError('http-response-emit', error);
      }

      return originalEmit.call(res, eventName, ...eventArgs);
    }) as typeof res.emit;
  }

  private registerRequest(
    provider: string,
    transport: string,
    url: string,
    headers: Record<string, string>,
    body: string | Buffer
  ): InterceptedRequestState | undefined {
    const payload = this.parseRequestPayload(body, url, headers);
    this.maybeUpdateCursorModelHintFromRequest(provider, url, body);
    this.writeDiagnostic({
      phase: 'request',
      transport,
      provider,
      url,
      headers,
      body: this.serializeBodyForLog(body, headers['content-type'] ?? ''),
      bodyPreview: this.previewBody(body, headers['content-type'] ?? ''),
      hasPrompt: Boolean(payload.prompt?.trim()),
      model: payload.model,
      chatId: payload.chatId,
      role: this.options.role,
      pid: process.pid,
    });

    const requestId = this.createRequestId();
    const hasPrompt = Boolean(payload.prompt?.trim());
    const state: InterceptedRequestState = {
      requestId,
      provider,
      url,
      prompt: payload.prompt?.trim() ?? '',
      model: payload.model,
      modelConfidence: payload.modelConfidence,
      chatId: payload.chatId,
      startedAt: Date.now(),
      isStreaming: payload.isStreaming,
      thinking: '',
      output: '',
      fallbackOutput: '',
      promptConfidence: hasPrompt ? 'exact' : 'none',
      didComplete: false,
      didStartEvent: hasPrompt,
    };

    this.activeRequests.set(requestId, state);
    if (hasPrompt) {
      this.writeEvent({
        phase: 'turn-start',
        role: this.options.role,
        pid: process.pid,
        requestId: state.requestId,
        provider: state.provider,
        url: state.url,
        prompt: state.prompt,
        model: state.model,
        modelConfidence: state.modelConfidence,
        chatId: state.chatId,
        startedAt: state.startedAt,
        isStreaming: state.isStreaming,
      });
    } else {
      this.writeDiagnostic({
        phase: 'request-no-prompt',
        requestId,
        transport,
        provider,
        url,
        role: this.options.role,
        pid: process.pid,
      });
    }

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

    if (state.didStartEvent) {
      const event: InterceptedTurnChunk = {
        requestId,
        provider: state.provider,
        kind: piece.kind,
        content: piece.content,
      };
      this.writeEvent({
        phase: 'turn-chunk',
        role: this.options.role,
        pid: process.pid,
        ...event,
      });
    }
  }

  private completeRequest(requestId: string): void {
    const state = this.activeRequests.get(requestId);
    if (!state || state.didComplete) {
      return;
    }

    state.didComplete = true;
    if (!state.output && state.fallbackOutput) {
      state.output = state.fallbackOutput;
    }
    this.emitTurnStartIfReady(requestId);
    if (state.didStartEvent) {
      const event: InterceptedTurnComplete = {
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
      };

      this.writeEvent({
        phase: 'turn-complete',
        role: this.options.role,
        pid: process.pid,
        ...event,
      });
    }
    this.activeRequests.delete(requestId);
  }

  private createResponseObserver(
    requestId: string,
    transport: string,
    url: string,
    contentType: string,
    encoding: string,
    isStreaming = true
  ): DecodedChunkObserver {
    return isStreaming
      ? this.createStreamingObserver(requestId, transport, url, encoding, contentType)
      : this.createBufferedObserver(requestId, transport, url, encoding, contentType);
  }

  private createStreamingObserver(
    requestId: string,
    transport: string,
    url: string,
    encoding: string,
    contentType: string
  ): DecodedChunkObserver {
    if (this.isConnectJsonContentType(contentType)) {
      let buffer: Buffer = Buffer.alloc(0);

      return this.createBufferObserver(
        encoding,
        (chunk) => {
          this.writeResponseChunkDiagnostic(requestId, transport, url, contentType, chunk);
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

          this.writeDiagnostic({
            phase: 'response-end',
            requestId,
            transport,
            url,
            role: this.options.role,
            pid: process.pid,
          });
          this.completeRequest(requestId);
        }
      );
    }

    let buffer = '';

    return this.createDecodedObserver(
      encoding,
      (text) => {
        this.writeResponseChunkDiagnostic(requestId, transport, url, contentType, text);
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

        this.writeDiagnostic({
          phase: 'response-end',
          requestId,
          transport,
          url,
          role: this.options.role,
          pid: process.pid,
        });
        this.completeRequest(requestId);
      }
    );
  }

  private createBufferedObserver(
    requestId: string,
    transport: string,
    url: string,
    encoding: string,
    contentType: string
  ): DecodedChunkObserver {
    if (this.isConnectJsonContentType(contentType)) {
      const chunks: Buffer[] = [];

      return this.createBufferObserver(
        encoding,
        (chunk) => {
          this.writeResponseChunkDiagnostic(requestId, transport, url, contentType, chunk);
          chunks.push(chunk);
        },
        () => {
          const body = Buffer.concat(chunks);
          const pieces = this.extractResponsePiecesFromBody(body, contentType);
          for (const piece of pieces) {
            this.appendResponsePiece(requestId, piece);
          }

          this.writeDiagnostic({
            phase: 'response-end',
            requestId,
            transport,
            url,
            role: this.options.role,
            pid: process.pid,
          });
          this.completeRequest(requestId);
        }
      );
    }

    let body = '';

    return this.createDecodedObserver(
      encoding,
      (text) => {
        this.writeResponseChunkDiagnostic(requestId, transport, url, contentType, text);
        body += text;
      },
      () => {
        const pieces = this.extractResponsePieces(body);
        for (const piece of pieces) {
          this.appendResponsePiece(requestId, piece);
        }

        this.writeDiagnostic({
          phase: 'response-end',
          requestId,
          transport,
          url,
          role: this.options.role,
          pid: process.pid,
        });
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

      return this.parseJsonCandidatesFromText(body.toString('utf8'));
    }

    return this.parseJsonCandidatesFromText(body);
  }

  private maybeUpdateCursorModelHintFromRequest(
    provider: string,
    url: string,
    body: string | Buffer
  ): void {
    if (provider !== 'Cursor') {
      return;
    }

    const hint = this.extractCursorModelHintFromRequestBody(url, body);
    if (!hint) {
      return;
    }

    this.cursorModelHint = {
      model: hint.model,
      confidence: hint.confidence,
      observedAt: Date.now(),
    };

    const now = Date.now();
    for (const state of this.activeRequests.values()) {
      if (state.provider !== 'Cursor' || state.didComplete || state.model) {
        continue;
      }

      if (!this.isCursorTurnUrl(state.url)) {
        continue;
      }

      if (now - state.startedAt > 30 * 1000) {
        continue;
      }

      state.model = hint.model;
      state.modelConfidence = hint.confidence;
      this.emitTurnStartIfReady(state.requestId);
    }

    this.writeDiagnostic({
      phase: 'cursor-model-hint-request',
      url,
      model: hint.model,
      confidence: hint.confidence,
      role: this.options.role,
      pid: process.pid,
    });
  }

  private extractCursorModelHintFromRequestBody(
    url: string,
    body: string | Buffer
  ): { model: string; confidence: ModelConfidence } | undefined {
    if (!/AnalyticsService\/Batch/i.test(url)) {
      return undefined;
    }

    const strings = this.extractPrintableBodyStrings(body);
    if (strings.length === 0) {
      return undefined;
    }

    let composerSubmitIndex = -1;
    for (let index = strings.length - 1; index >= 0; index -= 1) {
      if (strings[index] === 'composer.submit') {
        composerSubmitIndex = index;
        break;
      }
    }

    if (composerSubmitIndex === -1) {
      return undefined;
    }

    for (let index = composerSubmitIndex + 1; index < strings.length - 1; index += 1) {
      if (strings[index] !== 'model') {
        continue;
      }

      const rawModel = strings[index + 1]?.trim();
      if (!rawModel || rawModel.length > 120) {
        continue;
      }

      return {
        model: rawModel === 'default' ? 'Auto' : rawModel,
        confidence: rawModel === 'default' ? 'inferred' : 'exact',
      };
    }

    return undefined;
  }

  private extractPrintableBodyStrings(body: string | Buffer): string[] {
    const text = Buffer.isBuffer(body)
      ? body.toString('utf8')
      : body;
    return text.match(/[\x20-\x7E]{4,}/g) ?? [];
  }

  private isCursorTurnUrl(url: string): boolean {
    return /agentservice\/run|chatservice|streamconversation|backgroundcomposer/i.test(url);
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

    const envelope = this.getCaseEnvelope(parsed);
    if (envelope?.value && envelope.value !== parsed) {
      const fromEnvelope = this.extractPrompt(envelope.value);
      if (fromEnvelope) {
        return fromEnvelope;
      }
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

    const fromUserMessage = this.readTextLike(
      parsed.userMessage
      ?? parsed.currentMessage
      ?? parsed.message
      ?? parsed.lastUserMessage
    );
    if (fromUserMessage) {
      return fromUserMessage;
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

      const role = typeof (candidate as any).role === 'string'
        ? (candidate as any).role.toLowerCase()
        : undefined;
      const type = typeof (candidate as any).type === 'string'
        ? (candidate as any).type.toLowerCase()
        : undefined;
      if (
        role !== 'user'
        && role !== 'input_user'
        && type !== 'message_type_human'
        && type !== 'human'
      ) {
        continue;
      }

      const content = this.readTextLike(
        (candidate as any).content
        ?? (candidate as any).text
        ?? (candidate as any).message
      );
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

    const envelope = this.getCaseEnvelope(value);
    if (envelope?.value && envelope.value !== value) {
      switch (envelope.caseName.toLowerCase()) {
        case 'thinkingdelta':
        case 'reasoningdelta':
          return this.compactPieces([
            { kind: 'agent-thinking', content: this.readTextLike(envelope.value) },
          ]);
        case 'textdelta':
        case 'contentdelta':
        case 'outputdelta':
        case 'messagedelta':
          return this.compactPieces([
            { kind: 'agent-output', content: this.readTextLike(envelope.value) },
          ]);
        case 'thinkingcompleted':
        case 'turnended':
        case 'done':
          return [];
        default: {
          const nested = this.extractResponsePiecesFromJson(envelope.value);
          if (nested.length > 0) {
            return nested;
          }
        }
      }
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

  private compactPieces(
    pieces: Array<{ kind: 'agent-thinking' | 'agent-output'; content?: string }>
  ): ResponsePiece[] {
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
      const envelope = this.getCaseEnvelope(value);
      if (envelope?.value && envelope.value !== value) {
        const envelopeText = this.readTextLike(envelope.value);
        if (envelopeText) {
          return envelopeText;
        }
      }
      if (typeof (value as any).text === 'string') {
        return (value as any).text;
      }
      if (typeof (value as any).content === 'string') {
        return (value as any).content;
      }
      if (typeof (value as any).output_text === 'string') {
        return (value as any).output_text;
      }
      if (typeof (value as any).value === 'string') {
        return (value as any).value;
      }
    }

    return '';
  }

  private getCaseEnvelope(
    value: unknown
  ): { caseName: string; value: unknown } | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const directCase = (value as any).case;
    if (typeof directCase === 'string') {
      return {
        caseName: directCase,
        value: (value as any).value,
      };
    }

    const message = (value as any).message;
    if (message && typeof message === 'object' && typeof message.case === 'string') {
      return {
        caseName: message.case,
        value: message.value,
      };
    }

    return undefined;
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

  private isConnectTransport(value: unknown): value is {
    unary: (...args: unknown[]) => unknown;
    stream: (...args: unknown[]) => unknown;
  } {
    return Boolean(
      value
      && typeof value === 'object'
      && typeof (value as any).unary === 'function'
      && typeof (value as any).stream === 'function'
    );
  }

  private isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return Boolean(
      value
      && typeof value === 'object'
      && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
    );
  }

  private normalizeConnectHeaders(headers: unknown): Record<string, string> {
    if (!headers) {
      return {};
    }

    const normalized: Record<string, string> = {};

    if (typeof (headers as any).forEach === 'function') {
      try {
        (headers as any).forEach((value: unknown, key: unknown) => {
          const headerKey = typeof key === 'string' ? key.toLowerCase() : String(key).toLowerCase();
          normalized[headerKey] = Array.isArray(value)
            ? value.map((entry) => String(entry)).join(', ')
            : String(value);
        });
        return normalized;
      } catch {
        // Fall through to object iteration.
      }
    }

    if (typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        normalized[key.toLowerCase()] = Array.isArray(value)
          ? value.map((entry) => String(entry)).join(', ')
          : String(value);
      }
    }

    return normalized;
  }

  private resolveConnectTransportHost(
    transport: { getTransportHost?: (...callArgs: unknown[]) => unknown },
    serviceName: string,
    methodName: string
  ): string | undefined {
    if (typeof transport.getTransportHost !== 'function') {
      return undefined;
    }

    try {
      const value = transport.getTransportHost(serviceName, methodName);
      return typeof value === 'string' && value.trim()
        ? value.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  private coerceToPlainObject(value: unknown): unknown {
    if (!value || typeof value !== 'object') {
      return value;
    }

    try {
      if (typeof (value as any).toJson === 'function') {
        return (value as any).toJson();
      }
    } catch {
      // Ignore message serialization failures.
    }

    try {
      if (typeof (value as any).toJSON === 'function') {
        return (value as any).toJSON();
      }
    } catch {
      // Ignore JSON serialization failures.
    }

    return value;
  }

  private listPropertyNames(value: unknown): string[] {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return [];
    }

    const names = new Set<string>();
    try {
      for (const key of Object.getOwnPropertyNames(value)) {
        names.add(key);
      }
    } catch {
      // Ignore access errors.
    }

    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype && prototype !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(prototype)) {
          names.add(key);
        }
      }
    } catch {
      // Ignore prototype inspection failures.
    }

    return [...names].sort();
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
    return headers['x-ai-token-analytics-origin'] === 'extension';
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
      if (
        hostname === '127.0.0.1'
        || hostname === 'localhost'
        || hostname === '::1'
        || hostname === '::ffff:127.0.0.1'
      ) {
        return {
          pattern: /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i,
          provider: 'Cursor',
        };
      }
    } catch {
      // Ignore malformed URLs.
    }

    if (/api2\.cursor\.sh/i.test(url)) {
      return { pattern: /api2\.cursor\.sh/i, provider: 'Cursor' };
    }

    return undefined;
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
      // Ignore malformed authority values.
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
          const registered = this.registerRequest(
            endpoint.provider,
            'incoming-http-server',
            details.url,
            details.headers,
            Buffer.concat(requestChunks)
          );
          requestId = registered?.requestId;
          flushPendingResponse();
        } else if ((eventName === 'error' || eventName === 'aborted') && requestId) {
          this.completeRequest(requestId);
        }
      } catch (error) {
        this.logProbeError('incoming-http-server-request-emit', error);
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
      } catch (error) {
        this.logProbeError('incoming-http-server-response-write', error);
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
      } catch (error) {
        this.logProbeError('incoming-http-server-response-end', error);
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
          const registered = this.registerRequest(
            endpoint.provider,
            'incoming-http2-server',
            details.url,
            details.headers,
            Buffer.concat(requestChunks)
          );
          requestId = registered?.requestId;
          flushPendingResponse();
        } else if ((eventName === 'error' || eventName === 'aborted') && requestId) {
          this.completeRequest(requestId);
        }
      } catch (error) {
        this.logProbeError('incoming-http2-server-stream-emit', error);
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
      } catch (error) {
        this.logProbeError('incoming-http2-server-respond', error);
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
      } catch (error) {
        this.logProbeError('incoming-http2-server-additional-headers', error);
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
      } catch (error) {
        this.logProbeError('incoming-http2-server-write', error);
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
      } catch (error) {
        this.logProbeError('incoming-http2-server-end', error);
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

      this.writeDiagnostic({
        phase: 'loopback-socket',
        direction,
        localAddress,
        localPort: socket.localPort,
        remoteAddress,
        remotePort: socket.remotePort,
        listenerPort,
        preview,
        role: this.options.role,
        pid: process.pid,
      });
    };

    const originalEmit = socket.emit;
    socket.emit = ((eventName: string | symbol, ...eventArgs: any[]): boolean => {
      try {
        if (eventName === 'data' && eventArgs[0] !== undefined) {
          logSocketChunk('in', eventArgs[0]);
        }
      } catch (error) {
        this.logProbeError('loopback-socket-emit', error);
      }

      return (originalEmit as any).apply(socket, [eventName, ...eventArgs]);
    }) as typeof socket.emit;

    const originalWrite = socket.write;
    socket.write = ((chunk: any, ...rest: any[]): boolean => {
      try {
        logSocketChunk('out', chunk);
      } catch (error) {
        this.logProbeError('loopback-socket-write', error);
      }

      return (originalWrite as any).apply(socket, [chunk, ...rest]);
    }) as typeof socket.write;
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
      'incoming-http-server',
      state?.url ?? '',
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
      'incoming-http2-server',
      state?.url ?? '',
      contentType,
      contentEncoding,
      isStreaming
    );
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

  private createRequestId(): string {
    this.requestCounter += 1;
    return `cursor-remote:${process.pid}:${Date.now()}:${this.requestCounter}`;
  }

  private serializeBodyForLog(body: string | Buffer, contentType: string): string {
    if (typeof body === 'string') {
      return body;
    }

    if (this.isConnectJsonContentType(contentType)) {
      const payloads = this.extractConnectJsonPayloadTexts(body);
      if (payloads.length > 0) {
        return payloads.join('\n');
      }
    }

    if (this.looksPrintable(body)) {
      return body.toString('utf8');
    }

    return `base64:${body.toString('base64')}`;
  }

  private previewBody(body: string | Buffer, contentType: string): string | undefined {
    const text = this.serializeBodyForLog(body, contentType).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 200) : undefined;
  }

  private serializeUnknown(value: unknown): string | undefined {
    const plainValue = this.coerceToPlainObject(value);
    if (plainValue === undefined) {
      return undefined;
    }

    if (typeof plainValue === 'string') {
      return plainValue;
    }

    try {
      return JSON.stringify(plainValue);
    } catch {
      return String(plainValue);
    }
  }

  private previewUnknown(value: unknown): string | undefined {
    const serialized = this.serializeUnknown(value)?.replace(/\s+/g, ' ').trim();
    return serialized ? serialized.slice(0, 240) : undefined;
  }

  private writeResponseChunkDiagnostic(
    requestId: string,
    transport: string,
    url: string,
    contentType: string,
    chunk: string | Buffer
  ): void {
    this.writeDiagnostic({
      phase: 'response-chunk',
      requestId,
      transport,
      url,
      contentType,
      chunk: typeof chunk === 'string'
        ? chunk
        : this.serializeBodyForLog(chunk, contentType),
      role: this.options.role,
      pid: process.pid,
    });
  }

  private looksPrintable(buffer: Buffer): boolean {
    if (buffer.length === 0) {
      return true;
    }

    const text = buffer.toString('utf8');
    const nonPrintable = text.replace(/[\x20-\x7e\n\r\t]/g, '');
    return nonPrintable.length <= Math.max(2, text.length * 0.1);
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

  private isLoopbackAddress(value: string | undefined): boolean {
    return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
  }

  private writeDiagnostic(payload: Record<string, unknown>): void {
    if (!this.options.diagnosticLogPath) {
      return;
    }

    appendJsonLine(this.options.diagnosticLogPath, payload);
  }

  private writeEvent(payload: Record<string, unknown>): void {
    appendJsonLine(this.options.eventLogPath, payload);
  }

  private logProbeError(phase: string, error: unknown): void {
    this.writeDiagnostic({
      phase: 'probe-error',
      where: phase,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      role: this.options.role,
      pid: process.pid,
    });
  }
}

function appendJsonLine(filePath: string, payload: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...payload,
      })}\n`,
      'utf8'
    );
  } catch {
    // Ignore cross-process logging failures.
  }
}

export function installCursorRemoteProbe(options: CursorRemoteProbeOptions): Record<string, unknown> {
  const globalState = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: { probe: CursorRemoteProbe; options: CursorRemoteProbeOptions };
  };

  const existing = globalState[GLOBAL_STATE_KEY];
  if (existing) {
    appendJsonLine(options.diagnosticLogPath ?? options.eventLogPath, {
      phase: 'install-skip',
      reason: 'already-installed',
      role: options.role,
      pid: process.pid,
    });
    return {
      ok: true,
      alreadyInstalled: true,
      pid: process.pid,
      role: options.role,
    };
  }

  const probe = new CursorRemoteProbe(options);
  probe.start();
  globalState[GLOBAL_STATE_KEY] = { probe, options };

  return {
    ok: true,
    alreadyInstalled: false,
    pid: process.pid,
    role: options.role,
  };
}
