import * as vscode from 'vscode';

const WRAPPED_PROVIDER = Symbol('ai-agent-monitor.cursor-provider');
const WRAPPED_HANDLE = Symbol('ai-agent-monitor.cursor-handle');

interface CursorRunCallbacks {
  onRunStarted(input: string, source: string): string;
  onUserInput(turnId: string, input: string): void;
  onThinkingDelta(turnId: string, text: string): void;
  onThinkingComplete(turnId: string): void;
  onOutputDelta(turnId: string, text: string): void;
  onTurnEnded(turnId: string): void;
  onRunFinished(turnId: string): void;
}

export class CursorInterceptor implements vscode.Disposable {
  private readonly cursorApi: any;
  private readonly originalRegisterAgentProvider?: (...args: unknown[]) => unknown;
  private readonly callbacks: CursorRunCallbacks;
  private readonly output: vscode.OutputChannel;
  private patchedRegisterAgentProvider?: (...args: unknown[]) => unknown;

  constructor(
    callbacks: CursorRunCallbacks,
    output: vscode.OutputChannel
  ) {
    this.callbacks = callbacks;
    this.output = output;
    this.cursorApi = (vscode as any).cursor;

    if (this.cursorApi && typeof this.cursorApi.registerAgentProvider === 'function') {
      this.originalRegisterAgentProvider = this.cursorApi.registerAgentProvider.bind(this.cursorApi);
    }
  }

  install(): boolean {
    if (!this.cursorApi || !this.originalRegisterAgentProvider) {
      this.output.appendLine('[cursor] Cursor API not available; using generic fallback monitoring only.');
      return false;
    }

    if (this.patchedRegisterAgentProvider) {
      return true;
    }

    this.patchedRegisterAgentProvider = (provider: unknown) => {
      return this.originalRegisterAgentProvider!(this.wrapProvider(provider));
    };

    this.cursorApi.registerAgentProvider = this.patchedRegisterAgentProvider;
    this.output.appendLine('[cursor] Installed Cursor agent provider interceptor.');
    return true;
  }

  dispose(): void {
    if (!this.cursorApi || !this.originalRegisterAgentProvider || !this.patchedRegisterAgentProvider) {
      return;
    }

    if (this.cursorApi.registerAgentProvider === this.patchedRegisterAgentProvider) {
      this.cursorApi.registerAgentProvider = this.originalRegisterAgentProvider;
    }

    this.patchedRegisterAgentProvider = undefined;
  }

  private wrapProvider(provider: unknown): unknown {
    if (!provider || typeof provider !== 'object') {
      return provider;
    }

    const maybeProvider = provider as Record<PropertyKey, unknown>;
    if (maybeProvider[WRAPPED_PROVIDER]) {
      return provider;
    }

    const createAgent = maybeProvider.createAgent;
    if (typeof createAgent !== 'function') {
      return provider;
    }

    const wrapped = Object.create(provider) as Record<PropertyKey, unknown>;
    wrapped[WRAPPED_PROVIDER] = true;
    wrapped.createAgent = (...args: unknown[]) => {
      const handle = createAgent.apply(provider, args);
      return this.wrapHandle(handle);
    };

    return wrapped;
  }

  private wrapHandle(handle: unknown): unknown {
    if (!handle || typeof handle !== 'object') {
      return handle;
    }

    const maybeHandle = handle as Record<PropertyKey, unknown>;
    if (maybeHandle[WRAPPED_HANDLE]) {
      return handle;
    }

    const run = maybeHandle.run;
    if (typeof run !== 'function') {
      return handle;
    }

    const wrapped = Object.create(handle) as Record<PropertyKey, unknown>;
    wrapped[WRAPPED_HANDLE] = true;
    wrapped.run = (request: unknown) => this.wrapRun(handle as { run: (request: unknown) => AsyncIterable<unknown> }, request);
    return wrapped;
  }

  private async *wrapRun(
    handle: { run: (request: unknown) => AsyncIterable<unknown> },
    request: unknown
  ): AsyncGenerator<unknown, void, unknown> {
    const input = this.getRequestUserMessage(request);
    const turnId = this.callbacks.onRunStarted(input, 'Cursor');

    try {
      for await (const update of handle.run(request)) {
        this.handleInteractionUpdate(turnId, update);
        yield update;
      }
    } finally {
      this.callbacks.onRunFinished(turnId);
    }
  }

  private handleInteractionUpdate(turnId: string, update: unknown): void {
    const envelope = this.getInteractionEnvelope(update);
    if (!envelope) {
      return;
    }

    const { caseName, value } = envelope;

    switch (caseName) {
      case 'userMessageAppended': {
        const text = this.getUserMessageText(value);
        if (text) {
          this.callbacks.onUserInput(turnId, text);
        }
        return;
      }
      case 'thinkingDelta': {
        const text = this.getTextField(value);
        if (text) {
          this.callbacks.onThinkingDelta(turnId, text);
        }
        return;
      }
      case 'thinkingCompleted':
        this.callbacks.onThinkingComplete(turnId);
        return;
      case 'textDelta': {
        const text = this.getTextField(value);
        if (text) {
          this.callbacks.onOutputDelta(turnId, text);
        }
        return;
      }
      case 'turnEnded':
        this.callbacks.onTurnEnded(turnId);
        return;
      default:
        return;
    }
  }

  private getInteractionEnvelope(update: unknown): { caseName: string; value: any } | undefined {
    if (!update || typeof update !== 'object') {
      return undefined;
    }

    const message = (update as any).message;
    if (!message || typeof message !== 'object') {
      return undefined;
    }

    if (typeof message.case === 'string') {
      return {
        caseName: message.case,
        value: message.value,
      };
    }

    return undefined;
  }

  private getRequestUserMessage(request: unknown): string {
    if (!request || typeof request !== 'object') {
      return '';
    }

    const candidate = (request as any).userMessage;
    if (typeof candidate === 'string') {
      return candidate;
    }

    if (candidate && typeof candidate === 'object') {
      if (typeof candidate.text === 'string') {
        return candidate.text;
      }

      if (typeof candidate.richText === 'string') {
        return candidate.richText;
      }
    }

    return '';
  }

  private getUserMessageText(value: unknown): string {
    if (!value || typeof value !== 'object') {
      return '';
    }

    const userMessage = (value as any).userMessage;
    if (!userMessage || typeof userMessage !== 'object') {
      return '';
    }

    if (typeof userMessage.text === 'string') {
      return userMessage.text;
    }

    if (typeof userMessage.richText === 'string') {
      return userMessage.richText;
    }

    return '';
  }

  private getTextField(value: unknown): string {
    if (!value || typeof value !== 'object') {
      return '';
    }

    const text = (value as any).text;
    return typeof text === 'string' ? text : '';
  }
}
