'use strict';

const fs = require('fs');
const http = require('http');
const http2 = require('http2');
const https = require('https');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const vscode = require('vscode');

const ACTIVATION_LOG_PATH = path.join(os.tmpdir(), 'ai-token-analytics-helper-activation.log');
const NETWORK_LOG_PATH = path.join(os.tmpdir(), 'ai-token-analytics-helper-network.log');

const WRAPPED_REQUEST = Symbol('ai-token-analytics-helper.request');
const WRAPPED_STREAM = Symbol('ai-token-analytics-helper.stream');

let requestCounter = 0;
let restoreFns = [];
let activationLogTargets = [ACTIVATION_LOG_PATH];
let networkLogTargets = [NETWORK_LOG_PATH];

function appendJsonLine(filePath, payload) {
  try {
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`,
      'utf8'
    );
  } catch {
    // Ignore logging failures during diagnostics.
  }
}

function writeLogs(targets, payload) {
  for (const filePath of targets) {
    appendJsonLine(filePath, payload);
  }

  try {
    console.log('[ai-token-analytics-helper]', JSON.stringify(payload));
  } catch {
    // Ignore console logging failures during diagnostics.
  }
}

function nextRequestId() {
  requestCounter += 1;
  return `helper:${process.pid}:${Date.now()}:${requestCounter}`;
}

function normalizeHeaders(value) {
  const normalized = {};
  if (!value) {
    return normalized;
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && !Array.isArray(value[0])) {
      for (let index = 0; index + 1 < value.length; index += 2) {
        normalized[String(value[index]).toLowerCase()] = headerValueToText(value[index + 1]);
      }
      return normalized;
    }

    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length < 2) {
        continue;
      }
      normalized[String(entry[0]).toLowerCase()] = headerValueToText(entry[1]);
    }
    return normalized;
  }

  for (const [key, rawValue] of Object.entries(value)) {
    normalized[String(key).toLowerCase()] = headerValueToText(rawValue);
  }

  return normalized;
}

function headerValueToText(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  if (Array.isArray(value)) {
    return value.map((entry) => headerValueToText(entry)).join(', ');
  }

  if (value && ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('utf8');
  }

  return String(value ?? '');
}

function bufferToLogText(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''));
  if (buffer.length === 0) {
    return '';
  }

  const text = buffer.toString('utf8');
  const nonPrintable = text.replace(/[\x20-\x7e\n\r\t]/g, '');
  return nonPrintable.length <= Math.max(2, text.length * 0.1)
    ? text
    : `hex:${buffer.toString('hex')}`;
}

function extractRequestDetails(protocol, args) {
  const first = args[0];
  const second = args[1];

  try {
    if (typeof first === 'string' || first instanceof URL) {
      const url = new URL(String(first));
      const headers = normalizeHeaders(
        first instanceof URL
          ? second && typeof second === 'object' ? second.headers : undefined
          : second && typeof second === 'object' ? second.headers : undefined
      );
      return { url: url.toString(), headers };
    }
  } catch {
    // Ignore malformed URL inputs.
  }

  if (first && typeof first === 'object') {
    const host = first.hostname || first.host || '';
    const port = first.port ? `:${first.port}` : '';
    const requestPath = typeof first.path === 'string'
      ? first.path
      : typeof first.pathname === 'string'
        ? `${first.pathname}${first.search || ''}`
        : '/';

    return {
      url: `${protocol}://${host}${port}${requestPath}`,
      headers: normalizeHeaders(first.headers),
    };
  }

  return { url: '', headers: {} };
}

function extractFetchUrl(input) {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input && typeof input === 'object' && typeof input.url === 'string') {
    return input.url;
  }
  return '';
}

function bodyToText(body) {
  if (body === undefined || body === null) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }
  if (body && ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString('utf8');
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return String(body);
}

function wrapClientRequest(req, details) {
  if (!req || req[WRAPPED_REQUEST]) {
    return req;
  }

  req[WRAPPED_REQUEST] = true;
  const requestChunks = [];
  const originalWrite = req.write.bind(req);
  const originalEnd = req.end.bind(req);

  req.write = function patchedWrite(chunk, encoding, callback) {
    if (chunk !== undefined) {
      requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }
    return originalWrite(chunk, encoding, callback);
  };

  req.end = function patchedEnd(chunk, encoding, callback) {
    if (chunk !== undefined) {
      requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }

    writeLogs(networkLogTargets, {
      phase: 'request',
      transport: details.transport,
      requestId: details.requestId,
      url: details.url,
      headers: details.headers,
      body: bufferToLogText(Buffer.concat(requestChunks)),
    });

    return originalEnd(chunk, encoding, callback);
  };

  req.on('response', (res) => {
      writeLogs(networkLogTargets, {
        phase: 'response-headers',
        transport: details.transport,
        requestId: details.requestId,
      url: details.url,
      statusCode: res.statusCode,
      headers: normalizeHeaders(res.headers),
    });

    res.on('data', (chunk) => {
      writeLogs(networkLogTargets, {
        phase: 'response-chunk',
        transport: details.transport,
        requestId: details.requestId,
        url: details.url,
        chunk: bufferToLogText(chunk),
      });
    });

    res.on('end', () => {
      writeLogs(networkLogTargets, {
        phase: 'response-end',
        transport: details.transport,
        requestId: details.requestId,
        url: details.url,
      });
    });
  });

  return req;
}

