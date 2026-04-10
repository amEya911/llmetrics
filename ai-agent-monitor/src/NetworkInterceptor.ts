/* eslint-disable @typescript-eslint/no-var-requires */
// Type-only imports for type annotations
import type * as httpTypes from 'http';
import type * as httpsTypes from 'https';

// IMPORTANT: We use require() instead of import so that esbuild produces
// mutable module references. ES `import *` bindings are frozen, which
// prevents monkey-patching module.exports.request / .get at runtime.
const http: typeof httpTypes = require('http');
const https: typeof httpsTypes = require('https');
const zlib: typeof import('zlib') = require('zlib');
import * as vscode from 'vscode';

/**
 * NetworkInterceptor — Intercepts HTTP/HTTPS traffic at the Node.js level
 * to capture AI agent conversations in real-time.
 *
 * HOW IT WORKS:
 * All VS Code extensions run in the same Node.js process (extension host).
 * By monkey-patching `https.request`, we can observe ALL outgoing HTTPS
 * traffic — including requests from Antigravity, Copilot, Continue, etc.
 * to their respective AI backends (Google, OpenAI, Anthropic, etc.).
 *
 * SAFETY:
 * - Read-only: never modifies request/response data
 * - Non-blocking: all interception is passive and wrapped in try/catch
 * - Reversible: patches are cleanly removed on dispose()
 */
export class NetworkInterceptor implements vscode.Disposable {
  // Events for conversation data
  private _onUserMessage = new vscode.EventEmitter<{ content: string; source: string }>();
  readonly onUserMessage = this._onUserMessage.event;

  private _onAiResponseStart = new vscode.EventEmitter<{ source: string }>();
  readonly onAiResponseStart = this._onAiResponseStart.event;

  private _onAiResponseChunk = new vscode.EventEmitter<{ content: string; source: string }>();
  readonly onAiResponseChunk = this._onAiResponseChunk.event;

  private _onAiResponseEnd = new vscode.EventEmitter<{ source: string }>();
  readonly onAiResponseEnd = this._onAiResponseEnd.event;

  // Store originals for clean restoration
  private originalHttpsRequest: typeof httpsTypes.request;
  private originalHttpsGet: typeof httpsTypes.get;
  private originalHttpRequest: typeof httpTypes.request;
  private originalHttpGet: typeof httpTypes.get;
  private originalFetch?: typeof globalThis.fetch;
  private active = false;

