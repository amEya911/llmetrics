import * as vscode from 'vscode';
import * as https from 'https';
import { IncomingMessage } from 'http';
import {
  NETWORK_INTERCEPTOR_IGNORE_HEADER,
  NETWORK_INTERCEPTOR_IGNORE_VALUE,
} from './NetworkInterceptor';
import {
  CoachInsight,
  ConversationChat,
  CrossSessionPatterns,
  PersistedSessionSummary,
} from './types';

const GROQ_MODEL = 'llama-3.3-70b-versatile';

interface GroqResponse {
  choices: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
}

export interface FullSessionPromptBreakdown {
  promptIndex: number;
  promptExcerpt: string;
  clarityScore: number;
  tokenEfficiencyScore: number;
  whatWorkedWell: string[];
  whatToImprove: string[];
}

export interface FullSessionAnalysisReport {
  executiveSummary: string;
  overallVerdict: string;
  promptBreakdown: FullSessionPromptBreakdown[];
  patternAnalysis: string[];
  contextManagementGrade: string;
  contextManagementSummary: string;
  modelChoiceAudit: string;
  topActions: string[];
  efficiencyPercentile: number;
}

export async function analyzeChatWithGroq(chat: ConversationChat): Promise<CoachInsight[]> {
  if (!hasGroqApiKey()) {
    return [];
  }

  const recentTurns = chat.turns.slice(-4);
  if (recentTurns.length === 0) {
    return [];
  }

  const conversationText = recentTurns.map((turn, index) => {
    return `Turn ${index + 1}
User Prompt:
${turn.blocks['user-input']?.content ?? ''}

Assistant Output Preview:
${(turn.blocks['agent-output']?.content ?? '').slice(0, 900)}`;
  }).join('\n\n');

  const systemPrompt = `You are an expert, direct AI developer coach monitoring an engineer's coding session.
Analyze the recent turns to identify severe prompt-quality or context-management mistakes (e.g., error loops, context rot, prompt drift, or over-constrained requests).

Return ONLY a valid JSON object matching this schema:
{
  "insights": [
    {
      "id": "slug-style-unique-id",
      "level": "warn" | "danger" | "info",
      "title": "Short, punchy title (max 5 words)",
      "detail": "One highly specific sentence describing the mistake AND how to phrase the prompt better."
    }
  ]
}

Rules:
- Be ruthless but constructive. Do not point out minor typos or missing pleasantries.
- Only surface high-leverage issues costing the user time or tokens.
- If the conversation is healthy and efficient, you MUST return {"insights":[]}.
`;

  const result = await requestGroqJson<{ insights?: CoachInsight[] }>([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: conversationText },
  ]);

  return sanitizeCoachInsights(result?.insights);
}