function patchHttpModule(mod, protocol) {
  const originalRequest = mod.request;
  const originalGet = mod.get;

  mod.request = function patchedRequest(...args) {
    const details = extractRequestDetails(protocol, args);
    const req = originalRequest.apply(mod, args);
    return wrapClientRequest(req, {
      ...details,
      transport: protocol,
      requestId: nextRequestId(),
    });
  };

  mod.get = function patchedGet(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };

  restoreFns.push(() => {
    mod.request = originalRequest;
    mod.get = originalGet;
  });
}

function patchHttp2() {
  const originalConnect = http2.connect;

  http2.connect = function patchedConnect(...args) {
    const session = originalConnect.apply(http2, args);
    const authority = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].toString() : '';
    const originalRequest = session.request.bind(session);

    session.request = function patchedSessionRequest(headers, options) {
      const requestId = nextRequestId();
      const requestHeaders = normalizeHeaders(headers);
      const requestChunks = [];
      const stream = originalRequest(headers, options);
      const rawPath = requestHeaders[':path'] || '/';
      const url = authority ? `${authority}${rawPath}` : rawPath;

      if (!stream[WRAPPED_STREAM]) {
        stream[WRAPPED_STREAM] = true;
        const originalWrite = stream.write.bind(stream);
        const originalEnd = stream.end.bind(stream);

        stream.write = function patchedWrite(chunk, encoding, callback) {
          if (chunk !== undefined) {
            requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
          }
          return originalWrite(chunk, encoding, callback);
        };

        stream.end = function patchedEnd(chunk, encoding, callback) {
          if (chunk !== undefined) {
            requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
          }

          writeLogs(networkLogTargets, {
            phase: 'request',
            transport: 'http2',
            requestId,
            url,
            headers: requestHeaders,
            body: bufferToLogText(Buffer.concat(requestChunks)),
          });

          return originalEnd(chunk, encoding, callback);
        };

        stream.on('response', (responseHeaders) => {
          writeLogs(networkLogTargets, {
            phase: 'response-headers',
            transport: 'http2',
            requestId,
            url,
            headers: normalizeHeaders(responseHeaders),
          });
        });

        stream.on('data', (chunk) => {
          writeLogs(networkLogTargets, {
            phase: 'response-chunk',
            transport: 'http2',
            requestId,
            url,
            chunk: bufferToLogText(chunk),
          });
        });

        stream.on('end', () => {
          writeLogs(networkLogTargets, {
            phase: 'response-end',
            transport: 'http2',
            requestId,
            url,
          });
        });
      }

      return stream;
    };

    return session;
  };

  restoreFns.push(() => {
    http2.connect = originalConnect;
  });
}

function patchFetch() {
  if (typeof globalThis.fetch !== 'function') {
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function patchedFetch(input, init) {
    const requestId = nextRequestId();
    const url = extractFetchUrl(input);
    const requestHeaders = normalizeHeaders(
      init && init.headers
        ? init.headers
        : input && typeof input === 'object' && input.headers
          ? input.headers
          : undefined
    );

    writeLogs(networkLogTargets, {
      phase: 'request',
      transport: 'fetch',
      requestId,
      url,
      headers: requestHeaders,
      body: bodyToText(init && init.body !== undefined ? init.body : input && input.body),
    });

    const response = await originalFetch(input, init);
    writeLogs(networkLogTargets, {
      phase: 'response-headers',
      transport: 'fetch',
      requestId,
      url,
      statusCode: response.status,
      headers: normalizeHeaders(Object.fromEntries(response.headers.entries())),
    });

    try {
      const clone = response.clone();
      if (clone.body && typeof clone.body.getReader === 'function') {
        const reader = clone.body.getReader();
        void (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              writeLogs(networkLogTargets, {
                phase: 'response-end',
                transport: 'fetch',
                requestId,
                url,
              });
              break;
            }

            writeLogs(networkLogTargets, {
              phase: 'response-chunk',
              transport: 'fetch',
              requestId,
              url,
              chunk: bufferToLogText(Buffer.from(value)),
            });
          }
        })().catch(() => {});
      } else {
        const text = await clone.text();
        writeLogs(networkLogTargets, {
          phase: 'response-chunk',
          transport: 'fetch',
          requestId,
          url,
          chunk: text,
        });
        writeLogs(networkLogTargets, {
          phase: 'response-end',
          transport: 'fetch',
          requestId,
          url,
        });
      }
    } catch {
      // Ignore response clone failures.
    }

    return response;
  };

  restoreFns.push(() => {
    globalThis.fetch = originalFetch;
  });
}

