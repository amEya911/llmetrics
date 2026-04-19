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
      --bg: #091018;
      --bg-elevated: #0f1824;
      --card: rgba(18, 27, 39, 0.92);
      --card-strong: rgba(12, 20, 30, 0.98);
      --card-soft: rgba(255, 255, 255, 0.035);
      --border: rgba(134, 170, 214, 0.16);
      --text: #edf3fb;
      --muted: #8d9aab;
      --muted-strong: #b8c5d7;
      --blue: #65b8ff;
      --blue-soft: rgba(101, 184, 255, 0.14);
      --green: #5dd3a6;
      --green-soft: rgba(93, 211, 166, 0.14);
      --amber: #f0bc5a;
      --amber-soft: rgba(240, 188, 90, 0.15);
      --red: #ff7f81;
      --red-soft: rgba(255, 127, 129, 0.14);
      --shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
      --radius: 22px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(101, 184, 255, 0.12), transparent 30%),
        radial-gradient(circle at top right, rgba(93, 211, 166, 0.08), transparent 24%),
        linear-gradient(180deg, #091018 0%, #070d14 100%);
      color: var(--text);
      font-family: "Aptos", "Segoe UI Variable", "SF Pro Display", sans-serif;
      font-size: 13px;
      line-height: 1.45;
    }

    button,
    input {
      font: inherit;
    }

    .shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 20px;
      backdrop-filter: blur(18px);
      background: rgba(8, 13, 20, 0.82);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .topbar-copy {
      min-width: 0;
    }

    .eyebrow {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .title {
      margin-top: 5px;
      font-size: 21px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }

    .subtitle {
      margin-top: 5px;
      color: var(--muted);
      max-width: 60ch;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.03);
      white-space: nowrap;
      min-width: 0;
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--green);
      flex: 0 0 auto;
    }

    .status-dot.monitoring {
      background: var(--amber);
    }

    .status-dot.disconnected {
      background: var(--red);
    }

    .status-text {
      color: var(--muted-strong);
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    main {
      padding: 18px 20px 28px;
      display: grid;
      gap: 18px;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(18, 27, 39, 0.96), rgba(12, 19, 28, 0.98));
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .card-head {
      padding: 18px 20px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .card-kicker {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .card-title {
      margin-top: 5px;
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }

    .card-subtitle {
      margin-top: 5px;
      color: var(--muted);
    }

    .card-body {
      padding: 18px 20px 20px;
    }

    .sticky-live {
      position: sticky;
      top: 82px;
      z-index: 15;
    }

    .live-layout {
      display: grid;
      gap: 18px;
      grid-template-columns: minmax(280px, 0.96fr) minmax(0, 1.24fr);
      align-items: stretch;
    }

    .live-overview {
      display: grid;
      gap: 14px;
      align-content: space-between;
    }

    .pill-row,
    .meta-row,
    .actions-row,
    .inline-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .pill,
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.06);
      color: var(--muted-strong);
    }

    .pill.blue { background: var(--blue-soft); color: #d4ebff; }
    .pill.green { background: var(--green-soft); color: #ccf6e8; }
    .pill.amber { background: var(--amber-soft); color: #ffe9bf; }
    .pill.red { background: var(--red-soft); color: #ffd0d1; }

    .tag {
      text-transform: none;
      letter-spacing: 0;
    }

    .live-title {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.05em;
      line-height: 1.05;
    }

    .live-subtitle {
      color: var(--muted);
      font-size: 13px;
    }

    .hero-metric {
      padding: 16px;
      border-radius: 20px;
      background: linear-gradient(180deg, rgba(101, 184, 255, 0.12), rgba(255, 255, 255, 0.03));
      border: 1px solid rgba(101, 184, 255, 0.14);
    }

    .hero-value {
      font-size: 38px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: -0.06em;
    }

    .hero-context {
      margin-top: 8px;
      color: var(--muted-strong);
      font-size: 13px;
    }

    .context-progress {
      margin-top: 12px;
      height: 12px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      overflow: hidden;
    }

    .context-progress-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--blue), #8fd0ff);
    }

    .mini-stats {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .mini-stat {
      padding: 12px;
      border-radius: 18px;
      background: var(--card-soft);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .mini-stat-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .mini-stat-value {
      margin-top: 6px;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }

    .mini-stat-context {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }

    .live-timeline-wrap {
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      min-height: 420px;
      max-height: 520px;
    }

    .timeline-head,
    .timeline-footer {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .timeline-footer {
      border-bottom: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(255, 255, 255, 0.03);
    }

    .timeline-title {
      font-size: 14px;
      font-weight: 800;
    }

    .timeline-subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }

    .timeline-scroll {
      overflow: auto;
      padding: 10px 12px 12px;
      display: grid;
      gap: 10px;
    }

    .exchange {
      padding: 12px;
      border-radius: 18px;
      background: rgba(0, 0, 0, 0.14);
      border: 1px solid rgba(255, 255, 255, 0.04);
      display: grid;
      gap: 8px;
    }

    .timeline-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 10px 11px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
    }

    .timeline-row.user {
      border-left: 3px solid var(--blue);
    }

    .timeline-row.agent {
      border-left: 3px solid var(--green);
    }

    .timeline-role {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .timeline-snippet {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--muted-strong);
    }

    .timeline-meta {
      color: var(--text);
      font-weight: 700;
      text-align: right;
      white-space: nowrap;
    }

    .timeline-meta-sub {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
    }

    .timeline-save {
      justify-self: end;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: transparent;
      color: var(--muted-strong);
      border-radius: 999px;
      padding: 7px 11px;
      cursor: pointer;
    }

    .session-total {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      font-weight: 700;
    }

    .session-total strong {
      font-size: 20px;
      letter-spacing: -0.03em;
    }

    .stats-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .stat-card {
      padding: 16px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .stat-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .stat-value {
      margin-top: 7px;
      font-size: 32px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: -0.05em;
    }

    .stat-context {
      margin-top: 8px;
      color: var(--muted-strong);
    }

    .stat-secondary {
      margin-top: 8px;
      color: var(--muted-strong);
      font-size: 13px;
      font-weight: 700;
    }

    .analytics-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: minmax(260px, 1.1fr) minmax(280px, 0.9fr);
      margin-top: 14px;
    }

    .subcard {
      padding: 16px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .subcard-title {
      font-size: 14px;
      font-weight: 800;
    }

    .subcard-note {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }

    .sparkline {
      margin-top: 14px;
      min-height: 150px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(14px, 1fr));
      gap: 8px;
      align-items: end;
    }

    .spark-bar {
      display: grid;
      gap: 7px;
      align-items: end;
      justify-items: stretch;
    }

    .spark-bar-fill {
      width: 100%;
      min-height: 8px;
      border-radius: 12px 12px 6px 6px;
      background: linear-gradient(180deg, #86ccff, #2b78bc);
    }

    .spark-label {
      color: var(--muted);
      font-size: 10px;
      text-align: center;
    }

    .split-card {
      display: grid;
      gap: 16px;
    }

    .split-wrap {
      display: grid;
      gap: 10px;
    }

    .split-bar {
      height: 14px;
      border-radius: 999px;
      overflow: hidden;
      display: flex;
      background: rgba(255, 255, 255, 0.07);
    }

    .split-segment {
      height: 100%;
    }

    .split-segment:nth-child(1) { background: linear-gradient(90deg, #65b8ff, #8fd0ff); }
    .split-segment:nth-child(2) { background: linear-gradient(90deg, #5dd3a6, #93f0ca); }
    .split-segment:nth-child(3) { background: linear-gradient(90deg, #f0bc5a, #ffd98f); }

    .split-legend {
      display: grid;
      gap: 8px;
    }

    .legend-row,
    .model-row,
    .prompt-row,
    .alert-row {
      display: grid;
      gap: 8px;
    }

    .legend-row {
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
    }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--blue);
    }

    .legend-row:nth-child(2) .legend-dot { background: var(--green); }
    .legend-row:nth-child(3) .legend-dot { background: var(--amber); }

    .legend-label {
      min-width: 0;
      color: var(--muted-strong);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .legend-meta {
      color: var(--muted);
      white-space: nowrap;
    }

    .model-list {
      display: grid;
      gap: 10px;
    }

    .model-row {
      padding: 12px;
      border-radius: 16px;
      background: rgba(0, 0, 0, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }

    .model-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .model-name {
      font-weight: 700;
      min-width: 0;
    }

    .model-metrics {
      color: var(--muted);
      font-size: 12px;
    }

    .meter {
      margin-top: 10px;
      height: 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      overflow: hidden;
    }

    .meter-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--green), #9af1d0);
    }

    .coach-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .coach-item {
      padding: 16px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: grid;
      gap: 10px;
      border-left: 4px solid var(--blue);
    }

    .coach-item.success { border-left-color: var(--green); }
    .coach-item.warn { border-left-color: var(--amber); }
    .coach-item.danger { border-left-color: var(--red); }

    .coach-title {
      font-size: 15px;
      font-weight: 800;
      line-height: 1.25;
    }

    .coach-detail {
      color: var(--muted-strong);
    }

    .accordion-stack {
      display: grid;
      gap: 12px;
    }

    .accordion {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(15, 24, 36, 0.96), rgba(11, 18, 27, 0.98));
      overflow: hidden;
    }

    .accordion > summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .accordion > summary::-webkit-details-marker {
      display: none;
    }

    .accordion > summary::after {
      content: '+';
      color: var(--muted);
      font-size: 18px;
      line-height: 1;
    }

    .accordion[open] > summary::after {
      content: '-';
    }

    .accordion-body {
      padding: 0 18px 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .search {
      width: 100%;
      margin-top: 14px;
      padding: 11px 13px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      outline: none;
    }

    .search:focus,
    .field input:focus {
      border-color: rgba(101, 184, 255, 0.45);
      box-shadow: 0 0 0 1px rgba(101, 184, 255, 0.15);
    }

    .library-list,
    .budget-grid,
    .alert-list {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }

    .prompt-card,
    .budget-card,
    .alert-card {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .prompt-head,
    .budget-head,
    .alert-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 10px;
    }

    .prompt-title,
    .alert-title {
      font-weight: 800;
    }

    .prompt-meta,
    .alert-detail,
    .budget-note {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
    }

    .prompt-preview {
      margin-top: 10px;
      color: var(--muted-strong);
      background: rgba(0, 0, 0, 0.14);
      border-radius: 14px;
      padding: 11px 12px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 12px;
      line-height: 1.5;
    }

    .field-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-top: 14px;
    }

    .field {
      display: grid;
      gap: 6px;
    }

    .field label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .field input {
      width: 100%;
      padding: 11px 12px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      outline: none;
    }

    .button-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }

    .button,
    .ghost-button {
      border-radius: 999px;
      padding: 8px 12px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, opacity 120ms ease;
    }

    .button {
      background: var(--blue);
      color: #04101b;
      font-weight: 800;
    }

    .ghost-button {
      background: transparent;
      color: var(--muted-strong);
      border-color: rgba(255, 255, 255, 0.08);
    }

    .button:hover,
    .ghost-button:hover,
    .timeline-save:hover {
      transform: translateY(-1px);
      opacity: 0.95;
    }

    .empty {
      padding: 18px;
      border-radius: 18px;
      text-align: center;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.025);
      border: 1px dashed rgba(255, 255, 255, 0.1);
    }

    @media (max-width: 1120px) {
      .sticky-live {
        position: static;
      }

      .live-layout,
      .analytics-grid,
      .coach-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 760px) {
      .topbar {
        flex-direction: column;
        align-items: stretch;
      }

      .stats-grid,
      .mini-stats,
      .field-grid {
        grid-template-columns: 1fr;
      }

      .timeline-row {
        grid-template-columns: 1fr;
      }

      .timeline-meta {
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="topbar-copy">
        <div class="eyebrow">${title}</div>
        <div class="title" id="hero-title">Universal AI Token Analytics</div>
        <div class="subtitle" id="hero-subtitle">One calm view of active AI usage, spend, and waste.</div>
      </div>
      <div class="status-pill">
        <div id="status-dot" class="status-dot monitoring"></div>
        <div id="status-text" class="status-text">Stabilizing the active session...</div>
      </div>
    </header>

    <main>
      <section class="card sticky-live">
        <div class="card-head">
          <div class="card-kicker">Live Session</div>
          <div class="card-title">Current active chat</div>
          <div class="card-subtitle">Locked to the latest real user activity. No stale snap-backs.</div>
        </div>
        <div class="card-body" id="live-session"></div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-kicker">Efficiency Coach</div>
          <div class="card-title">Top 3 actions that matter</div>
          <div class="card-subtitle">Only the clearest things worth fixing right now.</div>
        </div>
        <div class="card-body" id="coach-panel"></div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-kicker">Aggregate Analytics</div>
          <div class="card-title">Usage at a glance</div>
          <div class="card-subtitle">Daily trend, source mix, and model efficiency in one pass.</div>
        </div>
        <div class="card-body" id="aggregate-analytics"></div>
      </section>

      <section class="accordion-stack">
        <details class="accordion">
          <summary>Prompt Library</summary>
          <div class="accordion-body" id="prompt-library"></div>
        </details>
        <details class="accordion">
          <summary>Budgets And Alerts</summary>
          <div class="accordion-body" id="budget-panel"></div>
        </details>
      </section>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const emptyAnalytics = {
      today: { tokens: 0, costUsd: 0, prompts: 0, sessions: 0 },
      week: { tokens: 0, costUsd: 0, prompts: 0, sessions: 0 },
      month: { tokens: 0, costUsd: 0, prompts: 0, sessions: 0 },
      byAgent: [],
      byModel: [],
      expensiveSessions: [],
      expensivePrompts: [],
      trend: [],
      coach: [],
    };

    let snapshot = {
      app: 'unknown',
      appLabel: 'VS Code',
      sources: [],
      analytics: emptyAnalytics,
      promptLibrary: [],
      budgets: {
        dailyCostUsd: null,
        monthlyCostUsd: null,
        dailyTokens: null,
        monthlyTokens: null,
      },
      alerts: [],
      generatedAt: Date.now(),
    };
    let libraryQuery = '';

    const heroTitle = document.getElementById('hero-title');
    const heroSubtitle = document.getElementById('hero-subtitle');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const liveSession = document.getElementById('live-session');
    const aggregateAnalytics = document.getElementById('aggregate-analytics');
    const coachPanel = document.getElementById('coach-panel');
    const promptLibraryPanel = document.getElementById('prompt-library');
    const budgetPanel = document.getElementById('budget-panel');

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function formatTokens(value) {
      return Math.round(value || 0).toLocaleString() + ' tokens';
    }

    function formatTokenFigure(value) {
      return Math.round(value || 0).toLocaleString() + ' tok';
    }

    function formatUsd(value) {
      return '$' + Number(value || 0).toFixed(2);
    }

    function formatPct(value) {
      return Math.round(value || 0) + '%';
    }

    function formatCompactLine(parts) {
      return parts.filter(Boolean).join(' · ');
    }

    function renderEmpty(message) {
      return '<div class="empty">' + escapeHtml(message) + '</div>';
    }

    function pill(label, tone) {
      return '<span class="pill ' + escapeHtml(tone || '') + '">' + escapeHtml(label) + '</span>';
    }

    function detailLabel(label, value, context) {
      return ''
        + '<div class="mini-stat">'
        + '  <div class="mini-stat-label">' + escapeHtml(label) + '</div>'
        + '  <div class="mini-stat-value">' + escapeHtml(value) + '</div>'
        + '  <div class="mini-stat-context">' + escapeHtml(context) + '</div>'
        + '</div>';
    }

    function summarizeText(value, limit) {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      if (!text) {
        return '';
      }
      return text.length <= limit ? text : text.slice(0, limit - 3).trimEnd() + '...';
    }

    function toneForContext(fill) {
      if ((fill || 0) >= 90) {
        return 'red';
      }
      if ((fill || 0) >= 72) {
        return 'amber';
      }
      return 'green';
    }

    function toneForHistory(ratio) {
      if ((ratio || 0) >= 0.5) {
        return 'red';
      }
      if ((ratio || 0) >= 0.3) {
        return 'amber';
      }
      return 'green';
    }

    function contextFillStyle(fill) {
      const tone = toneForContext(fill);
      const gradient = tone === 'red'
        ? 'linear-gradient(90deg, #ff7f81, #ffb1b2)'
        : tone === 'amber'
          ? 'linear-gradient(90deg, #f0bc5a, #ffd98f)'
          : 'linear-gradient(90deg, #65b8ff, #8fd0ff)';

      return 'width:' + clamp(fill, 0, 100) + '%;background:' + gradient + ';';
    }

    function renderTimeline(chat) {
      const turns = (chat.turns || []).slice().sort(function(left, right) {
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });

      if (turns.length === 0) {
        return renderEmpty('No turns captured yet for this chat.');
      }

      return turns.map(function(turn) {
        const metrics = turn.metrics || {
          inputTokens: 0,
          historyTokens: 0,
          thinkingTokens: 0,
          outputTokens: 0,
          inputCostUsd: 0,
          historyCostUsd: 0,
          thinkingCostUsd: 0,
          outputCostUsd: 0,
          costUsd: 0,
        };
        const userPreview = summarizeText(turn.blocks['user-input'].content, 92) || 'Prompt captured';
        const agentPreview = summarizeText(turn.blocks['agent-output'].content || turn.blocks['agent-thinking'].content, 92) || 'Waiting for response';
        const userMeta = formatCompactLine([
          metrics.inputTokens > 0 ? formatTokenFigure(metrics.inputTokens) + ' new' : 'Prompt captured',
          metrics.historyTokens > 0 ? formatTokenFigure(metrics.historyTokens) + ' history' : '',
          formatUsd((metrics.inputCostUsd || 0) + (metrics.historyCostUsd || 0)),
        ]);
        const agentMeta = formatCompactLine([
          metrics.outputTokens > 0 ? formatTokenFigure(metrics.outputTokens) + ' output' : 'Waiting',
          metrics.thinkingTokens > 0 ? formatTokenFigure(metrics.thinkingTokens) + ' thinking' : '',
          formatUsd((metrics.outputCostUsd || 0) + (metrics.thinkingCostUsd || 0)),
        ]);

        return ''
          + '<div class="exchange">'
          + '  <div class="timeline-row user">'
          + '    <div class="timeline-role">User</div>'
          + '    <div class="timeline-snippet">' + escapeHtml(userPreview) + '</div>'
          + '    <div class="timeline-meta">'
          +        escapeHtml(userMeta)
          + '    </div>'
          + '  </div>'
          + '  <div class="timeline-row agent">'
          + '    <div class="timeline-role">Agent</div>'
          + '    <div class="timeline-snippet">' + escapeHtml(agentPreview) + '</div>'
          + '    <div class="timeline-meta">'
          +        escapeHtml(agentMeta)
          + '    </div>'
          + '  </div>'
          + '  <button class="timeline-save" data-action="save-prompt" data-source-id="' + escapeHtml(chat.sourceId) + '" data-chat-id="' + escapeHtml(chat.id) + '" data-turn-id="' + escapeHtml(turn.id) + '">Save prompt</button>'
          + '</div>';
      }).join('');
    }

    function renderLiveSession() {
      const chat = snapshot.activeChat;
      if (!chat) {
        liveSession.innerHTML = renderEmpty('No active AI session detected yet.');
        return;
      }

      const metrics = chat.metrics || {
        totalTokens: 0,
        costUsd: 0,
        promptCount: 0,
        historyTokens: 0,
        outputTokens: 0,
        historyBloatRatio: 0,
      };
      const contextFill = chat.contextUsagePercent || 0;
      const heroContext = formatCompactLine([
        formatTokens(metrics.totalTokens),
        formatUsd(metrics.costUsd),
        formatPct(contextFill) + ' of context used',
      ]);
      const footerContext = formatCompactLine([
        formatTokens(metrics.totalTokens),
        formatUsd(metrics.costUsd),
        metrics.promptCount + ' prompts in session',
      ]);

      const healthScoreNum = metrics.healthScore ?? 100;
      const healthColor = healthScoreNum >= 80 ? 'green' : healthScoreNum >= 40 ? 'amber' : 'red';
      const warningBanner = healthScoreNum < 40
        ? '<div style="background: var(--red-soft); color: var(--red); padding: 12px; border-radius: 8px; margin-bottom: 16px; font-weight: 600;">⚠️ <strong>Start Fresh Recommendation:</strong> Context health is critically low (' + healthScoreNum + ' / 100). Continuing this chat is hurting reasoning and bloating cost. Start a new chat.</div>'
        : '';

      liveSession.innerHTML = ''
        + '<div class="live-layout">'
        + '  <div class="live-overview">'
        + warningBanner
        + '    <div>'
        + '      <div class="pill-row">'
        +          pill(chat.sourceLabel || 'Unknown agent', 'blue')
        +          pill(chat.model || 'Unknown model', 'green')
        +          pill(healthScoreNum + ' Health', healthColor)
        + '      </div>'
        + '      <div style="margin-top:14px;" class="live-title">' + escapeHtml((chat.sourceLabel || 'Agent') + ' · ' + (chat.model || 'Unknown model')) + '</div>'
        + '      <div class="live-subtitle" style="margin-top:8px;">' + escapeHtml(chat.title || 'Untitled chat') + '</div>'
        + '    </div>'
        + '    <div class="hero-metric">'
        + '      <div class="hero-value">' + escapeHtml(Math.round(metrics.totalTokens || 0).toLocaleString()) + '</div>'
        + '      <div class="hero-context">' + escapeHtml(heroContext) + '</div>'
        + '      <div class="context-progress"><div class="context-progress-fill" style="' + contextFillStyle(contextFill) + '"></div></div>'
        + '    </div>'
        + '    <div class="mini-stats">'
        +        detailLabel('Prompts', String(metrics.promptCount || 0), formatCompactLine([formatTokens(metrics.inputTokens || 0), formatUsd(metrics.costUsd)]))
        +        detailLabel('History Replay', formatPct((metrics.historyBloatRatio || 0) * 100), formatCompactLine([formatTokens(metrics.historyTokens || 0), toneForHistory(metrics.historyBloatRatio) === 'red' ? 'Actively wasteful' : toneForHistory(metrics.historyBloatRatio) === 'amber' ? 'Worth trimming' : 'Under control']))
        +        detailLabel('Output', formatTokens(metrics.outputTokens || 0), formatCompactLine([chat.contextWindowTokens ? '~' + Math.round(chat.contextWindowTokens).toLocaleString() + ' window' : '', snapshot.activeSuggestion ? '"' + snapshot.activeSuggestion.title + '" reusable' : 'No saved prompt match']))
        + '    </div>'
        + '  </div>'
        + '  <div class="live-timeline-wrap">'
        + '    <div class="timeline-head">'
        + '      <div class="timeline-title">Per-message timeline</div>'
        + '      <div class="timeline-subtitle">Compact rows for prompt cost, response cost, and thinking overhead.</div>'
        + '    </div>'
        + '    <div class="timeline-scroll">' + renderTimeline(chat) + '</div>'
        + '    <div class="timeline-footer">'
        + '      <div class="session-total">'
        + '        <span>Running session total</span>'
        + '        <strong>' + escapeHtml(footerContext) + '</strong>'
        + '      </div>'
        + '    </div>'
        + '  </div>'
        + '</div>';
    }

    function renderStatCard(label, bucket) {
      return ''
        + '<div class="stat-card">'
        + '  <div class="stat-label">' + escapeHtml(label) + '</div>'
        + '  <div class="stat-value">' + escapeHtml(formatUsd(bucket.costUsd)) + '</div>'
        + '  <div class="stat-secondary">' + escapeHtml(formatTokens(bucket.tokens)) + '</div>'
        + '  <div class="stat-context">' + escapeHtml(formatCompactLine([bucket.prompts + ' prompts', bucket.sessions + ' sessions'])) + '</div>'
        + '</div>';
    }

    function renderTrend(points) {
      if (!points || points.length === 0) {
        return renderEmpty('Daily spend trend will appear here as usage accumulates.');
      }

      const maxCost = Math.max.apply(null, points.map(function(point) {
        return point.costUsd || 0;
      }).concat([1]));

      return '<div class="sparkline">' + points.map(function(point) {
        const height = Math.max(8, Math.round(((point.costUsd || 0) / maxCost) * 126));
        return ''
          + '<div class="spark-bar" title="' + escapeHtml(formatCompactLine([point.label, formatUsd(point.costUsd), formatTokens(point.tokens)])) + '">'
          + '  <div class="spark-bar-fill" style="height:' + height + 'px;"></div>'
          + '  <div class="spark-label">' + escapeHtml(point.label) + '</div>'
          + '</div>';
      }).join('') + '</div>';
    }

    function renderAgentSplit(rows) {
      if (!rows || rows.length === 0) {
        return renderEmpty('Agent comparison will appear once more than one source is active.');
      }

      const segments = rows.slice(0, 3).map(function(row) {
        return '<div class="split-segment" style="width:' + clamp((row.costShare || 0) * 100, 0, 100) + '%;"></div>';
      }).join('');

      const legend = rows.slice(0, 3).map(function(row) {
        return ''
          + '<div class="legend-row">'
          + '  <div class="legend-dot"></div>'
          + '  <div class="legend-label">' + escapeHtml(row.label) + '</div>'
          + '  <div class="legend-meta">' + escapeHtml(formatPct((row.costShare || 0) * 100) + ' · ' + formatUsd(row.costUsd)) + '</div>'
          + '</div>';
      }).join('');

      return ''
        + '<div class="split-wrap">'
        + '  <div class="split-bar">' + segments + '</div>'
        + '  <div class="split-legend">' + legend + '</div>'
        + '</div>';
    }

    function renderModelBreakdown(rows) {
      if (!rows || rows.length === 0) {
        return renderEmpty('Model efficiency will appear once model-tagged usage is captured.');
      }

      return '<div class="model-list">' + rows.slice(0, 5).map(function(row) {
        return ''
          + '<div class="model-row">'
          + '  <div class="model-head">'
          + '    <div class="model-name">' + escapeHtml(row.label) + '</div>'
          + '    <div class="pill green">Score ' + escapeHtml(String(row.efficiencyScore || 0)) + '</div>'
          + '  </div>'
          + '  <div class="model-metrics">' + escapeHtml(formatCompactLine([formatUsd(row.costPer1kTokens) + ' / 1k tokens', formatPct((row.costShare || 0) * 100) + ' of spend', Math.round(row.outputPerDollar || 0).toLocaleString() + ' output / $'])) + '</div>'
          + '  <div class="meter"><div class="meter-fill" style="width:' + clamp(row.efficiencyScore || 0, 0, 100) + '%;"></div></div>'
          + '</div>';
      }).join('') + '</div>';
    }

    function renderAggregateAnalytics() {
      const analytics = snapshot.analytics || emptyAnalytics;
      aggregateAnalytics.innerHTML = ''
        + '<div class="stats-grid">'
        + renderStatCard('Today', analytics.today || emptyAnalytics.today)
        + renderStatCard('This Week', analytics.week || emptyAnalytics.week)
        + renderStatCard('This Month', analytics.month || emptyAnalytics.month)
        + '</div>'
        + '<div class="analytics-grid">'
        + '  <div class="subcard">'
        + '    <div class="subcard-title">Daily spend trend</div>'
        + '    <div class="subcard-note">Estimated cost per day across every tracked source.</div>'
        +        renderTrend(analytics.trend || [])
        + '  </div>'
        + '  <div class="split-card subcard">'
        + '    <div>'
        + '      <div class="subcard-title">Agent mix</div>'
        + '      <div class="subcard-note">Who is taking the budget right now.</div>'
        +        renderAgentSplit(analytics.byAgent || [])
        + '    </div>'
        + '    <div>'
        + '      <div class="subcard-title">Model efficiency</div>'
        + '      <div class="subcard-note">Cost per token and output-per-dollar score.</div>'
        +        renderModelBreakdown(analytics.byModel || [])
        + '    </div>'
        + '  </div>'
        + '</div>';
    }

    function renderCoachPanel() {
      if (!snapshot.hasGroqKey) {
        coachPanel.innerHTML = ''
          + '<div style="background: linear-gradient(145deg, rgba(23, 31, 44, 0.96), rgba(12, 19, 28, 0.98)); border: 1px solid var(--amber-soft); padding: 24px; border-radius: var(--radius); text-align: center;">'
          + '  <div style="font-size: 18px; font-weight: 700; margin-bottom: 8px; color: var(--amber);">Unlock the LLaMA 3 AI Coach</div>'
          + '  <div style="color: var(--muted-strong); margin-bottom: 16px; max-width: 600px; margin-left: auto; margin-right: auto;">Supply a free Groq API key to unlock real-time prompt analysis. The dashboard will run LLaMA 3 70B implicitly to detect error loops, highlight dead context, and provide actionable engineering advice without slowing down Cursor.</div>'
          + '  <div style="color: var(--muted); margin-bottom: 8px; font-size: 12px;"><strong>To enable:</strong> Open Settings (Cmd+,), search for <em>aiAgentMonitor.groqApiKey</em>, and paste your free key from <a href="https://console.groq.com/keys" style="color: var(--blue); text-decoration: none;">console.groq.com</a>. Reload the window after saving.</div>'
          + '</div>';
        return;
      }

      const insights = (snapshot.analytics && snapshot.analytics.coach) || [];
      if (insights.length === 0) {
        coachPanel.innerHTML = renderEmpty('Coach insights will appear once the dashboard has enough activity to compare.');
        return;
      }

      coachPanel.innerHTML = '<div class="coach-grid">' + insights.slice(0, 3).map(function(insight) {
        return ''
          + '<div class="coach-item ' + escapeHtml(insight.level) + '">'
          + '  <div class="pill-row">' + pill(insight.level === 'danger' ? 'Actively wasteful' : insight.level === 'warn' ? 'Worth fixing' : 'Fine', insight.level === 'danger' ? 'red' : insight.level === 'warn' ? 'amber' : 'green') + '</div>'
          + '  <div class="coach-title">' + escapeHtml(insight.title) + '</div>'
          + '  <div class="coach-detail">' + escapeHtml(insight.detail) + '</div>'
          + '</div>';
      }).join('') + '</div>';
    }

    function renderPromptLibrary() {
      const prompts = (snapshot.promptLibrary || []).filter(function(prompt) {
        if (!libraryQuery) {
          return true;
        }
        const haystack = [prompt.title, prompt.content].concat(prompt.tags || []).join(' ').toLowerCase();
        return haystack.includes(libraryQuery);
      });

      const list = prompts.length === 0
        ? renderEmpty(libraryQuery ? 'No saved prompts match this search.' : 'Save a strong prompt from the live session and it will show up here.')
        : '<div class="library-list">' + prompts.map(function(prompt) {
            return ''
              + '<div class="prompt-card">'
              + '  <div class="prompt-head">'
              + '    <div>'
              + '      <div class="prompt-title">' + escapeHtml(prompt.title) + '</div>'
              + '      <div class="prompt-meta">' + escapeHtml(formatCompactLine([prompt.model || prompt.sourceLabel || 'Saved prompt', 'Used ' + (prompt.useCount || 0) + ' times'])) + '</div>'
              + '    </div>'
              + '    <div class="inline-tags">' + (prompt.tags || []).map(function(tag) {
                  return '<span class="tag">' + escapeHtml(tag) + '</span>';
                }).join('') + '</div>'
              + '  </div>'
              + '  <div class="prompt-preview">' + escapeHtml(prompt.content.length > 220 ? prompt.content.slice(0, 217).trimEnd() + '...' : prompt.content) + '</div>'
              + '  <div class="button-row">'
              + '    <button class="button" data-action="copy-prompt" data-prompt-id="' + escapeHtml(prompt.id) + '">Copy</button>'
              + '    <button class="ghost-button" data-action="delete-prompt" data-prompt-id="' + escapeHtml(prompt.id) + '">Delete</button>'
              + '  </div>'
              + '</div>';
          }).join('') + '</div>';

      promptLibraryPanel.innerHTML = ''
        + '<input id="library-search" class="search" type="search" placeholder="Search saved prompts or tags..." value="' + escapeHtml(libraryQuery) + '">'
        + list;
    }

    function renderBudgetPanel() {
      const alerts = snapshot.alerts || [];
      const alertList = alerts.length === 0
        ? renderEmpty('No active alerts yet. Set a token or cost budget to start tracking runway.')
        : '<div class="alert-list">' + alerts.map(function(alert) {
            return ''
              + '<div class="alert-card">'
              + '  <div class="alert-head">'
              + '    <div>'
              + '      <div class="alert-title">' + escapeHtml(alert.title) + '</div>'
              + '      <div class="alert-detail">' + escapeHtml(alert.detail) + '</div>'
              + '    </div>'
              + '    <div>' + pill(formatPct((alert.progress || 0) * 100), alert.level === 'critical' ? 'red' : alert.level === 'warn' ? 'amber' : 'green') + '</div>'
              + '  </div>'
              + '</div>';
          }).join('') + '</div>';

      budgetPanel.innerHTML = ''
        + '<div class="budget-note">Secondary controls stay tucked away here so the main dashboard can stay calm.</div>'
        + '<div class="field-grid">'
        + '  <div class="field"><label for="daily-cost-budget">Daily cost budget (USD)</label><input id="daily-cost-budget" type="number" min="0" step="0.01" value="' + escapeHtml(snapshot.budgets.dailyCostUsd ?? '') + '"></div>'
        + '  <div class="field"><label for="monthly-cost-budget">Monthly cost budget (USD)</label><input id="monthly-cost-budget" type="number" min="0" step="0.01" value="' + escapeHtml(snapshot.budgets.monthlyCostUsd ?? '') + '"></div>'
        + '  <div class="field"><label for="daily-token-budget">Daily token budget</label><input id="daily-token-budget" type="number" min="0" step="1" value="' + escapeHtml(snapshot.budgets.dailyTokens ?? '') + '"></div>'
        + '  <div class="field"><label for="monthly-token-budget">Monthly token budget</label><input id="monthly-token-budget" type="number" min="0" step="1" value="' + escapeHtml(snapshot.budgets.monthlyTokens ?? '') + '"></div>'
        + '</div>'
        + '<div class="button-row">'
        + '  <button class="button" data-action="save-budgets">Save budgets</button>'
        + '</div>'
        + alertList;
    }

    function applySnapshot(nextSnapshot) {
      snapshot = nextSnapshot || {
        app: 'unknown',
        appLabel: 'VS Code',
        sources: [],
        analytics: emptyAnalytics,
        promptLibrary: [],
        budgets: {
          dailyCostUsd: null,
          monthlyCostUsd: null,
          dailyTokens: null,
          monthlyTokens: null,
        },
        alerts: [],
        generatedAt: Date.now(),
      };

      heroTitle.textContent = (snapshot.appLabel || 'VS Code') + ' AI Token Analytics';
      heroSubtitle.textContent = 'Tracking ' + (((snapshot.sources || []).length) || 0) + ' active source' + ((((snapshot.sources || []).length) || 0) === 1 ? '' : 's') + ' in one paid-product style dashboard.';
      render();
    }

    function updateStatus(status, text) {
      statusDot.className = 'status-dot ' + (status || 'monitoring');
      statusText.textContent = text || 'Monitoring AI usage...';
    }

    function render() {
      renderLiveSession();
      renderAggregateAnalytics();
      renderCoachPanel();
      renderPromptLibrary();
      renderBudgetPanel();
    }

    document.addEventListener('click', function(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const action = target.dataset.action;
      if (!action) {
        return;
      }

      if (action === 'save-prompt') {
        vscode.postMessage({
          command: 'savePrompt',
          sourceId: target.dataset.sourceId,
          chatId: target.dataset.chatId,
          turnId: target.dataset.turnId,
        });
        return;
      }

      if (action === 'copy-prompt') {
        vscode.postMessage({
          command: 'copyPrompt',
          promptId: target.dataset.promptId,
        });
        return;
      }

      if (action === 'delete-prompt') {
        vscode.postMessage({
          command: 'deletePrompt',
          promptId: target.dataset.promptId,
        });
        return;
      }

      if (action === 'save-budgets') {
        const parseField = function(id) {
          const element = document.getElementById(id);
          if (!(element instanceof HTMLInputElement)) {
            return null;
          }

          if (!element.value) {
            return null;
          }

          const parsed = Number(element.value);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        };

        vscode.postMessage({
          command: 'updateBudgets',
          budgets: {
            dailyCostUsd: parseField('daily-cost-budget'),
            monthlyCostUsd: parseField('monthly-cost-budget'),
            dailyTokens: parseField('daily-token-budget'),
            monthlyTokens: parseField('monthly-token-budget'),
          },
        });
      }
    });

    document.addEventListener('input', function(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.id === 'library-search' && target instanceof HTMLInputElement) {
        libraryQuery = target.value.trim().toLowerCase();
        renderPromptLibrary();
      }
    });

    window.addEventListener('message', function(event) {
      const message = event.data;
      switch (message.command) {
        case 'sync':
          applySnapshot(message.snapshot);
          break;
        case 'clear':
          applySnapshot({
            app: snapshot.app,
            appLabel: snapshot.appLabel,
            sources: [],
            analytics: emptyAnalytics,
            promptLibrary: snapshot.promptLibrary,
            budgets: snapshot.budgets,
            alerts: [],
            generatedAt: Date.now(),
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
