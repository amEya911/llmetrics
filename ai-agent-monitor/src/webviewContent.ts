import * as vscode from 'vscode';

export function getConversationWebviewHtml(
  webview: vscode.Webview,
  title: string
): string {
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${title}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --surface: color-mix(in srgb, var(--bg) 92%, white 8%);
      --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground, rgba(128, 128, 128, 0.9));
      --user: #5b8def;
      --thinking: #d6a63d;
      --output: #37b36b;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 13px;
      line-height: 1.5;
    }

    header {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
    }

    .title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--output);
      flex: 0 0 auto;
    }

    .status-dot.monitoring,
    .status-dot.disconnected {
      background: rgba(128, 128, 128, 0.7);
    }

    .status-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    main {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .placeholder {
      padding: 24px 16px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--muted);
      text-align: center;
    }

    .placeholder.hidden {
      display: none;
    }

    .turn {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      overflow: hidden;
    }

    .turn-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
    }

    .source {
      font-weight: 600;
      color: var(--text);
    }

    .sections {
      display: flex;
      flex-direction: column;
    }

    .section {
      padding: 14px;
      border-top: 1px solid var(--border);
    }

    .section:first-child {
      border-top: 0;
    }

    .section.user-input {
      border-left: 3px solid var(--user);
    }

    .section.agent-thinking {
      border-left: 3px solid var(--thinking);
    }

    .section.agent-output {
      border-left: 3px solid var(--output);
    }

    .label {
      margin-bottom: 8px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .user-input .label {
      color: var(--user);
    }

    .agent-thinking .label {
      color: var(--thinking);
    }

    .agent-output .label {
      color: var(--output);
    }

    .content {
      min-height: 22px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace));
      font-size: var(--vscode-editor-font-size, 13px);
    }

    .content.empty::before {
      content: "\\00a0";
    }

    .agent-thinking .content {
      opacity: 0.88;
    }

    .streaming .content::after {
      content: '▍';
      margin-left: 1px;
      animation: blink 0.8s step-end infinite;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="title">${title}</div>
    <div class="status">
      <div id="status-dot" class="status-dot monitoring"></div>
      <div id="status-text" class="status-text">Listening for AI conversations...</div>
    </div>
  </header>

  <main>
    <div id="placeholder" class="placeholder">The next captured AI conversation will appear here.</div>
    <div id="turns"></div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const turns = [];
    const turnIndex = new Map();

    const labels = {
      'user-input': 'User Input',
      'agent-thinking': 'Agent Thinking',
      'agent-output': 'Agent Output',
    };

    const container = document.getElementById('turns');
    const placeholder = document.getElementById('placeholder');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    function escapeHtml(value) {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatTime(timestamp) {
      try {
        return new Date(timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      } catch {
        return '';
      }
    }

    function updateStatus(status, text) {
      statusDot.className = 'status-dot ' + (status || 'monitoring');
      statusText.textContent = text || 'Listening for AI conversations...';
    }

    function upsertTurn(turn) {
      const existingIndex = turnIndex.get(turn.id);
      if (existingIndex === undefined) {
        turnIndex.set(turn.id, turns.length);
        turns.push(turn);
        return;
      }

      turns[existingIndex] = turn;
    }

    function renderSection(type, block) {
      const classes = ['section', type];
      if (block.isStreaming) {
        classes.push('streaming');
      }

      const content = block.content || '';
      const contentClass = content ? 'content' : 'content empty';

      return \`
        <div class="\${classes.join(' ')}">
          <div class="label">\${labels[type]}:</div>
          <div class="\${contentClass}">\${escapeHtml(content)}</div>
        </div>
      \`;
    }

    function render() {
      placeholder.classList.toggle('hidden', turns.length > 0);
      container.innerHTML = turns.map((turn) => {
        const source = turn.source ? escapeHtml(turn.source) : 'AI Sidebar';
        return \`
          <section class="turn" data-turn-id="\${turn.id}">
            <div class="turn-meta">
              <span class="source">\${source}</span>
              <span>\${formatTime(turn.updatedAt)}</span>
            </div>
            <div class="sections">
              \${renderSection('user-input', turn.blocks['user-input'])}
              \${renderSection('agent-thinking', turn.blocks['agent-thinking'])}
              \${renderSection('agent-output', turn.blocks['agent-output'])}
            </div>
          </section>
        \`;
      }).join('');
    }

    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.command) {
        case 'sync':
          turns.length = 0;
          turnIndex.clear();
          for (const turn of message.turns || []) {
            upsertTurn(turn);
          }
          render();
          break;
        case 'updateTurn':
          if (message.turn) {
            upsertTurn(message.turn);
            render();
          }
          break;
        case 'clear':
          turns.length = 0;
          turnIndex.clear();
          render();
          break;
        case 'setStatus':
          updateStatus(message.status, message.text);
          break;
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}