  // AI API endpoints we intercept
  private readonly AI_ENDPOINTS: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /generativelanguage\.googleapis\.com/i, name: 'Gemini' },
    { pattern: /aiplatform\.googleapis\.com/i, name: 'Vertex AI' },
    { pattern: /api\.openai\.com/i, name: 'OpenAI' },
    { pattern: /api\.anthropic\.com/i, name: 'Anthropic' },
    { pattern: /api\.cohere\.ai/i, name: 'Cohere' },
    { pattern: /api\.mistral\.ai/i, name: 'Mistral' },
    { pattern: /api\.together\.ai/i, name: 'Together' },
    { pattern: /api\.groq\.com/i, name: 'Groq' },
    { pattern: /api\.fireworks\.ai/i, name: 'Fireworks' },
    { pattern: /api\.deepseek\.com/i, name: 'DeepSeek' },
    { pattern: /api\.perplexity\.ai/i, name: 'Perplexity' },
    { pattern: /localhost.*\/(v1|api)\/(chat|completions|generate)/i, name: 'Local LLM' },
    { pattern: /127\.0\.0\.1.*\/(v1|api)\/(chat|completions|generate)/i, name: 'Local LLM' },
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

  /** Install all network patches */
  start(): void {
    if (this.active) { return; }
    this.active = true;

    this.patchModule(https, this.originalHttpsRequest, this.originalHttpsGet, 'https');
    this.patchModule(http, this.originalHttpRequest, this.originalHttpGet, 'http');
    this.patchFetch();
  }

  /** Remove all patches, restore originals */
  stop(): void {
    if (!this.active) { return; }
    this.active = false;

    (https as any).request = this.originalHttpsRequest;
    (https as any).get = this.originalHttpsGet;
    (http as any).request = this.originalHttpRequest;
    (http as any).get = this.originalHttpGet;
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
    }
  }

  // ─── Module Patching ────────────────────────────────────────────────

  private patchModule(
    mod: any,
    origRequest: Function,
    origGet: Function,
    protocol: string
  ): void {
    const self = this;

    // Patch .request()
    mod.request = function (...args: any[]): httpTypes.ClientRequest {
      const req: httpTypes.ClientRequest = origRequest.apply(this, args as any);
      try { self.interceptOutgoing(req, args, protocol); } catch { /* never break caller */ }
      return req;
    };

    // Patch .get()
    mod.get = function (...args: any[]): httpTypes.ClientRequest {
      const req: httpTypes.ClientRequest = origGet.apply(this, args as any);
      try { self.interceptOutgoing(req, args, protocol); } catch { /* never break caller */ }
      return req;
    };
  }

  private patchFetch(): void {
    if (typeof globalThis.fetch !== 'function' || !this.originalFetch) { return; }
    const self = this;
    const origFetch = this.originalFetch;

    globalThis.fetch = async function (
      input: any,
      init?: any
    ): Promise<Response> {
      let url = '';
      try {
        url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url || '';
      } catch { /* ignore */ }

      const match = self.matchEndpoint(url);
      if (!match) {
        return origFetch(input, init);
      }

      // Parse request body
      if (init?.body) {
        try {
          const bodyStr =
            typeof init.body === 'string' ? init.body : init.body.toString();
          self.parseRequestBody(bodyStr, match.name);
        } catch { /* ignore */ }
      }

      const response = await origFetch(input, init);

      // Clone response to read without consuming the original
      try {
        const clone = response.clone();
        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/event-stream')) {
          self.handleFetchSSE(clone, match.name);
        } else {
          self.handleFetchJSON(clone, match.name);
        }
      } catch { /* ignore */ }

      return response; // Return original untouched
    };
  }

  // ─── Request Interception (http/https) ──────────────────────────────

  private interceptOutgoing(
    req: httpTypes.ClientRequest,
    args: any[],
    protocol: string
  ): void {
    const url = this.extractUrl(args, protocol);
    const match = this.matchEndpoint(url);
    if (!match) { return; }

    const source = match.name;
    const bodyChunks: Buffer[] = [];
    const self = this;

    // ── Intercept request body (user prompt) ──
    const origWrite = req.write;
    req.write = function (chunk: any, ...rest: any[]): boolean {
      try {
        if (chunk) {
          bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
      } catch { /* ignore */ }
      return (origWrite as any).apply(req, [chunk, ...rest]);
    };

    const origEnd = req.end;
    req.end = function (...args2: any[]): any {
      try {
        // First arg might be data, a callback, or nothing
        const first = args2[0];
        if (first && typeof first !== 'function') {
          bodyChunks.push(Buffer.isBuffer(first) ? first : Buffer.from(String(first)));
        }
        const fullBody = Buffer.concat(bodyChunks).toString('utf-8');
        if (fullBody.length > 2) {
          self.parseRequestBody(fullBody, source);
        }
      } catch { /* ignore */ }
      return (origEnd as any).apply(req, args2);
    };

    // ── Intercept response (AI response) ──
    req.on('response', (res: httpTypes.IncomingMessage) => {
      try {
        self.handleHttpResponse(res, source);
      } catch { /* ignore */ }
    });
  }

  // ─── Response Handling ──────────────────────────────────────────────

  private handleHttpResponse(res: httpTypes.IncomingMessage, source: string): void {
    const contentType = res.headers['content-type'] || '';
    const encoding = res.headers['content-encoding'] || '';
    const isSSE = contentType.includes('text/event-stream') || contentType.includes('stream');

    if (isSSE) {
      // SSE: stream chunks in real-time
      this._onAiResponseStart.fire({ source });
      let sseBuffer = '';

      res.on('data', (chunk: Buffer) => {
        try {
          sseBuffer += chunk.toString('utf-8');
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            const content = this.parseSSELine(line);
            if (content) {
              this._onAiResponseChunk.fire({ content, source });
            }
          }
        } catch { /* ignore */ }
      });

      res.on('end', () => {
        try {
          // Process remaining buffer
          if (sseBuffer.trim()) {
            const content = this.parseSSELine(sseBuffer);
            if (content) {
              this._onAiResponseChunk.fire({ content, source });
            }
          }
          this._onAiResponseEnd.fire({ source });
        } catch { /* ignore */ }
      });
    } else {
      // Non-streaming: collect everything, parse on end
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        try {
          let body = Buffer.concat(chunks);

          // Decompress if needed
          if (encoding === 'gzip') {
            body = zlib.gunzipSync(body);
          } else if (encoding === 'br') {
            body = zlib.brotliDecompressSync(body);
          } else if (encoding === 'deflate') {
            body = zlib.inflateSync(body);
          }

          const text = body.toString('utf-8');
          const content = this.extractAIContent(text);
          if (content) {
            this._onAiResponseStart.fire({ source });
            this._onAiResponseChunk.fire({ content, source });
            this._onAiResponseEnd.fire({ source });
          }
        } catch { /* ignore */ }
      });
    }
  }

  private async handleFetchSSE(response: Response, source: string): Promise<void> {
    try {
      this._onAiResponseStart.fire({ source });
      const reader = response.body?.getReader();
      if (!reader) { return; }

      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const content = this.parseSSELine(line);
          if (content) {
            this._onAiResponseChunk.fire({ content, source });
          }
        }
      }
      this._onAiResponseEnd.fire({ source });
    } catch { /* ignore */ }
  }

  private async handleFetchJSON(response: Response, source: string): Promise<void> {
    try {
      const text = await response.text();
      const content = this.extractAIContent(text);
      if (content) {
        this._onAiResponseStart.fire({ source });
        this._onAiResponseChunk.fire({ content, source });
        this._onAiResponseEnd.fire({ source });
      }
    } catch { /* ignore */ }
  }

  // ─── Parsing Helpers ────────────────────────────────────────────────

  private extractUrl(args: any[], protocol: string): string {
    try {
      const first = args[0];
      if (typeof first === 'string') { return first; }
      if (first instanceof URL) { return first.toString(); }
      if (first && typeof first === 'object') {
        const host = first.hostname || first.host || '';
        const path = first.path || '/';
        const port = first.port ? `:${first.port}` : '';
        return `${protocol}://${host}${port}${path}`;
      }
    } catch { /* ignore */ }
    return '';
  }

  private matchEndpoint(url: string): { pattern: RegExp; name: string } | null {
    if (!url) { return null; }
    for (const ep of this.AI_ENDPOINTS) {
      if (ep.pattern.test(url)) { return ep; }
    }
    return null;
  }

  /** Parse an SSE line like `data: {"choices":[...]}` */
  private parseSSELine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) { return ''; }

    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') { return ''; }

    return this.extractAIContent(data);
  }

  /**
   * Parse the request body to extract the user's message.
   * Handles OpenAI, Gemini, Anthropic, and generic formats.
   */
  private parseRequestBody(body: string, source: string): void {
    try {
      const parsed = JSON.parse(body);
      let userContent = '';

      // OpenAI / Anthropic: messages array
      if (Array.isArray(parsed.messages)) {
        const lastUser = [...parsed.messages]
          .reverse()
          .find((m: any) => m.role === 'user');
        if (lastUser) {
          if (typeof lastUser.content === 'string') {
            userContent = lastUser.content;
          } else if (Array.isArray(lastUser.content)) {
            // Multi-modal content
            userContent = lastUser.content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('\n');
          }
        }
      }

      // Gemini: contents array
      if (!userContent && Array.isArray(parsed.contents)) {
        const lastUser = [...parsed.contents]
          .reverse()
          .find((c: any) => c.role === 'user');
        if (lastUser?.parts) {
          userContent = lastUser.parts
            .map((p: any) => p.text || '')
            .filter(Boolean)
            .join('\n');
        }
      }

      // Generic: prompt field
      if (!userContent && typeof parsed.prompt === 'string') {
        userContent = parsed.prompt;
      }

      // Generic: input field
      if (!userContent && typeof parsed.input === 'string') {
        userContent = parsed.input;
      }

      if (userContent && userContent.trim().length > 0) {
        this._onUserMessage.fire({ content: userContent.trim(), source });
      }
    } catch {
      // Not JSON — ignore
    }
  }

  /**
   * Extract AI response content from a JSON string.
   * Handles OpenAI, Gemini, Anthropic, and generic formats.
   */
  private extractAIContent(data: string): string {
    try {
      const parsed = JSON.parse(data);

      // OpenAI streaming: delta
      if (parsed.choices?.[0]?.delta?.content) {
        return parsed.choices[0].delta.content;
      }

      // OpenAI non-streaming: message
      if (parsed.choices?.[0]?.message?.content) {
        return parsed.choices[0].message.content;
      }

      // OpenAI completion
      if (parsed.choices?.[0]?.text) {
        return parsed.choices[0].text;
      }

      // Anthropic streaming: content_block_delta
      if (parsed.delta?.text) {
        return parsed.delta.text;
      }

      // Anthropic non-streaming
      if (parsed.content?.[0]?.text) {
        return parsed.content[0].text;
      }

      // Anthropic legacy
      if (typeof parsed.completion === 'string') {
        return parsed.completion;
      }

      // Gemini
      if (parsed.candidates?.[0]?.content?.parts) {
        return parsed.candidates[0].content.parts
          .map((p: any) => p.text || '')
          .join('');
      }

      // Generic fields
      if (typeof parsed.text === 'string' && parsed.text) { return parsed.text; }
      if (typeof parsed.response === 'string' && parsed.response) { return parsed.response; }
      if (typeof parsed.output === 'string' && parsed.output) { return parsed.output; }
      if (typeof parsed.result === 'string' && parsed.result) { return parsed.result; }
      if (typeof parsed.generated_text === 'string') { return parsed.generated_text; }
    } catch {
      // Not JSON — ignore
    }
    return '';
  }

  dispose(): void {
    this.stop();
    this._onUserMessage.dispose();
    this._onAiResponseStart.dispose();
    this._onAiResponseChunk.dispose();
    this._onAiResponseEnd.dispose();
  }
}