export async function generateFullSessionAnalysis(
  chat: ConversationChat,
  patterns: CrossSessionPatterns,
  sessionSummaries: PersistedSessionSummary[]
): Promise<FullSessionAnalysisReport> {
  const userTurns = chat.turns.filter((turn) => Boolean(turn.blocks['user-input'].content.trim()));
  if (userTurns.length === 0) {
    throw new Error('No user prompts are available in this session yet.');
  }

  const payload = {
    session: {
      id: chat.id,
      title: chat.title,
      source: chat.sourceLabel,
      model: chat.model,
      contextUsagePercent: chat.contextUsagePercent,
      contextWindowTokens: chat.contextWindowTokens,
      metrics: chat.metrics,
      contextHealth: chat.contextHealth,
      turns: userTurns.map((turn, index) => ({
        promptIndex: index + 1,
        turnId: turn.id,
        createdAt: turn.createdAt,
        prompt: turn.blocks['user-input'].content,
        assistantThinking: turn.blocks['agent-thinking'].content,
        assistantOutput: turn.blocks['agent-output'].content,
        metrics: turn.metrics,
        assessment: turn.assessment,
        modelRecommendation: turn.modelRecommendation,
      })),
    },
    crossSession: {
      recentSessionCount: sessionSummaries.length,
      bestSession: patterns.bestSession
        ? {
          title: patterns.bestSession.title,
          efficiencyScore: patterns.bestSession.efficiencyScore,
          healthScore: patterns.bestSession.healthScore,
          model: patterns.bestSession.model,
        }
        : undefined,
      worstSession: patterns.worstSession
        ? {
          title: patterns.worstSession.title,
          efficiencyScore: patterns.worstSession.efficiencyScore,
          healthScore: patterns.worstSession.healthScore,
          model: patterns.worstSession.model,
        }
        : undefined,
      expensivePromptPatterns: patterns.expensivePromptPatterns,
      timeOfDay: patterns.timeOfDay,
    },
  };

  const systemPrompt = `You are a premium AI usage analyst auditing a power user's workflow with their coding assistant.
Using the provided JSON session data, produce a concrete, deeply specific evaluation of the session's efficiency.
Anchor every conclusion in the explicit prompts, token metrics, and model choices provided in the payload.

Return ONLY a valid JSON object matching this exact schema:
{
  "executiveSummary": "One paragraph ruthless verdict on the session's velocity and token efficiency.",
  "overallVerdict": "Excellent" | "Good" | "Mixed" | "Wasteful",
  "promptBreakdown": [
    {
      "promptIndex": 1,
      "promptExcerpt": "Short excerpt",
      "clarityScore": 0-100,
      "tokenEfficiencyScore": 0-100,
      "whatWorkedWell": ["Bullet 1", "Bullet 2"],
      "whatToImprove": ["Bullet 1", "Bullet 2"],
      "rewrittenPrompt": "A highly optimized, token-efficient version of their prompt"
    }
  ],
  "patternAnalysis": ["Specific recurring inefficiency 1", "Specific recurring inefficiency 2"],
  "contextManagementGrade": "A single letter grade (A, B, C, D, or F) with optional +/-",
  "contextManagementSummary": "Concrete explanation of their context management quality",
  "modelChoiceAudit": "Concrete explanation of whether the selected model tier fit the task complexity",
  "topActions": ["First actionable change", "Second actionable change", "Third actionable change"],
  "efficiencyPercentile": 0-100
}

Rules:
- Include every user prompt in 'promptBreakdown', preserving chronological order.
- Keep the feedback extremely sharp and action-oriented. Do not use generic filler words.
- Specifically call out repeated context setup, dead references, or using expensive models for simple syntax tasks.
- For 'efficiencyPercentile', estimate a score strictly reflecting their token-to-value ratio.
`;

  const report = await streamGroqJson<FullSessionAnalysisReport>([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify(payload, null, 2) },
  ]);

  return sanitizeFullSessionReport(report, userTurns.map((turn, index) => ({
    promptIndex: index + 1,
    promptExcerpt: turn.blocks['user-input'].content.trim(),
  })));
}