function runProcessDiagnostics() {
  childProcess.execFile('ps', ['-axo', 'pid,ppid,command'], (error, stdout, stderr) => {
    const lines = String(stdout || '')
      .split(/\r?\n/)
      .filter((line) => /Cursor Helper \(Plugin\)|cursor-agent|cursor-retrieval|cursor-agent-exec|cursor-always-local/.test(line));

    const diagnostics = {
      phase: 'process-scan',
      currentPid: process.pid,
      currentPpid: process.ppid,
      error: error ? String(error.message || error) : undefined,
      stderr: stderr ? String(stderr).trim() : undefined,
      matches: lines,
    };

    writeLogs(activationLogTargets, diagnostics);

    const signalTargets = [];
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+/);
      const pid = match ? Number.parseInt(match[1], 10) : NaN;
      if (!Number.isFinite(pid) || pid === process.pid) {
        continue;
      }

      const roleMatch = line.match(/extension-host \(([^)]+)\)/);
      const role = roleMatch ? roleMatch[1] : undefined;

      try {
        process.kill(pid, 0);
        writeLogs(activationLogTargets, {
          phase: 'process-signal-check',
          currentPid: process.pid,
          targetPid: pid,
          role,
          allowed: true,
        });
        if (role) {
          signalTargets.push({ pid, role });
        }
      } catch (signalError) {
        writeLogs(activationLogTargets, {
          phase: 'process-signal-check',
          currentPid: process.pid,
          targetPid: pid,
          role,
          allowed: false,
          error: String(signalError && signalError.message ? signalError.message : signalError),
        });
      }
    }

    for (const target of signalTargets) {
      try {
        process.kill(target.pid, 'SIGUSR1');
        writeLogs(activationLogTargets, {
          phase: 'process-signal-send',
          currentPid: process.pid,
          targetPid: target.pid,
          role: target.role,
          signal: 'SIGUSR1',
          ok: true,
        });
      } catch (signalError) {
        writeLogs(activationLogTargets, {
          phase: 'process-signal-send',
          currentPid: process.pid,
          targetPid: target.pid,
          role: target.role,
          signal: 'SIGUSR1',
          ok: false,
          error: String(signalError && signalError.message ? signalError.message : signalError),
        });
      }
    }

    setTimeout(() => {
      childProcess.execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], (lsofError, lsofStdout, lsofStderr) => {
        const relevantLines = String(lsofStdout || '')
          .split(/\r?\n/)
          .filter((line) => signalTargets.some((target) => line.includes(` ${target.pid} `)));

        writeLogs(activationLogTargets, {
          phase: 'process-inspector-scan',
          currentPid: process.pid,
          error: lsofError ? String(lsofError.message || lsofError) : undefined,
          stderr: lsofStderr ? String(lsofStderr).trim() : undefined,
          matches: relevantLines,
        });
      });
    }, 800);
  });
}

function activate() {
  restoreFns = [];
  const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  const primaryWorkspace = workspaceFolders[0];

  activationLogTargets = [ACTIVATION_LOG_PATH];
  networkLogTargets = [NETWORK_LOG_PATH];
  if (primaryWorkspace) {
    activationLogTargets.push(path.join(primaryWorkspace, '.ai-token-analytics-helper-activation.log'));
    networkLogTargets.push(path.join(primaryWorkspace, '.ai-token-analytics-helper-network.log'));
  }

  writeLogs(activationLogTargets, {
    helper: true,
    phase: 'activate',
    pid: process.pid,
    appName: vscode.env.appName,
    remoteName: vscode.env.remoteName || null,
    uiKind: vscode.env.uiKind,
    execPath: process.execPath,
    cwd: process.cwd(),
    workspaceFolders,
  });

  patchHttpModule(http, 'http');
  patchHttpModule(https, 'https');
  patchHttp2();
  patchFetch();
  runProcessDiagnostics();

  writeLogs(networkLogTargets, {
    phase: 'helper-ready',
    pid: process.pid,
    appName: vscode.env.appName,
    remoteName: vscode.env.remoteName || null,
    uiKind: vscode.env.uiKind,
  });

  return {
    dispose() {
      while (restoreFns.length > 0) {
        const restore = restoreFns.pop();
        try {
          restore();
        } catch {
          // Ignore cleanup failures during diagnostics.
        }
      }
    },
  };
}

function deactivate() {
  while (restoreFns.length > 0) {
    const restore = restoreFns.pop();
    try {
      restore();
    } catch {
      // Ignore cleanup failures during diagnostics.
    }
  }
}

appendJsonLine(ACTIVATION_LOG_PATH, {
  phase: 'module-load',
  pid: process.pid,
  cwd: process.cwd(),
});
try {
  console.log('[ai-token-analytics-helper] module-load', JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
} catch {
  // Ignore console logging failures during diagnostics.
}

module.exports = {
  activate,
  deactivate,
};
