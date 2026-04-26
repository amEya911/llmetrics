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
      --bg: #08121c;
      --bg-soft: #0c1927;
      --card: rgba(15, 27, 40, 0.94);
      --card-strong: rgba(10, 18, 28, 0.98);
      --line: rgba(138, 177, 222, 0.15);
      --line-strong: rgba(138, 177, 222, 0.24);
      --text: #eef5ff;
      --muted: #8ea2ba;
      --muted-strong: #bcc9d9;
      --blue: #70baff;
      --blue-soft: rgba(112, 186, 255, 0.16);
      --green: #63d9ac;
      --green-soft: rgba(99, 217, 172, 0.16);
      --amber: #f3c46e;
      --amber-soft: rgba(243, 196, 110, 0.16);
      --red: #ff8f93;
      --red-soft: rgba(255, 143, 147, 0.17);
      --shadow: 0 28px 76px rgba(0, 0, 0, 0.34);
      --radius: 24px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--text);
      font-family: "Aptos", "SF Pro Display", "Segoe UI Variable", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      background:
        radial-gradient(circle at top left, rgba(112, 186, 255, 0.14), transparent 28%),
        radial-gradient(circle at top right, rgba(99, 217, 172, 0.1), transparent 24%),
        linear-gradient(180deg, #08121c 0%, #050b12 100%);
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
      justify-content: space-between;
      align-items: end;
      gap: 16px;
      padding: 18px 20px;
      backdrop-filter: blur(18px);
      background: rgba(7, 12, 18, 0.84);
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .eyebrow {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .title {
      margin-top: 6px;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.05em;
    }

    .subtitle {
      margin-top: 6px;
      color: var(--muted);
      max-width: 62ch;
    }

    .status-pill,
    .chip,
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid transparent;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .status-pill {
      background: rgba(255, 255, 255, 0.04);
      border-color: var(--line);
      color: var(--muted-strong);
      white-space: nowrap;
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--green);
    }

    .status-dot.monitoring { background: var(--amber); }
    .status-dot.disconnected { background: var(--red); }

    main {
      display: grid;
      gap: 18px;
      padding: 18px 20px 30px;
    }

    .tier {
      display: grid;
      gap: 18px;
    }

    .above-fold {
      grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr);
      align-items: start;
    }

    .card,
    .accordion {
      border-radius: var(--radius);
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(15, 27, 40, 0.96), rgba(9, 17, 27, 0.98));
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .card-head,
    .accordion > summary {
      padding: 18px 20px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .card-title {
      margin-top: 6px;
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }

    .card-subtitle {
      margin-top: 6px;
      color: var(--muted);
    }

    .card-body {
      padding: 18px 20px 20px;
    }

    .live-grid,
    .summary-grid,
    .pattern-grid,
    .model-list,
    .timeline-list,
    .library-list,
    .alert-list,
    .accordion-stack {
      display: grid;
      gap: 12px;
    }

    .live-grid {
      grid-template-columns: minmax(0, 1.05fr) minmax(220px, 0.95fr);
      gap: 18px;
      align-items: stretch;
    }

    .segment-breakdown {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }

    .segment-bar {
      display: flex;
      overflow: hidden;
      height: 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .segment {
      min-width: 6px;
      height: 100%;
    }

    .segment.input { background: var(--blue); }
    .segment.thinking { background: var(--green); }
    .segment.subagent { background: var(--amber); }
    .segment.editor { background: var(--red); }
    .segment.output { background: #9ad6ff; }

    .segment-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .segment-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      color: var(--muted-strong);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .segment-pill::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: currentColor;
    }

    .segment-pill.input { color: var(--blue); }
    .segment-pill.thinking { color: var(--green); }
    .segment-pill.subagent { color: var(--amber); }
    .segment-pill.editor { color: var(--red); }
    .segment-pill.output { color: #9ad6ff; }

    .live-title {
      margin-top: 12px;
      font-size: 30px;
      line-height: 1.02;
      font-weight: 800;
      letter-spacing: -0.06em;
    }

    .live-subtitle {
      margin-top: 8px;
      color: var(--muted);
    }

    .chip,
    .badge {
      background: rgba(255, 255, 255, 0.05);
      color: var(--muted-strong);
    }

    .chip.blue,
    .badge.blue { background: var(--blue-soft); color: #d9eeff; }
    .chip.green,
    .badge.green { background: var(--green-soft); color: #dafef0; }
    .chip.amber,
    .badge.amber { background: var(--amber-soft); color: #ffebc5; }
    .chip.red,
    .badge.red { background: var(--red-soft); color: #ffd7d8; }

    .metric-hero,
    .insight-panel,
    .summary-card,
    .mini-card,
    .timeline-item,
    .model-row,
    .prompt-card,
    .budget-card,
    .alert-card,
    .pattern-card {
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      background: rgba(255, 255, 255, 0.03);
    }

    .metric-hero,
    .insight-panel,
    .summary-card,
    .mini-card,
    .model-row,
    .prompt-card,
    .budget-card,
    .alert-card,
    .pattern-card {
      padding: 16px;
    }

    .hero-value {
      margin-top: 8px;
      font-size: 38px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: -0.06em;
    }

    .hero-context,
    .support-copy,
    .detail-copy,
    .mini-copy {
      margin-top: 8px;
      color: var(--muted-strong);
    }

    .progress {
      margin-top: 14px;
      height: 12px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.07);
    }

    .progress-fill {
      height: 100%;
      border-radius: inherit;
    }

    .mini-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      margin-top: 14px;
    }

    .mini-label,
    .section-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .mini-value {
      margin-top: 6px;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }

    .button-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 14px;
    }

    .button,
    .ghost-button,
    .timeline-button {
      border-radius: 999px;
      padding: 9px 14px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease, border-color 120ms ease;
    }

    .button {
      background: var(--blue);
      color: #06111b;
      font-weight: 800;
    }

    .button[disabled] {
      cursor: default;
      opacity: 0.5;
    }

    .ghost-button,
    .timeline-button {
      background: transparent;
      color: var(--muted-strong);
      border-color: rgba(255, 255, 255, 0.08);
    }

    .button:hover:not([disabled]),
    .ghost-button:hover,
    .timeline-button:hover {
      transform: translateY(-1px);
      opacity: 0.95;
    }

    .coach-shell {
      display: grid;
      gap: 12px;
    }

    .insight-panel {
      min-height: 100%;
      display: grid;
      gap: 12px;
      border-left: 4px solid var(--blue);
    }

    .insight-panel.info { border-left-color: var(--blue); }
    .insight-panel.warn { border-left-color: var(--amber); }
    .insight-panel.danger { border-left-color: var(--red); }

    .insight-title {
      font-size: 22px;
      line-height: 1.15;
      font-weight: 800;
      letter-spacing: -0.04em;
    }

    .summary-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .summary-value {
      margin-top: 8px;
      font-size: 30px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: -0.05em;
    }

    .trend-chart {
      min-height: 180px;
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(auto-fit, minmax(16px, 1fr));
      align-items: end;
      margin-top: 16px;
    }

    .trend-bar {
      display: grid;
      gap: 8px;
      justify-items: stretch;
      align-items: end;
    }

    .trend-bar-fill {
      width: 100%;
      min-height: 8px;
      border-radius: 12px 12px 6px 6px;
      background: linear-gradient(180deg, #8fd0ff, #2a77bc);
    }

    .trend-label {
      color: var(--muted);
      font-size: 10px;
      text-align: center;
    }

    .timeline-item {
      display: grid;
      gap: 10px;
    }

    .timeline-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 12px;
      border-radius: 14px;
      background: rgba(0, 0, 0, 0.16);
    }

    .timeline-row.user { border-left: 3px solid var(--blue); }
    .timeline-row.agent { border-left: 3px solid var(--green); }

    .timeline-role {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .timeline-snippet {
      min-width: 0;
      color: var(--muted-strong);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .timeline-meta {
      text-align: right;
      white-space: nowrap;
      font-weight: 700;
    }

    .timeline-meta-sub {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
    }

    .accordion-stack {
      gap: 12px;
    }

    .accordion > summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
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
      padding: 18px 20px 20px;
    }

    .field-grid {
      display: grid;
      gap: 12px;
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

    .field input,
    .search {
      width: 100%;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      outline: none;
      padding: 11px 12px;
    }

    .field input:focus,
    .search:focus {
      border-color: rgba(112, 186, 255, 0.46);
      box-shadow: 0 0 0 1px rgba(112, 186, 255, 0.12);
    }

    .model-row,
    .pattern-card {
      display: grid;
      gap: 10px;
    }

    .row-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 10px;
    }

    .row-title {
      font-weight: 800;
    }

    .meter {
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.07);
    }

    .meter-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--green), #9af1d0);
    }

    .tag-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--muted-strong);
      font-size: 11px;
      font-weight: 700;
    }

    .search {
      margin-bottom: 14px;
    }

    .prompt-preview {
      padding: 12px;
      border-radius: 14px;
      background: rgba(0, 0, 0, 0.16);
      color: var(--muted-strong);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
      font-size: 12px;
      line-height: 1.52;
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
      .above-fold,
      .live-grid,
      .summary-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 760px) {
      .topbar {
        flex-direction: column;
        align-items: stretch;
      }

      .mini-grid,
      .field-grid,
      .summary-grid {
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
      <div>
        <div class="eyebrow">${title}</div>
        <div class="title" id="hero-title">AI Token Analytics</div>
        <div class="subtitle" id="hero-subtitle">Real-time session quality, spend, and context waste in one view.</div>
      </div>
      <div class="status-pill">
        <div id="status-dot" class="status-dot monitoring"></div>
        <div id="status-text">Stabilizing live usage capture...</div>
      </div>
    </header>

    <main>
      <section class="tier above-fold">
        <article class="card">
          <div class="card-head">
            <div class="eyebrow">Live Session</div>
            <div class="card-title">Current active chat</div>
            <div class="card-subtitle">Always pinned to the session that is actually consuming tokens right now.</div>
          </div>
          <div class="card-body" id="live-session"></div>
        </article>

        <article class="card">
          <div class="card-head">
            <div class="eyebrow">Groq AI Coach</div>
            <div class="card-title">Most urgent active insight</div>
            <div class="card-subtitle">One recommendation at a time, prioritized by wasted spend and context risk.</div>
          </div>
          <div class="card-body" id="coach-panel"></div>
        </article>
      </section>

      <section class="tier">
        <article class="card">
          <div class="card-head">
            <div class="eyebrow">Per-Message Timeline</div>
            <div class="card-title">Prompt-by-prompt cost flow</div>
            <div class="card-subtitle">Each exchange separated so you can see what the current session is actually paying for.</div>
          </div>
          <div class="card-body" id="timeline-panel"></div>
        </article>

        <article class="card">
          <div class="card-head">
            <div class="eyebrow">Spend Summary</div>
            <div class="card-title">Daily, weekly, and monthly spend</div>
            <div class="card-subtitle">Visible below the fold, but still first-class.</div>
          </div>
          <div class="card-body" id="summary-panel"></div>
        </article>

        <article class="card">
          <div class="card-head">
            <div class="eyebrow">Spend Trend</div>
            <div class="card-title">Daily spend trend</div>
            <div class="card-subtitle">Estimated cost per day across all tracked sessions.</div>
          </div>
          <div class="card-body" id="trend-panel"></div>
        </article>
      </section>

      <section class="accordion-stack">
        <details class="accordion">
          <summary>Model Efficiency Score</summary>
          <div class="accordion-body" id="model-panel"></div>
        </details>
        <details class="accordion">
          <summary>Agent Mix Breakdown</summary>
          <div class="accordion-body" id="agent-panel"></div>
        </details>
        <details class="accordion">
          <summary>Your Patterns</summary>
          <div class="accordion-body" id="patterns-panel"></div>
        </details>
        <details class="accordion">
          <summary>Budget Settings</summary>
          <div class="accordion-body" id="budget-panel"></div>
        </details>
        <details class="accordion">
          <summary>Prompt Library</summary>
          <div class="accordion-body" id="prompt-library"></div>
        </details>
      </section>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const emptyPatterns = {
      summaries: [],
      averageHealthTrend: [],
      expensivePromptPatterns: [],
      timeOfDay: [],
    };

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
      patterns: emptyPatterns,
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
      hasGroqKey: false,
      sessionAnalysis: {
        isGenerating: false,
      },
      generatedAt: Date.now(),
    };

    let libraryQuery = '';

    const heroTitle = document.getElementById('hero-title');
    const heroSubtitle = document.getElementById('hero-subtitle');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const liveSession = document.getElementById('live-session');
    const coachPanel = document.getElementById('coach-panel');
    const timelinePanel = document.getElementById('timeline-panel');
    const summaryPanel = document.getElementById('summary-panel');
    const trendPanel = document.getElementById('trend-panel');
    const modelPanel = document.getElementById('model-panel');
    const agentPanel = document.getElementById('agent-panel');
    const patternsPanel = document.getElementById('patterns-panel');
    const budgetPanel = document.getElementById('budget-panel');
    const promptLibraryPanel = document.getElementById('prompt-library');

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

    function renderEmpty(message) {
      return '<div class="empty">' + escapeHtml(message) + '</div>';
    }

    function summarizeText(value, limit) {
      const text = String(value || '').replace(/\\s+/g, ' ').trim();
      if (!text) {
        return '';
      }

      return text.length <= limit ? text : text.slice(0, limit - 3).trimEnd() + '...';
    }

    function formatTokens(value) {
      return Math.round(value || 0).toLocaleString() + ' tokens';
    }

    function formatTokenCompact(value) {
      return Math.round(value || 0).toLocaleString() + ' tok';
    }

    function formatUsd(value) {
      return '$' + Number(value || 0).toFixed(2);
    }

    function formatPct(value) {
      return Math.round(value || 0) + '%';
    }

    function compact(parts) {
      return parts.filter(Boolean).join(' · ');
    }

    function tokenSegments(metrics) {
      return [
        { key: 'input', label: 'Input', value: Math.round((metrics && metrics.inputTokens) || 0), tone: 'input' },
        { key: 'thinking', label: 'Thinking', value: Math.round((metrics && metrics.thinkingTokens) || 0), tone: 'thinking' },
        { key: 'subagent', label: 'Sub-agent', value: Math.round((metrics && metrics.subagentTokens) || 0), tone: 'subagent' },
        { key: 'editor', label: 'Editor', value: Math.round((metrics && metrics.editorTokens) || 0), tone: 'editor' },
        { key: 'output', label: 'Output', value: Math.round((metrics && metrics.outputTokens) || 0), tone: 'output' },
      ].filter(function(segment) {
        return segment.value > 0;
      });
    }

    function renderTokenBreakdown(metrics) {
      const segments = tokenSegments(metrics);
      if (!segments.length) {
        return '';
      }

      const total = segments.reduce(function(sum, segment) {
        return sum + segment.value;
      }, 0) || 1;

      return ''
        + '<div class="segment-breakdown">'
        + '  <div class="segment-bar">'
        +      segments.map(function(segment) {
                 return '<div class="segment ' + escapeHtml(segment.tone) + '" style="width:' + ((segment.value / total) * 100).toFixed(2) + '%;"></div>';
               }).join('')
        + '  </div>'
        + '  <div class="segment-legend">'
        +      segments.map(function(segment) {
                 return '<span class="segment-pill ' + escapeHtml(segment.tone) + '">' + escapeHtml(segment.label + ' ' + formatTokenCompact(segment.value)) + '</span>';
               }).join('')
        + '  </div>'
        + '</div>';
    }

    function toneForScore(score) {
      if ((score || 0) >= 85) {
        return 'green';
      }
      if ((score || 0) >= 65) {
        return 'blue';
      }
      if ((score || 0) >= 45) {
        return 'amber';
      }
      return 'red';
    }

    function toneForContext(fill) {
      if ((fill || 0) >= 92) {
        return 'red';
      }
      if ((fill || 0) >= 76) {
        return 'amber';
      }
      return 'green';
    }

    function progressStyle(fill) {
      const tone = toneForContext(fill);
      const gradient = tone === 'red'
        ? 'linear-gradient(90deg, #ff8f93, #ffc0c3)'
        : tone === 'amber'
          ? 'linear-gradient(90deg, #f3c46e, #ffe09f)'
          : 'linear-gradient(90deg, #70baff, #9ad6ff)';

      return 'width:' + clamp(fill, 0, 100) + '%;background:' + gradient + ';';
    }

    function chip(label, tone) {
      return '<span class="chip ' + escapeHtml(tone || '') + '">' + escapeHtml(label) + '</span>';
    }

    function badgeLabel(level) {
      return level === 'danger' ? 'Critical' : level === 'warn' ? 'Warning' : 'Info';
    }

    function renderMini(label, value, copy) {
      return ''
        + '<div class="mini-card">'
        + '  <div class="mini-label">' + escapeHtml(label) + '</div>'
        + '  <div class="mini-value">' + escapeHtml(value) + '</div>'
        + '  <div class="mini-copy">' + escapeHtml(copy) + '</div>'
        + '</div>';
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
        inputTokens: 0,
        thinkingTokens: 0,
        subagentTokens: 0,
        editorTokens: 0,
        outputTokens: 0,
        historyTokens: 0,
        historyBloatRatio: 0,
        healthScore: 100,
      };
      const contextHealth = chat.contextHealth || {
        deadReferences: [],
        deadWeightTokensPerTurn: 0,
      };
      const healthScore = metrics.healthScore ?? 100;
      const isGenerating = Boolean(snapshot.sessionAnalysis && snapshot.sessionAnalysis.isGenerating && snapshot.sessionAnalysis.activeChatId === chat.id);
      const disabled = !snapshot.hasGroqKey || isGenerating;
      const startFresh = healthScore <= 40;
      const analysisButtonLabel = isGenerating ? 'Generating Analysis...' : 'Full Session Analysis';
      const analysisNote = !snapshot.hasGroqKey
        ? 'Set aiAgentMonitor.groqApiKey in Settings to unlock the browser report.'
        : snapshot.sessionAnalysis && snapshot.sessionAnalysis.lastError
          ? snapshot.sessionAnalysis.lastError
          : 'Streams a premium HTML report to your browser.';

      liveSession.innerHTML = ''
        + (startFresh
          ? '<div class="alert-card" style="margin-bottom:16px;border-left:4px solid var(--red);background:var(--red-soft);">'
            + '<div class="row-title">Start Fresh Recommended</div>'
            + '<div class="detail-copy">Context health is down to ' + escapeHtml(String(healthScore)) + ' / 100. Continuing this chat is likely dragging old tokens and lowering reasoning quality.</div>'
            + '</div>'
          : '')
        + '<div class="live-grid">'
        + '  <div>'
        + '    <div class="tag-row">'
        +        chip(chat.sourceLabel || 'Unknown source', 'blue')
        +        chip(chat.model || 'Unknown model', 'green')
        +        chip('Health ' + healthScore, toneForScore(healthScore))
        + '    </div>'
        + '    <div class="live-title">' + escapeHtml(chat.title || 'Untitled chat') + '</div>'
        + '    <div class="live-subtitle">' + escapeHtml(compact([
               formatUsd(metrics.costUsd),
               formatTokens(metrics.totalTokens),
               (chat.contextUsagePercent || 0) > 0 ? formatPct(chat.contextUsagePercent) + ' context used' : '',
             ])) + '</div>'
        + '    <div class="button-row">'
        + '      <button class="button" data-action="generate-session-analysis" ' + (disabled ? 'disabled' : '') + '>' + escapeHtml(analysisButtonLabel) + '</button>'
        + '    </div>'
        + '    <div class="support-copy">' + escapeHtml(analysisNote) + '</div>'
        + '  </div>'
        + '  <div class="metric-hero">'
        + '    <div class="mini-label">Live token burn</div>'
        + '    <div class="hero-value">' + escapeHtml(Math.round(metrics.totalTokens || 0).toLocaleString()) + '</div>'
        + '    <div class="hero-context">' + escapeHtml(compact([
               formatUsd(metrics.costUsd || 0),
               formatTokens(metrics.historyTokens || 0) + ' replayed',
             ])) + '</div>'
        +      renderTokenBreakdown(metrics)
        + '    <div class="progress"><div class="progress-fill" style="' + progressStyle(chat.contextUsagePercent || 0) + '"></div></div>'
        + '    <div class="mini-grid">'
        +        renderMini('Input', formatTokenCompact(metrics.inputTokens || 0), 'user prompt')
        +        renderMini('Thinking', formatTokenCompact(metrics.thinkingTokens || 0), 'model reasoning')
        +        renderMini('Sub-agents', formatTokenCompact(metrics.subagentTokens || 0), 'background tasks')
        +        renderMini('Editor', formatTokenCompact(metrics.editorTokens || 0), 'diff and apply')
        +        renderMini('Output', formatTokenCompact(metrics.outputTokens || 0), 'final reply')
        + '    </div>'
        + '    <div class="support-copy">' + escapeHtml(compact([
               String(metrics.promptCount || 0) + ' prompts',
               formatPct((metrics.historyBloatRatio || 0) * 100) + ' replay',
               contextHealth.deadReferences.length
                 ? formatTokens(contextHealth.deadWeightTokensPerTurn || 0) + ' dead context / turn'
                 : 'No unused @ mentions detected',
             ])) + '</div>'
        + '  </div>'
        + '</div>';
    }

    function renderCoachPanel() {
      const insight = snapshot.analytics && snapshot.analytics.primaryCoachInsight;

      if (!insight) {
        coachPanel.innerHTML = ''
          + '<div class="coach-shell">'
          + '  <div class="insight-panel info">'
          + '    <div class="badge blue">Info</div>'
          + '    <div class="insight-title">Session looks healthy</div>'
          + '    <div class="detail-copy">No urgent context, spend, or model-fit problems are active right now.</div>'
          + (!snapshot.hasGroqKey
            ? '<div class="support-copy">Add a Groq API key to unlock deeper narrative coaching and the full browser analysis report.</div>'
            : '')
          + '  </div>'
          + '</div>';
        return;
      }

      coachPanel.innerHTML = ''
        + '<div class="coach-shell">'
        + '  <div class="insight-panel ' + escapeHtml(insight.level) + '">'
        + '    <div class="badge ' + escapeHtml(insight.level === 'danger' ? 'red' : insight.level === 'warn' ? 'amber' : 'blue') + '">' + escapeHtml(badgeLabel(insight.level)) + '</div>'
        + '    <div class="insight-title">' + escapeHtml(insight.title) + '</div>'
        + '    <div class="detail-copy">' + escapeHtml(insight.detail) + '</div>'
        + '  </div>'
        + '</div>';
    }

    function renderTimelinePanel() {
      const chat = snapshot.activeChat;
      if (!chat || !chat.turns || chat.turns.length === 0) {
        timelinePanel.innerHTML = renderEmpty('A turn-by-turn timeline will appear once prompts start flowing.');
        return;
      }

      const turns = chat.turns.slice().sort(function(left, right) {
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });

      timelinePanel.innerHTML = '<div class="timeline-list">' + turns.map(function(turn) {
        const metrics = turn.metrics || {
          inputTokens: 0,
          historyTokens: 0,
          thinkingTokens: 0,
          subagentTokens: 0,
          editorTokens: 0,
          outputTokens: 0,
          inputCostUsd: 0,
          historyCostUsd: 0,
          thinkingCostUsd: 0,
          subagentCostUsd: 0,
          editorCostUsd: 0,
          outputCostUsd: 0,
          costUsd: 0,
        };
        const userPreview = summarizeText(turn.blocks['user-input'].content, 110) || 'Prompt captured';
        const agentPreview = summarizeText(
          turn.blocks['agent-output'].content
            || turn.blocks['agent-thinking'].content
            || turn.blocks['agent-subagent'].content
            || turn.blocks['agent-editor'].content,
          110
        ) || 'Waiting for response';

        return ''
          + '<div class="timeline-item">'
          + '  <div class="timeline-row user">'
          + '    <div class="timeline-role">User</div>'
          + '    <div class="timeline-snippet">' + escapeHtml(userPreview) + '</div>'
          + '    <div class="timeline-meta">'
          +        escapeHtml(compact([
                   metrics.inputTokens > 0 ? formatTokenCompact(metrics.inputTokens) + ' new' : 'Prompt captured',
                   metrics.historyTokens > 0 ? formatTokenCompact(metrics.historyTokens) + ' history' : '',
                   formatUsd((metrics.inputCostUsd || 0) + (metrics.historyCostUsd || 0)),
                 ]))
          + '    </div>'
          + '  </div>'
          + '  <div class="timeline-row agent">'
          + '    <div class="timeline-role">Agent</div>'
          + '    <div class="timeline-snippet">' + escapeHtml(agentPreview) + '</div>'
          + '    <div class="timeline-meta">'
          +        escapeHtml(compact([
                   metrics.outputTokens > 0 ? formatTokenCompact(metrics.outputTokens) + ' output' : 'Waiting',
                   metrics.thinkingTokens > 0 ? formatTokenCompact(metrics.thinkingTokens) + ' thinking' : '',
                   metrics.subagentTokens > 0 ? formatTokenCompact(metrics.subagentTokens) + ' sub-agent' : '',
                   metrics.editorTokens > 0 ? formatTokenCompact(metrics.editorTokens) + ' editor' : '',
                   formatUsd((metrics.outputCostUsd || 0) + (metrics.thinkingCostUsd || 0) + (metrics.subagentCostUsd || 0) + (metrics.editorCostUsd || 0)),
                 ]))
          + '    </div>'
          + '  </div>'
          +      renderTokenBreakdown(metrics)
          + '  <button class="timeline-button" data-action="save-prompt" data-source-id="' + escapeHtml(chat.sourceId) + '" data-chat-id="' + escapeHtml(chat.id) + '" data-turn-id="' + escapeHtml(turn.id) + '">Save prompt</button>'
          + '</div>';
      }).join('') + '</div>';
    }

    function renderSummaryPanel() {
      const analytics = snapshot.analytics || emptyAnalytics;
      summaryPanel.innerHTML = ''
        + '<div class="summary-grid">'
        + renderSummaryCard('Today', analytics.today)
        + renderSummaryCard('This Week', analytics.week)
        + renderSummaryCard('This Month', analytics.month)
        + '</div>';
    }

    function renderSummaryCard(label, bucket) {
      return ''
        + '<div class="summary-card">'
        + '  <div class="mini-label">' + escapeHtml(label) + '</div>'
        + '  <div class="summary-value">' + escapeHtml(formatUsd(bucket.costUsd)) + '</div>'
        + '  <div class="detail-copy">' + escapeHtml(formatTokens(bucket.tokens)) + '</div>'
        + '  <div class="support-copy">' + escapeHtml(compact([bucket.prompts + ' prompts', bucket.sessions + ' sessions'])) + '</div>'
        + '</div>';
    }

    function renderTrendPanel() {
      const points = (snapshot.analytics && snapshot.analytics.trend) || [];
      if (!points.length) {
        trendPanel.innerHTML = renderEmpty('Daily trend data will appear as sessions accumulate.');
        return;
      }

      const maxCost = Math.max.apply(null, points.map(function(point) {
        return point.costUsd || 0;
      }).concat([1]));

      trendPanel.innerHTML = '<div class="trend-chart">' + points.map(function(point) {
        const height = Math.max(8, Math.round(((point.costUsd || 0) / maxCost) * 150));
        return ''
          + '<div class="trend-bar" title="' + escapeHtml(compact([point.label, formatUsd(point.costUsd), formatTokens(point.tokens)])) + '">'
          + '  <div class="trend-bar-fill" style="height:' + height + 'px;"></div>'
          + '  <div class="trend-label">' + escapeHtml(point.label) + '</div>'
          + '</div>';
      }).join('') + '</div>';
    }

    function renderModelPanel() {
      const rows = (snapshot.analytics && snapshot.analytics.byModel) || [];
      if (!rows.length) {
        modelPanel.innerHTML = renderEmpty('Model efficiency appears here once model-tagged usage is captured.');
        return;
      }

      modelPanel.innerHTML = '<div class="model-list">' + rows.slice(0, 6).map(function(row) {
        return ''
          + '<div class="model-row">'
          + '  <div class="row-head">'
          + '    <div>'
          + '      <div class="row-title">' + escapeHtml(row.label) + '</div>'
          + '      <div class="detail-copy">' + escapeHtml(compact([
                   formatUsd(row.costPer1kTokens) + ' / 1k tokens',
                   formatPct((row.costShare || 0) * 100) + ' of spend',
                   Math.round(row.outputPerDollar || 0).toLocaleString() + ' output / $',
                 ])) + '</div>'
          + '    </div>'
          + '    <div class="chip green">Score ' + escapeHtml(String(row.efficiencyScore || 0)) + '</div>'
          + '  </div>'
          + '  <div class="meter"><div class="meter-fill" style="width:' + clamp(row.efficiencyScore || 0, 0, 100) + '%;"></div></div>'
          + '</div>';
      }).join('') + '</div>';
    }

    function renderAgentPanel() {
      const rows = (snapshot.analytics && snapshot.analytics.byAgent) || [];
      if (!rows.length) {
        agentPanel.innerHTML = renderEmpty('Agent mix will appear once multiple tracked sources are active.');
        return;
      }

      agentPanel.innerHTML = '<div class="model-list">' + rows.map(function(row) {
        return ''
          + '<div class="model-row">'
          + '  <div class="row-head">'
          + '    <div>'
          + '      <div class="row-title">' + escapeHtml(row.label) + '</div>'
          + '      <div class="detail-copy">' + escapeHtml(compact([
                   formatUsd(row.costUsd),
                   formatTokens(row.tokens),
                   row.sessions + ' sessions',
                 ])) + '</div>'
          + '    </div>'
          + '    <div class="chip blue">' + escapeHtml(formatPct((row.costShare || 0) * 100)) + '</div>'
          + '  </div>'
          + '  <div class="meter"><div class="meter-fill" style="width:' + clamp((row.costShare || 0) * 100, 0, 100) + '%;background:linear-gradient(90deg, var(--blue), #9ad6ff);"></div></div>'
          + '</div>';
      }).join('') + '</div>';
    }

    function renderPatternsPanel() {
      const patterns = (snapshot.analytics && snapshot.analytics.patterns) || emptyPatterns;
      if (!patterns.summaries || !patterns.summaries.length) {
        patternsPanel.innerHTML = renderEmpty('Patterns appear after you complete and switch between sessions.');
        return;
      }

      const bestSession = patterns.bestSession;
      const worstSession = patterns.worstSession;
      const topPeriod = patterns.timeOfDay && patterns.timeOfDay[0];

      patternsPanel.innerHTML = ''
        + '<div class="pattern-grid">'
        + '  <div class="pattern-card">'
        + '    <div class="section-label">Average Health Trend</div>'
        + '    <div class="detail-copy">' + escapeHtml(patterns.averageHealthTrend.map(function(point) {
               return point.label + ' ' + Math.round(point.healthScore);
             }).join(' · ')) + '</div>'
        + '  </div>'
        + '  <div class="pattern-card">'
        + '    <div class="section-label">Best Vs Worst</div>'
        + '    <div class="detail-copy">' + escapeHtml(bestSession ? bestSession.title + ' (' + Math.round(bestSession.efficiencyScore) + ')' : 'No best session yet') + '</div>'
        + '    <div class="support-copy">' + escapeHtml(worstSession ? worstSession.title + ' (' + Math.round(worstSession.efficiencyScore) + ')' : 'No worst session yet') + '</div>'
        + '  </div>'
        + '  <div class="pattern-card">'
        + '    <div class="section-label">Time Of Day Efficiency</div>'
        + '    <div class="detail-copy">' + escapeHtml(topPeriod ? topPeriod.label + ' averages ' + Math.round(topPeriod.averageEfficiencyScore) + ' / 100 efficiency' : 'Not enough sessions yet') + '</div>'
        + '  </div>'
        + '</div>'
        + '<div class="model-list" style="margin-top:14px;">'
        + ((patterns.expensivePromptPatterns || []).length
          ? patterns.expensivePromptPatterns.map(function(pattern) {
              return ''
                + '<div class="pattern-card">'
                + '  <div class="row-head">'
                + '    <div>'
                + '      <div class="row-title">' + escapeHtml(pattern.label) + '</div>'
                + '      <div class="detail-copy">' + escapeHtml(compact([
                         formatUsd(pattern.averageCostUsd) + ' avg',
                         formatUsd(pattern.totalCostUsd) + ' total',
                         pattern.sessions + ' sessions',
                       ])) + '</div>'
                + '    </div>'
                + '    <div class="chip amber">' + escapeHtml(pattern.prompts + ' prompts') + '</div>'
                + '  </div>'
                + '</div>';
            }).join('')
          : renderEmpty('No expensive prompt patterns have formed yet.'))
        + '</div>';
    }

    function renderBudgetPanel() {
      const alerts = snapshot.alerts || [];
      const alertMarkup = alerts.length
        ? '<div class="alert-list">' + alerts.map(function(alert) {
            return ''
              + '<div class="alert-card">'
              + '  <div class="row-head">'
              + '    <div>'
              + '      <div class="row-title">' + escapeHtml(alert.title) + '</div>'
              + '      <div class="detail-copy">' + escapeHtml(alert.detail) + '</div>'
              + '    </div>'
              + '    <div class="chip ' + escapeHtml(alert.level === 'critical' ? 'red' : alert.level === 'warn' ? 'amber' : 'blue') + '">' + escapeHtml(formatPct((alert.progress || 0) * 100)) + '</div>'
              + '  </div>'
              + '</div>';
          }).join('') + '</div>'
        : renderEmpty('No active alerts yet. Set budgets here and the dashboard will watch your runway.');

      budgetPanel.innerHTML = ''
        + '<div class="detail-copy">Secondary controls stay tucked away here so the primary dashboard can stay focused.</div>'
        + '<div class="field-grid">'
        + '  <div class="field"><label for="daily-cost-budget">Daily cost budget (USD)</label><input id="daily-cost-budget" type="number" min="0" step="0.01" value="' + escapeHtml(snapshot.budgets.dailyCostUsd ?? '') + '"></div>'
        + '  <div class="field"><label for="monthly-cost-budget">Monthly cost budget (USD)</label><input id="monthly-cost-budget" type="number" min="0" step="0.01" value="' + escapeHtml(snapshot.budgets.monthlyCostUsd ?? '') + '"></div>'
        + '  <div class="field"><label for="daily-token-budget">Daily token budget</label><input id="daily-token-budget" type="number" min="0" step="1" value="' + escapeHtml(snapshot.budgets.dailyTokens ?? '') + '"></div>'
        + '  <div class="field"><label for="monthly-token-budget">Monthly token budget</label><input id="monthly-token-budget" type="number" min="0" step="1" value="' + escapeHtml(snapshot.budgets.monthlyTokens ?? '') + '"></div>'
        + '</div>'
        + '<div class="button-row"><button class="button" data-action="save-budgets">Save budgets</button></div>'
        + alertMarkup;
    }

    function renderPromptLibrary() {
      const prompts = (snapshot.promptLibrary || []).filter(function(prompt) {
        if (!libraryQuery) {
          return true;
        }

        const haystack = [prompt.title, prompt.content].concat(prompt.tags || []).join(' ').toLowerCase();
        return haystack.includes(libraryQuery);
      });

      const list = prompts.length
        ? '<div class="library-list">' + prompts.map(function(prompt) {
            return ''
              + '<div class="prompt-card">'
              + '  <div class="row-head">'
              + '    <div>'
              + '      <div class="row-title">' + escapeHtml(prompt.title) + '</div>'
              + '      <div class="detail-copy">' + escapeHtml(compact([
                       prompt.model || prompt.sourceLabel || 'Saved prompt',
                       'Used ' + (prompt.useCount || 0) + ' times',
                     ])) + '</div>'
              + '    </div>'
              + '    <div class="tag-row">' + (prompt.tags || []).map(function(tag) {
                       return '<span class="tag">' + escapeHtml(tag) + '</span>';
                     }).join('') + '</div>'
              + '  </div>'
              + '  <div class="prompt-preview">' + escapeHtml(prompt.content.length > 280 ? prompt.content.slice(0, 277).trimEnd() + '...' : prompt.content) + '</div>'
              + '  <div class="button-row">'
              + '    <button class="button" data-action="copy-prompt" data-prompt-id="' + escapeHtml(prompt.id) + '">Copy</button>'
              + '    <button class="ghost-button" data-action="delete-prompt" data-prompt-id="' + escapeHtml(prompt.id) + '">Delete</button>'
              + '  </div>'
              + '</div>';
          }).join('') + '</div>'
        : renderEmpty(libraryQuery ? 'No saved prompts match this search.' : 'Save a strong prompt from the timeline and it will appear here.');

      promptLibraryPanel.innerHTML = ''
        + '<input id="library-search" class="search" type="search" placeholder="Search saved prompts or tags..." value="' + escapeHtml(libraryQuery) + '">'
        + list;
    }

    function applySnapshot(nextSnapshot) {
      snapshot = nextSnapshot || snapshot;
      heroTitle.textContent = (snapshot.appLabel || 'VS Code') + ' AI Token Analytics';
      heroSubtitle.textContent = 'Tracking ' + (((snapshot.sources || []).length) || 0) + ' active source' + ((((snapshot.sources || []).length) || 0) === 1 ? '' : 's') + ' with live context and spend guidance.';
      render();
    }

    function updateStatus(status, text) {
      statusDot.className = 'status-dot ' + (status || 'monitoring');
      statusText.textContent = text || 'Tracking AI usage...';
    }

    function render() {
      renderLiveSession();
      renderCoachPanel();
      renderTimelinePanel();
      renderSummaryPanel();
      renderTrendPanel();
      renderModelPanel();
      renderAgentPanel();
      renderPatternsPanel();
      renderBudgetPanel();
      renderPromptLibrary();
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

      if (action === 'generate-session-analysis') {
        vscode.postMessage({ command: 'generateSessionAnalysis' });
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
          if (!(element instanceof HTMLInputElement) || !element.value) {
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
            hasGroqKey: snapshot.hasGroqKey,
            sessionAnalysis: snapshot.sessionAnalysis,
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