export function renderFullSessionAnalysisHtml(
  chat: ConversationChat,
  report: FullSessionAnalysisReport,
  patterns: CrossSessionPatterns
): string {
  const verdictTone = verdictToneFor(report.overallVerdict);
  const generatedAt = new Date().toLocaleString();
  const userTurns = chat.turns.filter((turn) => Boolean(turn.blocks['user-input'].content.trim()));

  const promptCards = report.promptBreakdown.map((prompt) => {
    const promptBody = userTurns[prompt.promptIndex - 1]?.blocks['user-input']?.content ?? prompt.promptExcerpt;
    return `
      <article class="prompt-card">
        <div class="prompt-head">
          <div>
            <div class="prompt-index">Prompt ${prompt.promptIndex}</div>
            <h3>${escapeHtml(prompt.promptExcerpt)}</h3>
          </div>
          <div class="score-stack">
            <div class="score-chip ${scoreTone(prompt.clarityScore)}">Clarity ${prompt.clarityScore}</div>
            <div class="score-chip ${scoreTone(prompt.tokenEfficiencyScore)}">Efficiency ${prompt.tokenEfficiencyScore}</div>
          </div>
        </div>
        <div class="prompt-body">${escapeHtml(promptBody)}</div>
        <div class="prompt-grid">
          <section>
            <div class="section-label">What Worked</div>
            <ul>${prompt.whatWorkedWell.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </section>
          <section>
            <div class="section-label">What To Improve</div>
            <ul>${prompt.whatToImprove.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </section>
        </div>
      </article>
    `;
  }).join('');

  const patternItems = report.patternAnalysis.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const actionItems = report.topActions.map((item, index) => `<li><span>${index + 1}</span>${escapeHtml(item)}</li>`).join('');
  const timeOfDay = patterns.timeOfDay[0];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(chat.title || 'Session Analysis')}</title>
  <style>
    :root {
      --bg: #07111b;
      --bg-soft: #0b1825;
      --card: rgba(13, 25, 39, 0.94);
      --card-strong: rgba(10, 18, 28, 0.98);
      --line: rgba(146, 187, 232, 0.14);
      --text: #edf5ff;
      --muted: #90a0b4;
      --blue: #69b5ff;
      --blue-soft: rgba(105, 181, 255, 0.16);
      --green: #64d8ab;
      --green-soft: rgba(100, 216, 171, 0.16);
      --amber: #f1c067;
      --amber-soft: rgba(241, 192, 103, 0.16);
      --red: #ff8c8e;
      --red-soft: rgba(255, 140, 142, 0.18);
      --shadow: 0 28px 80px rgba(0, 0, 0, 0.38);
      --radius: 26px;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Aptos", "SF Pro Display", "Segoe UI Variable", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(105, 181, 255, 0.16), transparent 28%),
        radial-gradient(circle at top right, rgba(100, 216, 171, 0.1), transparent 24%),
        linear-gradient(180deg, #07111b 0%, #050c14 100%);
    }

    .page {
      max-width: 1160px;
      margin: 0 auto;
      padding: 40px 24px 64px;
    }

    .hero {
      padding: 32px;
      border-radius: 32px;
      background: linear-gradient(180deg, rgba(14, 27, 42, 0.96), rgba(8, 15, 24, 0.98));
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      display: grid;
      gap: 24px;
    }

    .eyebrow {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    h1 {
      margin: 8px 0 0;
      font-size: clamp(32px, 6vw, 54px);
      line-height: 0.95;
      letter-spacing: -0.06em;
    }

    .hero-subtitle {
      max-width: 64ch;
      color: var(--muted);
      font-size: 15px;
    }

    .hero-grid,
    .summary-grid,
    .prompt-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .hero-stat,
    .summary-card,
    .prompt-card,
    .panel {
      border-radius: var(--radius);
      background: var(--card);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }

    .hero-stat,
    .summary-card,
    .panel {
      padding: 22px;
    }

    .hero-stat-value {
      margin-top: 8px;
      font-size: 34px;
      font-weight: 800;
      letter-spacing: -0.05em;
    }

    .hero-stat-note,
    .summary-copy,
    .panel-copy {
      margin-top: 8px;
      color: var(--muted);
      line-height: 1.55;
    }

    .verdict-badge,
    .score-chip {
      display: inline-flex;
      align-items: center;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .verdict-badge.blue,
    .score-chip.blue { background: var(--blue-soft); color: #d7ecff; }
    .verdict-badge.green,
    .score-chip.green { background: var(--green-soft); color: #d7ffee; }
    .verdict-badge.amber,
    .score-chip.amber { background: var(--amber-soft); color: #ffe8c0; }
    .verdict-badge.red,
    .score-chip.red { background: var(--red-soft); color: #ffd5d6; }

    .section {
      margin-top: 28px;
      display: grid;
      gap: 18px;
    }

    .section-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
    }

    .section-title {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }

    .section-note {
      color: var(--muted);
      max-width: 60ch;
    }

    .prompt-card {
      padding: 22px;
      display: grid;
      gap: 18px;
    }

    .prompt-body {
      padding: 14px;
      border-radius: 16px;
      background: rgba(0, 0, 0, 0.16);
      color: var(--muted-strong);
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, "SFMono-Regular", monospace;
      font-size: 12px;
      line-height: 1.58;
    }

    .prompt-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
    }

    .prompt-index,
    .section-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .prompt-card h3 {
      margin: 8px 0 0;
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: -0.04em;
    }

    .score-stack {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: end;
    }

    ul {
      margin: 10px 0 0;
      padding-left: 18px;
      color: var(--text);
    }

    li {
      margin: 8px 0;
      line-height: 1.5;
    }

    .action-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 12px;
    }

    .action-list li {
      display: grid;
      grid-template-columns: 32px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
      margin: 0;
    }

    .action-list span {
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: var(--blue-soft);
      color: #d9eeff;
      font-weight: 800;
    }

    @media (max-width: 760px) {
      .page { padding: 28px 16px 48px; }
      .hero-grid,
      .summary-grid,
      .prompt-grid { grid-template-columns: 1fr; }
      .prompt-head,
      .section-head { display: grid; }
      .score-stack { justify-content: start; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div>
        <div class="eyebrow">Full Session Analysis</div>
        <h1>${escapeHtml(chat.title || 'Untitled session')}</h1>
        <div class="hero-subtitle">${escapeHtml(report.executiveSummary)}</div>
      </div>
      <div class="hero-grid">
        <div class="hero-stat">
          <div class="eyebrow">Verdict</div>
          <div class="hero-stat-value">${escapeHtml(report.overallVerdict)}</div>
          <div class="hero-stat-note">
            <span class="verdict-badge ${verdictTone}">${escapeHtml(report.contextManagementGrade)} context grade</span>
          </div>
        </div>
        <div class="hero-stat">
          <div class="eyebrow">Efficiency Percentile</div>
          <div class="hero-stat-value">${Math.round(report.efficiencyPercentile)}th</div>
          <div class="hero-stat-note">Generated ${escapeHtml(generatedAt)} using ${escapeHtml(chat.model || 'the active model context')} session data.</div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">Session Verdict</div>
          <div class="section-note">The sharpest take on how this session performed and what to change next.</div>
        </div>
        <div class="verdict-badge ${verdictTone}">${escapeHtml(report.overallVerdict)}</div>
      </div>
      <div class="summary-grid">
        <article class="summary-card">
          <div class="section-label">Pattern Analysis</div>
          <ul>${patternItems}</ul>
        </article>
        <article class="summary-card">
          <div class="section-label">Model Choice Audit</div>
          <div class="summary-copy">${escapeHtml(report.modelChoiceAudit)}</div>
        </article>
        <article class="summary-card">
          <div class="section-label">Context Management</div>
          <div class="hero-stat-value">${escapeHtml(report.contextManagementGrade)}</div>
          <div class="summary-copy">${escapeHtml(report.contextManagementSummary)}</div>
        </article>
        <article class="summary-card">
          <div class="section-label">Cross-Session Signal</div>
          <div class="summary-copy">${escapeHtml(
    timeOfDay
      ? `${timeOfDay.label} has been your strongest recent work window, averaging ${Math.round(timeOfDay.averageEfficiencyScore)} / 100 efficiency across ${timeOfDay.sessions} sessions.`
      : 'Not enough previous sessions were available to add a strong time-of-day comparison.'
  )}</div>
        </article>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">Prompt-by-Prompt Breakdown</div>
          <div class="section-note">Every user prompt scored for clarity and token efficiency, with concrete feedback.</div>
        </div>
      </div>
      ${promptCards}
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">Top 3 Next Actions</div>
          <div class="section-note">The highest-leverage changes to make in your next session.</div>
        </div>
      </div>
      <article class="panel">
        <ol class="action-list">${actionItems}</ol>
      </article>
    </section>
  </main>
</body>
</html>`;
}

function hasGroqApiKey(): boolean {
  return Boolean(getGroqApiKey());
}

function getGroqApiKey(): string | undefined {
  const config = vscode.workspace.getConfiguration('aiAgentMonitor');
  const apiKey = config.get<string>('groqApiKey', '').trim();
  return apiKey || undefined;
}

async function requestGroqJson<T>(
  messages: Array<{ role: 'system' | 'user'; content: string }>
): Promise<T | undefined> {
  const text = await requestGroqText(messages, false);
  return parseGroqJson<T>(text);
}

async function streamGroqJson<T>(
  messages: Array<{ role: 'system' | 'user'; content: string }>
): Promise<T> {
  const text = await requestGroqText(messages, true);
  const parsed = parseGroqJson<T>(text);
  if (!parsed) {
    throw new Error('Groq returned malformed analysis JSON.');
  }
  return parsed;
}

async function requestGroqText(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  stream: boolean
): Promise<string> {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error('Groq API key is not configured.');
  }

  const requestBody = JSON.stringify({
    model: GROQ_MODEL,
    messages,
    temperature: 0.2,
    stream,
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        [NETWORK_INTERCEPTOR_IGNORE_HEADER]: NETWORK_INTERCEPTOR_IGNORE_VALUE,
      },
    }, (res) => {
      if (!stream) {
        collectBufferedResponse(res, resolve, reject);
        return;
      }

      let sseBuffer = '';
      let output = '';

      res.on('data', (chunk) => {
        sseBuffer += chunk.toString('utf8');
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          output += extractStreamDelta(line);
        }
      });

      res.on('end', () => {
        output += extractStreamDelta(sseBuffer);
        if (res.statusCode !== 200) {
          reject(new Error(output || `Groq request failed with status ${res.statusCode}`));
          return;
        }
        resolve(output);
      });
    });

    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

function collectBufferedResponse(
  res: IncomingMessage,
  resolve: (value: string) => void,
  reject: (reason?: unknown) => void
): void {
  let data = '';
  res.on('data', (chunk: Buffer) => {
    data += chunk.toString('utf8');
  });
  res.on('end', () => {
    if (res.statusCode !== 200) {
      reject(new Error(data || `Groq request failed with status ${res.statusCode}`));
      return;
    }

    try {
      const payload = JSON.parse(data) as GroqResponse;
      resolve(payload.choices[0]?.message?.content ?? '');
    } catch (error) {
      reject(error);
    }
  });
}

function extractStreamDelta(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return '';
  }

  const value = trimmed.slice(5).trim();
  if (!value || value === '[DONE]') {
    return '';
  }

  try {
    const parsed = JSON.parse(value) as GroqResponse;
    return parsed.choices[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}

function parseGroqJson<T>(value: string): T | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const objectMatch = trimmed.match(/\{[\s\S]*\}$/);
    if (!objectMatch) {
      return undefined;
    }

    try {
      return JSON.parse(objectMatch[0]) as T;
    } catch {
      return undefined;
    }
  }
}

function sanitizeCoachInsights(insights: CoachInsight[] | undefined): CoachInsight[] {
  if (!Array.isArray(insights)) {
    return [];
  }

  return insights.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }

    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const detail = typeof candidate.detail === 'string' ? candidate.detail.trim() : '';
    if (!title || !detail) {
      return [];
    }

    return [{
      id: typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id
        : `groq-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      level: candidate.level === 'danger' || candidate.level === 'warn' || candidate.level === 'info'
        ? candidate.level
        : 'info',
      title,
      detail,
    }];
  });
}

function sanitizeFullSessionReport(
  report: FullSessionAnalysisReport,
  prompts: Array<{ promptIndex: number; promptExcerpt: string }>
): FullSessionAnalysisReport {
  const promptLookup = new Map(prompts.map((prompt) => [prompt.promptIndex, prompt.promptExcerpt]));

  return {
    executiveSummary: safeString(report.executiveSummary, 'This session has enough activity for analysis, but the summary came back incomplete.'),
    overallVerdict: safeString(report.overallVerdict, 'Mixed'),
    promptBreakdown: prompts.map((prompt, index) => {
      const existing = Array.isArray(report.promptBreakdown)
        ? report.promptBreakdown.find((candidate) => candidate.promptIndex === prompt.promptIndex)
        : undefined;

      return {
        promptIndex: prompt.promptIndex,
        promptExcerpt: safeString(
          existing?.promptExcerpt,
          promptLookup.get(prompt.promptIndex) ?? `Prompt ${index + 1}`
        ),
        clarityScore: clampScore(existing?.clarityScore),
        tokenEfficiencyScore: clampScore(existing?.tokenEfficiencyScore),
        whatWorkedWell: safeStringArray(existing?.whatWorkedWell, 'Clear objective or helpful context was present.'),
        whatToImprove: safeStringArray(existing?.whatToImprove, 'Tighten the ask and remove context the model did not need.'),
      };
    }),
    patternAnalysis: safeStringArray(
      report.patternAnalysis,
      'Patterns were inconclusive, but replayed context and prompt clarity should still be watched.'
    ),
    contextManagementGrade: safeString(report.contextManagementGrade, 'B'),
    contextManagementSummary: safeString(
      report.contextManagementSummary,
      'Context handling was serviceable, but there is room to reduce replay and unused attachments.'
    ),
    modelChoiceAudit: safeString(
      report.modelChoiceAudit,
      'Model selection was mixed; some prompts likely could have used a cheaper tier.'
    ),
    topActions: safeStringArray(
      report.topActions,
      'Trim repeated setup and keep a reusable project brief.',
      'Use a cheaper fast model for lightweight edits and formatting work.',
      'Start a fresh chat once replay cost or context saturation climbs.'
    ).slice(0, 3),
    efficiencyPercentile: clampScore(report.efficiencyPercentile),
  };
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeStringArray(value: unknown, ...fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const next = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());

  return next.length > 0 ? next : fallback;
}

function clampScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 50;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function verdictToneFor(value: string): 'green' | 'blue' | 'amber' | 'red' {
  const normalized = value.toLowerCase();
  if (/(excellent|great)/i.test(normalized)) {
    return 'green';
  }
  if (/(good)/i.test(normalized)) {
    return 'blue';
  }
  if (/(mixed)/i.test(normalized)) {
    return 'amber';
  }
  return 'red';
}

function scoreTone(score: number): 'green' | 'blue' | 'amber' | 'red' {
  if (score >= 90) {
    return 'green';
  }
  if (score >= 75) {
    return 'blue';
  }
  if (score >= 55) {
    return 'amber';
  }
  return 'red';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
