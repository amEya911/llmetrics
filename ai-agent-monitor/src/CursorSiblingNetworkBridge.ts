import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { promises as fs } from 'fs';
import { StringDecoder } from 'string_decoder';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ModelConfidence } from './types';

const execFileAsync = promisify(execFile);
const TARGET_ROLES = ['retrieval', 'always-local', 'agent-exec'] as const;

type CursorSiblingRole = typeof TARGET_ROLES[number];

export interface CursorTurnStart {
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

export interface CursorTurnChunk {
  requestId: string;
  provider: string;
  kind: 'agent-thinking' | 'agent-output';
  content: string;
}

export interface CursorTurnComplete {
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

interface CursorSiblingNetworkBridgeOptions {
  diagnosticLogPath?: string;
  eventLogPath: string;
  probeModulePath: string;
  log?: (message: string) => void;
}

interface SiblingProcessInfo {
  pid: number;
  ppid: number;
  role: CursorSiblingRole;
  command: string;
}

interface InspectorEndpoint {
  pid: number;
  role: CursorSiblingRole;
  port: number;
  webSocketDebuggerUrl: string;
}

interface EventLogEnvelope {
  phase?: string;
  provider?: string;
  requestId?: string;
  url?: string;
  prompt?: string;
  model?: string;
  modelConfidence?: ModelConfidence;
  chatId?: string;
  startedAt?: number;
  isStreaming?: boolean;
  completedAt?: number;
  thinking?: string;
  output?: string;
  kind?: 'agent-thinking' | 'agent-output';
  content?: string;
}

export class CursorSiblingNetworkBridge implements vscode.Disposable {
  private readonly options: CursorSiblingNetworkBridgeOptions;
  private readonly _onTurnStart = new vscode.EventEmitter<CursorTurnStart>();
  readonly onTurnStart = this._onTurnStart.event;

  private readonly _onTurnChunk = new vscode.EventEmitter<CursorTurnChunk>();
  readonly onTurnChunk = this._onTurnChunk.event;

  private readonly _onTurnComplete = new vscode.EventEmitter<CursorTurnComplete>();
  readonly onTurnComplete = this._onTurnComplete.event;

  private readonly attachedPids = new Map<number, InspectorEndpoint>();
  private readonly decoder = new StringDecoder('utf8');
  private eventOffset = 0;
  private eventRemainder = '';
  private polling = false;
  private scanning = false;
  private started = false;
  private scanHandle?: NodeJS.Timeout;
  private pollHandle?: NodeJS.Timeout;

  constructor(options: CursorSiblingNetworkBridgeOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    await fs.writeFile(this.options.eventLogPath, '', 'utf8').catch(() => undefined);
    this.eventOffset = 0;
    this.eventRemainder = '';
    this.attachedPids.clear();
    this.debug(
      `[cursor-network] Cursor sibling-host bridge starting. Probe bundle: ${this.options.probeModulePath}`
    );

    this.pollHandle = setInterval(() => {
      void this.pollEventLog();
    }, 200);

    this.scanHandle = setInterval(() => {
      void this.scanAndAttach();
    }, 4000);

    void this.scanAndAttach();
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    if (this.scanHandle) {
      clearInterval(this.scanHandle);
      this.scanHandle = undefined;
    }
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    this.attachedPids.clear();
  }

  dispose(): void {
    this.stop();
    this._onTurnStart.dispose();
    this._onTurnChunk.dispose();
    this._onTurnComplete.dispose();
  }

  private async scanAndAttach(): Promise<void> {
    if (!this.started || this.scanning) {
      return;
    }

    this.scanning = true;
    try {
      const siblings = await this.discoverSiblingProcesses();
      const livePids = new Set(siblings.map((candidate) => candidate.pid));

      for (const attachedPid of [...this.attachedPids.keys()]) {
        if (!livePids.has(attachedPid)) {
          this.attachedPids.delete(attachedPid);
        }
      }

      for (const sibling of siblings) {
        const alreadyAttached = this.attachedPids.get(sibling.pid);
        if (alreadyAttached) {
          continue;
        }

        const endpoint = await this.attachProbe(sibling);
        if (endpoint) {
          this.attachedPids.set(sibling.pid, endpoint);
        }
      }
    } catch (error) {
      this.debug(
        `[cursor-network] Failed to scan Cursor sibling hosts: ${formatError(error)}`
      );
    } finally {
      this.scanning = false;
    }
  }

