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
      --panel: color-mix(in srgb, var(--bg) 92%, white 8%);
      --panel-strong: color-mix(in srgb, var(--bg) 88%, white 12%);
      --panel-muted: color-mix(in srgb, var(--bg) 95%, white 5%);
      --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground, rgba(128, 128, 128, 0.9));
      --shadow: 0 10px 26px rgba(0, 0, 0, 0.12);
      --accent: color-mix(in srgb, var(--vscode-focusBorder, #5b8def) 78%, white 22%);
      --user: #5b8def;
      --thinking: #d8a23f;
      --output: #35b26f;
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

    .shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      background: color-mix(in srgb, var(--bg) 94%, black 6%);
      border-bottom: 1px solid var(--border);
    }

    .header-copy {
      min-width: 0;
    }

    .eyebrow {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .host-label {
      margin-top: 2px;
      font-size: 16px;
      font-weight: 700;
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
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--output);
      flex: 0 0 auto;
    }

    .status-dot.monitoring,
    .status-dot.disconnected {
      background: rgba(128, 128, 128, 0.7);
    }

    .status-text {
      max-width: 260px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    main {
      flex: 1;
      display: grid;
      grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
      min-height: 0;
    }

    aside {
      border-right: 1px solid var(--border);
      background: var(--panel-muted);
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .chat-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 14px 10px;
      border-bottom: 1px solid var(--border);
    }

    .chat-list-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .chat-count {
      min-width: 24px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--panel);
      border: 1px solid var(--border);
      text-align: center;
      font-size: 11px;
      font-weight: 700;
    }

    .chat-list {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow: auto;
    }

    .chat-item {
      width: 100%;
      padding: 12px 12px 11px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: inherit;
      text-align: left;
      cursor: pointer;
      transition: border-color 0.14s ease, transform 0.14s ease, background 0.14s ease;
    }

    .chat-item:hover {
      border-color: color-mix(in srgb, var(--accent) 55%, var(--border) 45%);
      transform: translateY(-1px);
    }

    .chat-item.selected {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--panel-strong) 78%, var(--accent) 22%);
      box-shadow: var(--shadow);
    }

    .chat-title-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .chat-title {
      font-size: 13px;
      font-weight: 700;
      line-height: 1.35;
    }

    .chat-time {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }

    .chat-subtitle {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .chat-empty,
    .pane-empty,
    .shell-empty {
      padding: 18px;
      margin: 16px;
      border: 1px dashed var(--border);
      border-radius: 16px;
      background: var(--panel);
      color: var(--muted);
      text-align: center;
    }

    .chat-pane {
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--bg) 94%, white 6%) 0%,
        var(--bg) 100%
      );
    }

    .chat-pane-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 95%, black 5%);
    }

    .chat-pane-title {
      font-size: 18px;
      font-weight: 700;
      line-height: 1.35;
    }

    .chat-pane-subtitle {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
    }

    .chat-pane-time {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      padding-top: 3px;
    }

    .turns {
      padding: 18px 20px 24px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .turn {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--panel);
      overflow: hidden;
      box-shadow: var(--shadow);
    }

    .turn-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      background: color-mix(in srgb, var(--panel) 88%, black 12%);
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .sections {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 16px;
    }

    .section {
      padding: 14px 15px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 88%, white 12%);
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

    .user-input .label { color: var(--user); }
    .agent-thinking .label { color: var(--thinking); }
    .agent-output .label { color: var(--output); }

    .content {
      min-height: 22px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace));
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.55;
    }

    .content.empty::before {
      content: "\\00a0";
    }

    .agent-thinking .content {
      opacity: 0.9;
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

    @media (max-width: 760px) {
      main {
        grid-template-columns: 1fr;
      }

      aside {
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }

      .chat-list {
        max-height: 220px;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="header-copy">
        <div class="eyebrow">${title}</div>
        <div id="host-label" class="host-label">AI Sidebar</div>
      </div>
      <div class="status">
        <div id="status-dot" class="status-dot monitoring"></div>
        <div id="status-text" class="status-text">Listening for AI conversations...</div>
      </div>
    </header>

    <main>
      <aside>
        <div class="chat-list-header">
          <div class="chat-list-title">Chats</div>
          <div id="chat-count" class="chat-count">0</div>
        </div>
        <div id="chat-list" class="chat-list"></div>
      </aside>

      <section id="chat-pane" class="chat-pane"></section>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let snapshot = {
      app: 'unknown',
      appLabel: 'AI Sidebar',
      chats: [],
      selectedChatId: undefined,
    };
    let selectedChatId;

    const labels = {
      'user-input': 'User Input',
      'agent-thinking': 'Agent Thinking',
      'agent-output': 'Agent Output',
    };

    const hostLabel = document.getElementById('host-label');
    const chatCount = document.getElementById('chat-count');
    const chatList = document.getElementById('chat-list');
    const chatPane = document.getElementById('chat-pane');
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
        });
      } catch {
        return '';
      }
    }

    function updateStatus(status, text) {
      statusDot.className = 'status-dot ' + (status || 'monitoring');
      statusText.textContent = text || 'Listening for AI conversations...';
    }

    function ensureSelectedChat() {
      const chatIds = new Set((snapshot.chats || []).map((chat) => chat.id));

      if (selectedChatId && chatIds.has(selectedChatId)) {
        return;
      }

      selectedChatId = snapshot.selectedChatId && chatIds.has(snapshot.selectedChatId)
        ? snapshot.selectedChatId
        : snapshot.chats[0]?.id;
    }

    function applySnapshot(nextSnapshot) {
      snapshot = nextSnapshot || {
        app: 'unknown',
        appLabel: 'AI Sidebar',
        chats: [],
        selectedChatId: undefined,
      };
      ensureSelectedChat();
      render();
    }

    function getSelectedChat() {
      return (snapshot.chats || []).find((chat) => chat.id === selectedChatId);
    }

    function renderChatList() {
      const chats = snapshot.chats || [];
      chatCount.textContent = String(chats.length);
      hostLabel.textContent = snapshot.appLabel || 'AI Sidebar';

      if (chats.length === 0) {
        chatList.innerHTML = '<div class="chat-empty">No tracked chats yet for this app.</div>';
        return;
      }

      chatList.innerHTML = chats.map((chat) => {
        const subtitle = chat.subtitle
          ? '<div class="chat-subtitle">' + escapeHtml(chat.subtitle) + '</div>'
          : '';
        const selected = chat.id === selectedChatId ? ' selected' : '';
        return \`
          <button class="chat-item\${selected}" data-chat-id="\${escapeHtml(chat.id)}" type="button">
            <div class="chat-title-row">
              <div class="chat-title">\${escapeHtml(chat.title || 'Untitled chat')}</div>
              <div class="chat-time">\${escapeHtml(formatTime(chat.updatedAt || chat.createdAt || Date.now()))}</div>
            </div>
            \${subtitle}
          </button>
        \`;
      }).join('');

      for (const button of chatList.querySelectorAll('[data-chat-id]')) {
        button.addEventListener('click', () => {
          selectedChatId = button.getAttribute('data-chat-id');
          render();
        });
      }
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

    function renderChatPane() {
      const chats = snapshot.chats || [];
      const selectedChat = getSelectedChat();

      if (chats.length === 0) {
        chatPane.innerHTML = '<div class="shell-empty">The next captured AI chat will appear here.</div>';
        return;
      }

      if (!selectedChat) {
        chatPane.innerHTML = '<div class="pane-empty">Select a chat to view its captured conversation.</div>';
        return;
      }

      const paneSubtitle = selectedChat.subtitle
        ? '<div class="chat-pane-subtitle">' + escapeHtml(selectedChat.subtitle) + '</div>'
        : '';

      const turnMarkup = (selectedChat.turns || []).map((turn, index) => {
        return \`
          <section class="turn">
            <div class="turn-meta">
              <span>Turn \${index + 1}</span>
              <span>\${escapeHtml(formatTime(turn.updatedAt || turn.createdAt || Date.now()))}</span>
            </div>
            <div class="sections">
              \${renderSection('user-input', turn.blocks['user-input'])}
              \${renderSection('agent-thinking', turn.blocks['agent-thinking'])}
              \${renderSection('agent-output', turn.blocks['agent-output'])}
            </div>
          </section>
        \`;
      }).join('');

      const turnsSection = turnMarkup
        ? '<div class="turns">' + turnMarkup + '</div>'
        : '<div class="pane-empty">No captured messages yet for this chat.</div>';

      chatPane.innerHTML = \`
        <div class="chat-pane-header">
          <div>
            <div class="chat-pane-title">\${escapeHtml(selectedChat.title || 'Untitled chat')}</div>
            \${paneSubtitle}
          </div>
          <div class="chat-pane-time">\${escapeHtml(formatTime(selectedChat.updatedAt || selectedChat.createdAt || Date.now()))}</div>
        </div>
        \${turnsSection}
      \`;
    }

    function render() {
      renderChatList();
      renderChatPane();
    }

    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.command) {
        case 'sync':
          applySnapshot(message.snapshot);
          break;
        case 'clear':
          applySnapshot({
            ...snapshot,
            chats: [],
            selectedChatId: undefined,
          });
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
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}