  private async attachProbe(sibling: SiblingProcessInfo): Promise<InspectorEndpoint | undefined> {
    try {
      process.kill(sibling.pid, 'SIGUSR1');
    } catch (error) {
      this.debug(
        `[cursor-network] Failed to enable inspector for ${sibling.role} pid ${sibling.pid}: ${formatError(error)}`
      );
      return undefined;
    }

    await sleep(350);

    const endpoint = await this.resolveInspectorEndpoint(sibling);
    if (!endpoint) {
      this.debug(
        `[cursor-network] No inspector endpoint found for ${sibling.role} pid ${sibling.pid}.`
      );
      return undefined;
    }

    const result = await evaluateInspectorExpression(
      endpoint.webSocketDebuggerUrl,
      this.buildInstallExpression(sibling.role)
    );

    const remoteResult = result?.result?.result;
    if (result?.result?.exceptionDetails) {
      this.debug(
        `[cursor-network] Inspector injection raised an exception for ${sibling.role} pid ${sibling.pid}.`
      );
      return undefined;
    }

    this.debug(
      `[cursor-network] Injected remote probe into ${sibling.role} pid ${sibling.pid} on port ${endpoint.port}.`
    );

    if (remoteResult?.value) {
      this.debug(
        `[cursor-network] Remote probe result for ${sibling.role}: ${safeStringify(remoteResult.value)}`
      );
    }

    if (sibling.role === 'always-local') {
      try {
        const hookResult = await this.installAlwaysLocalInternalTransportHook(endpoint.webSocketDebuggerUrl);
        this.debug(
          `[cursor-network] Installed always-local Cursor transport hook: ${safeStringify(hookResult)}`
        );
      } catch (error) {
        this.debug(
          `[cursor-network] Failed to install always-local Cursor transport hook: ${formatError(error)}`
        );
      }
    }

    return endpoint;
  }

  private buildInstallExpression(role: CursorSiblingRole): string {
    const probePath = this.options.probeModulePath;
    const installOptions = {
      diagnosticLogPath: this.options.diagnosticLogPath,
      eventLogPath: this.options.eventLogPath,
      role,
    };

    return `(() => {
  const modulePath = ${JSON.stringify(probePath)};
  const installOptions = ${JSON.stringify(installOptions)};
  const localRequire =
    typeof require === 'function'
      ? require
      : process.mainModule && typeof process.mainModule.require === 'function'
        ? process.mainModule.require.bind(process.mainModule)
        : null;
  if (!localRequire) {
    throw new Error('No require() available inside Cursor sibling host');
  }
  const probe = localRequire(modulePath);
  if (!probe || typeof probe.installCursorRemoteProbe !== 'function') {
    throw new Error('cursorRemoteProbe bundle missing installCursorRemoteProbe export');
  }
  return probe.installCursorRemoteProbe(installOptions);
})()`;
  }

  private async resolveInspectorEndpoint(
    sibling: SiblingProcessInfo
  ): Promise<InspectorEndpoint | undefined> {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      '-a',
      '-p',
      String(sibling.pid),
      '-iTCP',
      '-sTCP:LISTEN',
    ]);

    const ports = String(stdout || '')
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
        if (!match) {
          return [];
        }

        const port = Number.parseInt(match[1], 10);
        return Number.isFinite(port) ? [port] : [];
      });

    for (const port of ports) {
      try {
        const targets = await httpGetJson<any[]>(`http://127.0.0.1:${port}/json/list`);
        const firstTarget = Array.isArray(targets) ? targets[0] : undefined;
        const webSocketDebuggerUrl = typeof firstTarget?.webSocketDebuggerUrl === 'string'
          ? firstTarget.webSocketDebuggerUrl
          : undefined;
        if (!webSocketDebuggerUrl) {
          continue;
        }

        return {
          pid: sibling.pid,
          role: sibling.role,
          port,
          webSocketDebuggerUrl,
        };
      } catch {
        // Not an inspector port.
      }
    }

    return undefined;
  }

  private async installAlwaysLocalInternalTransportHook(
    webSocketDebuggerUrl: string
  ): Promise<any> {
    const GLOBAL_STATE_KEY = '__aiTokenAnalyticsCursorRemoteProbe';
    const patchPrototypeFunction = String(function (globalStateKey: string) {
      const probe = (globalThis as any)[globalStateKey]?.probe;
      if (!probe) {
        return { ok: false, reason: 'probe-missing' };
      }
      if ((this as any).__aiTokenAnalyticsWrappedCreateMultiProxyTransport) {
        return { ok: true, alreadyWrapped: true };
      }

      const original = (this as any).createMultiProxyTransport;
      if (typeof original !== 'function') {
        return { ok: false, reason: 'createMultiProxyTransport-missing' };
      }

      (this as any).createMultiProxyTransport = function (...args: unknown[]) {
        const transport = original.apply(this, args);
        try {
          return probe.wrapCursorConnectTransport(transport, 'always-local.createMultiProxyTransport');
        } catch {
          return transport;
        }
      };
      (this as any).__aiTokenAnalyticsWrappedCreateMultiProxyTransport = true;
      return { ok: true, alreadyWrapped: false };
    });

    const patchInstanceFunction = String(function (globalStateKey: string) {
      const probe = (globalThis as any)[globalStateKey]?.probe;
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
      if (wrapCarrier((this as any)._backendTransport, 'always-local._backendTransport')) {
        patched.push('_backendTransport');
      }
      if (wrapCarrier((this as any)._bidiTransport, 'always-local._bidiTransport')) {
        patched.push('_bidiTransport');
      }

      patchMap((this as any).transportConfig, 'always-local.transportConfig', patched);
      patchMap((this as any)._overrideMethodNameToTransportMap, 'always-local.overrideMethod', patched);
      patchMap(
        (this as any)._overrideServiceNameToTransportMapLowerPriorityThanMethodOverrides,
        'always-local.overrideService',
        patched
      );

      return { ok: true, patched };
    });

    return await withInspectorClient(webSocketDebuggerUrl, async (client) => {
      const activateEval = await client.sendCommand('Runtime.evaluate', {
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

      const activateProperties = await client.sendCommand('Runtime.getProperties', {
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

      const scopesProperties = await client.sendCommand('Runtime.getProperties', {
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

      const bundleScopeProperties = await client.sendCommand('Runtime.getProperties', {
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

      const transportModule = await client.sendCommand('Runtime.callFunctionOn', {
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

      const transportModuleProperties = await client.sendCommand('Runtime.getProperties', {
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

      const handlerClassProperties = await client.sendCommand('Runtime.getProperties', {
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

      const prototypePatch = await client.sendCommand('Runtime.callFunctionOn', {
        objectId: prototypeObjectId,
        functionDeclaration: patchPrototypeFunction,
        arguments: [{ value: GLOBAL_STATE_KEY }],
        returnByValue: true,
        awaitPromise: true,
      });

      const instances = await client.sendCommand('Runtime.queryObjects', {
        prototypeObjectId,
        objectGroup: 'ai-token-analytics',
      });
      const instancesObjectId = instances?.result?.objects?.objectId;
      if (!instancesObjectId) {
        throw new Error('Cursor always-local AiConnectTransportHandler instances were not reachable.');
      }

      const instanceArrayProperties = await client.sendCommand('Runtime.getProperties', {
        objectId: instancesObjectId,
        ownProperties: true,
        generatePreview: false,
      });
      const instanceEntries = (instanceArrayProperties?.result?.result ?? [])
        .filter((property: any) => /^\d+$/.test(property?.name ?? ''))
        .filter((property: any) => property?.value?.objectId);

      const instancePatches: unknown[] = [];
      for (const entry of instanceEntries) {
        const patchResult = await client.sendCommand('Runtime.callFunctionOn', {
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
  }

  private async discoverSiblingProcesses(): Promise<SiblingProcessInfo[]> {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid,ppid,command']);
    const lines = String(stdout || '').split(/\r?\n/);
    const siblings: SiblingProcessInfo[] = [];

    for (const line of lines) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        continue;
      }

      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      const command = match[3];
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
        continue;
      }
      if (pid === process.pid || ppid !== process.ppid) {
        continue;
      }

      const roleMatch = command.match(/extension-host \(([^)]+)\)/);
      const role = roleMatch?.[1];
      if (!role || !TARGET_ROLES.includes(role as CursorSiblingRole)) {
        continue;
      }

      siblings.push({
        pid,
        ppid,
        role: role as CursorSiblingRole,
        command,
      });
    }

    return siblings.sort((left, right) => left.pid - right.pid);
  }

  private async pollEventLog(): Promise<void> {
    if (!this.started || this.polling) {
      return;
    }

    this.polling = true;
    try {
      const stats = await fs.stat(this.options.eventLogPath).catch(() => undefined);
      if (!stats) {
        return;
      }

      if (stats.size < this.eventOffset) {
        this.eventOffset = 0;
        this.eventRemainder = '';
      }

      if (stats.size === this.eventOffset) {
        return;
      }

      const file = await fs.open(this.options.eventLogPath, 'r');
      try {
        const length = stats.size - this.eventOffset;
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, this.eventOffset);
        this.eventOffset = stats.size;

        const text = this.decoder.write(buffer);
        const combined = this.eventRemainder + text;
        const lines = combined.split('\n');
        this.eventRemainder = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          this.handleEventLine(trimmed);
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      this.debug(
        `[cursor-network] Failed to read remote event log ${this.options.eventLogPath}: ${formatError(error)}`
      );
    } finally {
      this.polling = false;
    }
  }

  private handleEventLine(line: string): void {
    let payload: EventLogEnvelope;
    try {
      payload = JSON.parse(line) as EventLogEnvelope;
    } catch {
      this.debug(`[cursor-network] Ignoring malformed remote event line: ${line.slice(0, 200)}`);
      return;
    }

    if (payload.provider && payload.provider !== 'Cursor') {
      return;
    }

    if (payload.phase === 'turn-start') {
      if (!payload.requestId || !payload.url || !payload.prompt || payload.startedAt === undefined) {
        return;
      }

      this._onTurnStart.fire({
        requestId: payload.requestId,
        provider: payload.provider ?? 'Cursor',
        url: payload.url,
        prompt: payload.prompt,
        model: payload.model,
        modelConfidence: payload.modelConfidence ?? 'unknown',
        chatId: payload.chatId,
        startedAt: payload.startedAt,
        isStreaming: Boolean(payload.isStreaming ?? true),
      });
      return;
    }

    if (payload.phase === 'turn-chunk') {
      if (!payload.requestId || !payload.kind || typeof payload.content !== 'string') {
        return;
      }

      this._onTurnChunk.fire({
        requestId: payload.requestId,
        provider: payload.provider ?? 'Cursor',
        kind: payload.kind,
        content: payload.content,
      });
      return;
    }

    if (payload.phase === 'turn-complete') {
      if (!payload.requestId || !payload.url || !payload.prompt || payload.startedAt === undefined || payload.completedAt === undefined) {
        return;
      }

      this._onTurnComplete.fire({
        requestId: payload.requestId,
        provider: payload.provider ?? 'Cursor',
        url: payload.url,
        prompt: payload.prompt,
        model: payload.model,
        modelConfidence: payload.modelConfidence ?? 'unknown',
        chatId: payload.chatId,
        startedAt: payload.startedAt,
        completedAt: payload.completedAt,
        thinking: payload.thinking ?? '',
        output: payload.output ?? '',
      });
    }
  }

  private debug(message: string): void {
    this.options.log?.(message);
  }
}

class InspectorWebSocketClient {
  private socket?: net.Socket;
  private handshakeBuffer = Buffer.alloc(0);
  private frameBuffer = Buffer.alloc(0);
  private handshakeComplete = false;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  async connect(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:') {
      throw new Error(`Unsupported inspector websocket protocol: ${parsed.protocol}`);
    }

    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
    const host = parsed.hostname || '127.0.0.1';
    const pathWithQuery = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const key = crypto.randomBytes(16).toString('base64');

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      this.socket = socket;

      const onError = (error: Error) => {
        reject(error);
      };

      socket.once('error', onError);
      socket.once('connect', () => {
        const request = [
          `GET ${pathWithQuery} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n');
        socket.write(request, 'utf8');
      });

      socket.on('data', (chunk) => {
        try {
          if (!this.handshakeComplete) {
            this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
            const boundary = this.handshakeBuffer.indexOf('\r\n\r\n');
            if (boundary === -1) {
              return;
            }

            const headerText = this.handshakeBuffer.subarray(0, boundary).toString('utf8');
            if (!/^HTTP\/1\.1 101 /i.test(headerText)) {
              reject(new Error(`Inspector websocket handshake failed: ${headerText}`));
              socket.destroy();
              return;
            }

            this.handshakeComplete = true;
            socket.off('error', onError);
            resolve();

            const remainder = this.handshakeBuffer.subarray(boundary + 4);
            this.handshakeBuffer = Buffer.alloc(0);
            if (remainder.length > 0) {
              this.consumeFrames(remainder);
            }
            return;
          }

          this.consumeFrames(chunk);
        } catch (error) {
          reject(error as Error);
          socket.destroy();
        }
      });

      socket.on('close', () => {
        this.closed = true;
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('Inspector websocket closed'));
        }
        this.pending.clear();
      });
    });
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendText(payload);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    try {
      this.sendFrame(Buffer.alloc(0), 0x8);
    } catch {
      // Ignore close-frame failures.
    }
    this.socket?.end();
    this.socket?.destroy();
  }

  private sendText(payload: string): void {
    this.sendFrame(Buffer.from(payload, 'utf8'), 0x1);
  }

  private sendPong(payload: Buffer): void {
    this.sendFrame(payload, 0xA);
  }

  private sendFrame(payload: Buffer, opcode: number): void {
    if (!this.socket) {
      throw new Error('Inspector websocket is not connected');
    }

    const mask = crypto.randomBytes(4);
    const header: number[] = [0x80 | opcode];

    if (payload.length < 126) {
      header.push(0x80 | payload.length);
    } else if (payload.length <= 0xffff) {
      header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
    } else {
      const lengthBuffer = Buffer.alloc(8);
      lengthBuffer.writeBigUInt64BE(BigInt(payload.length));
      header.push(0x80 | 127, ...lengthBuffer);
    }

    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }

    this.socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
  }

  private consumeFrames(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);

    while (true) {
      if (this.frameBuffer.length < 2) {
        return;
      }

      const firstByte = this.frameBuffer[0];
      const secondByte = this.frameBuffer[1];
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.frameBuffer.length < offset + 2) {
          return;
        }
        payloadLength = this.frameBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.frameBuffer.length < offset + 8) {
          return;
        }
        payloadLength = Number(this.frameBuffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskBytesLength = masked ? 4 : 0;
      if (this.frameBuffer.length < offset + maskBytesLength + payloadLength) {
        return;
      }

      let payload = this.frameBuffer.subarray(offset + maskBytesLength, offset + maskBytesLength + payloadLength);
      if (masked) {
        const maskBytes = this.frameBuffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ maskBytes[index % 4];
        }
        payload = unmasked;
      }

      this.frameBuffer = this.frameBuffer.subarray(offset + maskBytesLength + payloadLength);

      if (opcode === 0x8) {
        this.close();
        return;
      }

      if (opcode === 0x9) {
        this.sendPong(payload);
        continue;
      }

      if (opcode !== 0x1) {
        continue;
      }

      let message: any;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        continue;
      }

      if (typeof message?.id === 'number') {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
    }
  }
}

async function evaluateInspectorExpression(
  webSocketDebuggerUrl: string,
  expression: string
): Promise<any> {
  return await withInspectorClient(webSocketDebuggerUrl, async (client) => {
    return await client.sendCommand('Runtime.evaluate', {
      expression,
      includeCommandLineAPI: true,
      awaitPromise: true,
      returnByValue: true,
    });
  });
}

async function withInspectorClient<T>(
  webSocketDebuggerUrl: string,
  callback: (client: InspectorWebSocketClient) => Promise<T>
): Promise<T> {
  const client = new InspectorWebSocketClient();
  try {
    await client.connect(webSocketDebuggerUrl);
    await client.sendCommand('Runtime.enable');
    return await callback(client);
  } finally {
    client.close();
  }
}

async function httpGetJson<T>(url: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }

        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(1200, () => {
      request.destroy(new Error(`Timeout fetching ${url}`));
    });
    request.on('error', reject);
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
