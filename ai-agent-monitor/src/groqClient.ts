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
  SessionDiagnostics,
} from './types';
import { analyzeSessionDiagnostics } from './sessionDiagnostics';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const FULL_REPORT_MAX_PAYLOAD_CHARS = 90_000;
const FULL_REPORT_CHUNK_TARGET_CHARS = 42_000;

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
  diagnosis: string;
  rewrittenPrompt: string;
}

export interface FullSessionAnalysisReport {
  executiveSummary: string;
  overallVerdict: string;
  sessionPersonality: string;
  nextSessionBriefing: string;
  promptBreakdown: FullSessionPromptBreakdown[];
  patternAnalysis: string[];
  contextManagementGrade: string;
  contextManagementSummary: string;
  modelChoiceAudit: string;
  topActions: string[];
  tokenWasteEstimate: number;
  tokenWasteBreakdown: string[];
}

interface FullSessionTurnPayload {
  promptIndex: number;
  turnId: string;
  createdAt: number;
  updatedAt: number;
  model: string | undefined;
  prompt: string;
  assistantThinking: string;
  assistantOutput: string;
  metrics: unknown;
  assessment: unknown;
  modelRecommendation: unknown;
}

interface FullSessionPayload {
  session: {
    id: string;
    title: string;
    source: string;
    model: string | undefined;
    contextUsagePercent: number | undefined;
    contextWindowTokens: number | undefined;
    metrics: unknown;
    contextHealth: unknown;
  };
  diagnostics: SessionDiagnostics;
  crossSession: {
    recentSessionCount: number;
    bestSession: unknown;
    worstSession: unknown;
    expensivePromptPatterns: unknown;
    timeOfDay: unknown;
  };
  turns: FullSessionTurnPayload[];
}

interface ChunkPromptAnalysis {
  promptBreakdown: FullSessionPromptBreakdown[];
  chunkPatterns: string[];
  chunkActions: string[];
  personalityNotes: string[];
}

export async function analyzeChatWithGroq(chat: ConversationChat): Promise<CoachInsight[]> {
  if (!hasGroqApiKey()) {
    return [];
  }

  const payload = buildFullSessionPayload(chat, {
    summaries: [],
    averageHealthTrend: [],
    expensivePromptPatterns: [],
    timeOfDay: [],
  }, []);
  if (payload.turns.length === 0) {
    return [];
  }

  const coachPayload = trimCoachPayload(payload);
  const systemPrompt = `You are auditing one developer's AI coding session against real complaints developers keep making in the wild:
- "I have to keep re-explaining the repo because the model forgot."
- "I'm pasting the same terminal error back in and not getting unstuck."
- "The chat drifted into too many tasks and now it's unusable."
- "I'm burning premium-model money on cheap edits."
- "A giant attachment got dragged along for no benefit."
- "The session turned into a frustrated loop."

You may ONLY surface these named patterns when the evidence supports them:
- The Re-explainer
- The Error Paster
- The Scope Creeper
- The Cheap Task Tax
- The Dead Attachment
- The Frustration Spiral

Return ONLY a valid JSON object matching this schema:
{
  "insights": [
    {
      "id": "slug-style-id",
      "level": "danger" | "warn" | "info",
      "title": "One exact pattern name from the list above",
      "pattern": "re-explainer" | "error-paster" | "scope-creeper" | "cheap-task-tax" | "dead-attachment" | "frustration-spiral",
      "summary": "One sentence on what is happening in this session",
      "startedTurn": 1,
      "turnNumbers": [1, 2],
      "tokensSoFar": 0,
      "costUsdSoFar": 0,
      "actionNow": "One concrete next step the developer should take immediately"
    }
  ]
}

Rules:
- Use the diagnostics numbers when they are present instead of inventing your own.
- Every insight must include exact turn numbers plus exact token or dollar impact from the payload.
- Do not output generic advice like "be clearer", "tighten your prompt", or "improve context management".
- Prefer the highest-cost 1-3 issues only.
- If the evidence is weak or the session is healthy, return {"insights":[]}.`;

  const result = await requestGroqJson<{ insights?: CoachInsight[] }>([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify(coachPayload, null, 2) },
  ]);

  return sanitizeCoachInsights(result?.insights);
}

export async function generateFullSessionAnalysis(
  chat: ConversationChat,
  patterns: CrossSessionPatterns,
  sessionSummaries: PersistedSessionSummary[]
): Promise<FullSessionAnalysisReport> {
  const payload = buildFullSessionPayload(chat, patterns, sessionSummaries);
  if (payload.turns.length === 0) {
    throw new Error('No user prompts are available in this session yet.');
  }

  const payloadText = JSON.stringify(payload);
  const promptBreakdownFallback = payload.turns.map((turn) => ({
    promptIndex: turn.promptIndex,
    promptExcerpt: turn.prompt,
  }));

  if (payloadText.length <= FULL_REPORT_MAX_PAYLOAD_CHARS) {
    const report = await streamGroqJson<FullSessionAnalysisReport>([
      { role: 'system', content: buildFullSessionSystemPrompt() },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ]);
    return sanitizeFullSessionReport(report, promptBreakdownFallback, payload.diagnostics, chat);
  }

  const chunkResults = await analyzePromptBreakdownChunks(payload);
  const report = await streamGroqJson<Omit<FullSessionAnalysisReport, 'promptBreakdown'>>([
    { role: 'system', content: buildChunkSynthesisSystemPrompt() },
    {
      role: 'user',
      content: JSON.stringify({
        session: payload.session,
        diagnostics: payload.diagnostics,
        crossSession: payload.crossSession,
        mergedPromptBreakdown: chunkResults.promptBreakdown,
        chunkPatterns: chunkResults.chunkPatterns,
        chunkActions: chunkResults.chunkActions,
        personalityNotes: chunkResults.personalityNotes,
      }, null, 2),
    },
  ]);

  return sanitizeFullSessionReport(
    {
      ...report,
      promptBreakdown: chunkResults.promptBreakdown,
    } as FullSessionAnalysisReport,
    promptBreakdownFallback,
    payload.diagnostics,
    chat
  );
}

function buildFullSessionPayload(
  chat: ConversationChat,
  patterns: CrossSessionPatterns,
  sessionSummaries: PersistedSessionSummary[]
): FullSessionPayload {
  const userTurns = chat.turns
    .filter((turn) => Boolean(turn.blocks['user-input'].content.trim()))
    .map((turn, index) => ({
      promptIndex: index + 1,
      turnId: turn.id,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      model: turn.model ?? chat.model,
      prompt: turn.blocks['user-input'].content,
      assistantThinking: turn.blocks['agent-thinking'].content,
      assistantOutput: turn.blocks['agent-output'].content,
      metrics: turn.metrics,
      assessment: turn.assessment,
      modelRecommendation: turn.modelRecommendation,
    }));

  return {
    session: {
      id: chat.id,
      title: chat.title,
      source: chat.sourceLabel,
      model: chat.model,
      contextUsagePercent: chat.contextUsagePercent,
      contextWindowTokens: chat.contextWindowTokens,
      metrics: chat.metrics,
      contextHealth: chat.contextHealth,
    },
    diagnostics: analyzeSessionDiagnostics(chat),
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
    turns: userTurns,
  };
}

function trimCoachPayload(payload: FullSessionPayload) {
  const conciseTurns = payload.turns.map((turn) => ({
    ...turn,
    assistantThinking: truncate(turn.assistantThinking, 700),
    assistantOutput: truncate(turn.assistantOutput, 1200),
  }));

  const serialized = JSON.stringify({ ...payload, turns: conciseTurns });
  if (serialized.length <= FULL_REPORT_CHUNK_TARGET_CHARS) {
    return { ...payload, turns: conciseTurns };
  }

  const focusTurns = new Set<number>();
  for (const issue of payload.diagnostics.issues) {
    for (const turnNumber of issue.turnNumbers) {
      focusTurns.add(turnNumber);
      if (turnNumber > 1) {
        focusTurns.add(turnNumber - 1);
      }
    }
  }
  conciseTurns.slice(-2).forEach((turn) => focusTurns.add(turn.promptIndex));

  return {
    ...payload,
    turns: conciseTurns.filter((turn) => focusTurns.has(turn.promptIndex)),
  };
}

async function analyzePromptBreakdownChunks(
  payload: FullSessionPayload
): Promise<{
  promptBreakdown: FullSessionPromptBreakdown[];
  chunkPatterns: string[];
  chunkActions: string[];
  personalityNotes: string[];
}> {
  const chunks = chunkTurns(payload.turns, FULL_REPORT_CHUNK_TARGET_CHARS);
  const results: ChunkPromptAnalysis[] = [];

  for (const chunk of chunks) {
    const result = await streamGroqJson<ChunkPromptAnalysis>([
      { role: 'system', content: buildChunkPromptSystemPrompt() },
      {
        role: 'user',
        content: JSON.stringify({
          session: payload.session,
          diagnostics: payload.diagnostics,
          chunk,
        }, null, 2),
      },
    ]);
    results.push(result);
  }

  return {
    promptBreakdown: results
      .flatMap((result) => result.promptBreakdown ?? [])
      .sort((left, right) => left.promptIndex - right.promptIndex),
    chunkPatterns: uniqueStrings(results.flatMap((result) => result.chunkPatterns ?? [])).slice(0, 6),
    chunkActions: uniqueStrings(results.flatMap((result) => result.chunkActions ?? [])).slice(0, 6),
    personalityNotes: uniqueStrings(results.flatMap((result) => result.personalityNotes ?? [])).slice(0, 6),
  };
}

function chunkTurns(turns: FullSessionTurnPayload[], targetChars: number): FullSessionTurnPayload[][] {
  const chunks: FullSessionTurnPayload[][] = [];
  let current: FullSessionTurnPayload[] = [];
  let currentChars = 0;

  for (const turn of turns) {
    const serialized = JSON.stringify(turn);
    if (current.length > 0 && currentChars + serialized.length > targetChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(turn);
    currentChars += serialized.length;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function buildFullSessionSystemPrompt(): string {
  return `You are auditing one AI coding-assistant session for the exact failures developers actually complain about: context rot, re-explaining the repo, pasting the same error again, scope creep, premium-model overspend on cheap tasks, dead attachments, and frustration spirals.
Use only the JSON evidence. Every claim must tie back to prompt text, assistant output, token metrics, timestamps, model choice, or the diagnostics block.

Return ONLY a valid JSON object matching this exact schema:
{
  "executiveSummary": "One sharp paragraph on velocity, waste, and what actually went wrong.",
  "overallVerdict": "Excellent" | "Good" | "Mixed" | "Wasteful",
  "sessionPersonality": "One paragraph naming this developer's prompting style in this session only.",
  "nextSessionBriefing": "A ready-to-paste context block, 150 words or fewer, with project context, current task, and hard constraints.",
  "promptBreakdown": [
    {
      "promptIndex": 1,
      "promptExcerpt": "Short excerpt",
      "clarityScore": 0-100,
      "tokenEfficiencyScore": 0-100,
      "diagnosis": "One sentence on why this prompt spent extra tokens or caused drift.",
      "rewrittenPrompt": "A shorter, clearer prompt that would likely get the same or better result."
    }
  ],
  "patternAnalysis": ["Specific pattern 1", "Specific pattern 2"],
  "contextManagementGrade": "A, A-, B+, ..., F",
  "contextManagementSummary": "Specific explanation grounded in the session data.",
  "modelChoiceAudit": "Specific explanation of where the model tier helped or wasted money.",
  "topActions": ["Action 1", "Action 2", "Action 3"],
  "tokenWasteEstimate": 1234,
  "tokenWasteBreakdown": ["1234 tokens from dead context ...", "456 tokens from repeated setup ..."]
}

Rules:
- Include every prompt in promptBreakdown in chronological order.
- rewrittenPrompt must be materially better, not a paraphrase with the same bloat.
- sessionPersonality must clearly name how this user works with the model in this session: over-explainer, terse corrector, error-loop debugger, etc.
- nextSessionBriefing must be immediately pasteable and include the project, the current objective, and any hard constraints or mistakes to avoid.
- tokenWasteEstimate must be a concrete integer grounded in dead context, repeated setup, repeated error pasting, scope creep history, frustration loops, and model mismatch evidence.
- Prefer the exact pattern names The Re-explainer, The Error Paster, The Scope Creeper, The Cheap Task Tax, The Dead Attachment, and The Frustration Spiral when the evidence supports them.
- Do not return generic coaching language like "be clearer" or "manage context better".`;
}

function buildChunkPromptSystemPrompt(): string {
  return `You are auditing one chunk of a larger AI coding-assistant session.
Use only the JSON evidence in this chunk and the diagnostics summary.

Return ONLY a valid JSON object matching this exact schema:
{
  "promptBreakdown": [
    {
      "promptIndex": 1,
      "promptExcerpt": "Short excerpt",
      "clarityScore": 0-100,
      "tokenEfficiencyScore": 0-100,
      "diagnosis": "One sentence on why this prompt spent extra tokens or caused drift.",
      "rewrittenPrompt": "A shorter, clearer prompt that preserves intent."
    }
  ],
  "chunkPatterns": ["Pattern seen in this chunk"],
  "chunkActions": ["Concrete action implied by this chunk"],
  "personalityNotes": ["What this chunk says about the developer's prompting style"]
}

Rules:
- Include every promptIndex in the chunk.
- rewrittenPrompt must be meaningfully shorter or more specific than the original.
- diagnosis must reference the actual failure in the original prompt, not generic advice.`;
}

function buildChunkSynthesisSystemPrompt(): string {
  return `You are merging chunk analyses from one full AI coding-assistant session.
The prompt-by-prompt rewrites are already provided. Your job is to synthesize the whole session.

Return ONLY a valid JSON object matching this exact schema:
{
  "executiveSummary": "One sharp paragraph on velocity, waste, and what actually went wrong.",
  "overallVerdict": "Excellent" | "Good" | "Mixed" | "Wasteful",
  "sessionPersonality": "One paragraph naming this developer's prompting style in this session only.",
  "nextSessionBriefing": "A ready-to-paste context block, 150 words or fewer, with project context, current task, and hard constraints.",
  "patternAnalysis": ["Specific pattern 1", "Specific pattern 2"],
  "contextManagementGrade": "A, A-, B+, ..., F",
  "contextManagementSummary": "Specific explanation grounded in the session data.",
  "modelChoiceAudit": "Specific explanation of where the model tier helped or wasted money.",
  "topActions": ["Action 1", "Action 2", "Action 3"],
  "tokenWasteEstimate": 1234,
  "tokenWasteBreakdown": ["1234 tokens from dead context ...", "456 tokens from repeated setup ..."]
}

Rules:
- Ground everything in the merged prompt breakdown plus diagnostics.
- Keep it sharp. No percentile scores. No generic filler.
- nextSessionBriefing must be pasteable immediately and include the project, the current objective, and any hard constraints or mistakes to avoid.`;
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
        <section>
          <div class="section-label">Why This Cost Extra</div>
          <div class="summary-copy">${escapeHtml(prompt.diagnosis)}</div>
        </section>
        <section>
          <div class="section-label">Rewritten Prompt</div>
          <div class="prompt-body prompt-rewrite">${escapeHtml(prompt.rewrittenPrompt)}</div>
        </section>
      </article>
    `;
  }).join('');

  const patternItems = report.patternAnalysis.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const actionItems = report.topActions.map((item, index) => `<li><span>${index + 1}</span>${escapeHtml(item)}</li>`).join('');
  const wasteItems = report.tokenWasteBreakdown.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
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
          <div class="eyebrow">Token Waste Estimate</div>
          <div class="hero-stat-value">${Math.round(report.tokenWasteEstimate).toLocaleString()}</div>
          <div class="hero-stat-note">Likely avoidable tokens from dead context, repeated setup, drift, or mismatched model spend. Generated ${escapeHtml(generatedAt)}.</div>
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
          <div class="section-label">Session Personality</div>
          <div class="summary-copy">${escapeHtml(report.sessionPersonality)}</div>
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
          <div class="section-label">Token Waste Breakdown</div>
          <ul>${wasteItems || '<li>No major avoidable waste patterns were detected.</li>'}</ul>
        </article>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">Next Session Briefing</div>
          <div class="section-note">Paste this at the top of the next chat instead of re-explaining the whole session.</div>
        </div>
      </div>
      <article class="panel">
        <div class="prompt-body">${escapeHtml(report.nextSessionBriefing)}</div>
      </article>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">Pattern Analysis</div>
          <div class="section-note">Only the patterns that showed up in this session, grounded in turns, spend, and context behavior.</div>
        </div>
      </div>
      <article class="panel">
        <ul>${patternItems}</ul>
        <div class="panel-copy">${escapeHtml(
    timeOfDay
      ? `${timeOfDay.label} has recently been your strongest work window, averaging ${Math.round(timeOfDay.averageEfficiencyScore)} / 100 efficiency across ${timeOfDay.sessions} sessions.`
      : 'There was not enough previous-session data to draw a strong cross-session comparison.'
  )}</div>
      </article>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <div class="section-title">Prompt-by-Prompt Breakdown</div>
          <div class="section-note">Each original prompt, the exact problem with it, and a sharper rewrite that should be cheaper to run.</div>
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
    const detail = buildCoachDetail(candidate);
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
      pattern: candidate.pattern,
      startedTurn: safeNumber(candidate.startedTurn),
      turnNumbers: Array.isArray(candidate.turnNumbers)
        ? candidate.turnNumbers.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
        : undefined,
      tokensSoFar: safeNumber(candidate.tokensSoFar),
      costUsdSoFar: safeNumber(candidate.costUsdSoFar),
      actionNow: typeof candidate.actionNow === 'string' ? candidate.actionNow.trim() : undefined,
    }];
  });
}

function sanitizeFullSessionReport(
  report: FullSessionAnalysisReport,
  prompts: Array<{ promptIndex: number; promptExcerpt: string }>,
  diagnostics: SessionDiagnostics,
  chat: ConversationChat
): FullSessionAnalysisReport {
  const promptLookup = new Map(prompts.map((prompt) => [prompt.promptIndex, prompt.promptExcerpt]));
  const fallbackBriefing = buildNextSessionBriefing(chat);
  const fallbackPersonality = buildFallbackSessionPersonality(chat, diagnostics);

  return {
    executiveSummary: safeString(
      report.executiveSummary,
      'This session has enough activity for analysis, but the report came back incomplete; the clearest problems were repeated context replay, prompt drift, or model mismatch.'
    ),
    overallVerdict: safeString(report.overallVerdict, 'Mixed'),
    sessionPersonality: safeString(report.sessionPersonality, fallbackPersonality),
    nextSessionBriefing: truncateWords(safeString(report.nextSessionBriefing, fallbackBriefing), 150),
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
        diagnosis: safeString(
          existing?.diagnosis,
          'The original prompt either carried avoidable setup, left the real constraint implicit, or bundled too many asks together.'
        ),
        rewrittenPrompt: safeString(
          existing?.rewrittenPrompt,
          promptLookup.get(prompt.promptIndex) ?? `Prompt ${index + 1}`
        ),
      };
    }),
    patternAnalysis: safeStringArray(
      report.patternAnalysis,
      'The session showed some avoidable replay or prompt drift, but the model response did not return a complete pattern list.'
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
    tokenWasteEstimate: safeInteger(report.tokenWasteEstimate, Math.round(diagnostics.tokenWaste.totalTokens)),
    tokenWasteBreakdown: safeStringArray(
      report.tokenWasteBreakdown,
      ...diagnostics.tokenWaste.breakdown.map((item) =>
        `${Math.round(item.tokens).toLocaleString()} tokens / ${formatUsd(item.costUsd)}: ${item.detail}`
      )
    ).slice(0, 6),
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

function safeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.round(value));
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildCoachDetail(candidate: Partial<CoachInsight>): string {
  if (typeof candidate.detail === 'string' && candidate.detail.trim()) {
    return candidate.detail.trim();
  }

  const summary = candidate && typeof (candidate as { summary?: unknown }).summary === 'string'
    ? ((candidate as { summary?: string }).summary ?? '').trim()
    : '';
  const startedTurn = safeNumber(candidate.startedTurn);
  const tokensSoFar = safeNumber(candidate.tokensSoFar);
  const costUsdSoFar = safeNumber(candidate.costUsdSoFar);
  const actionNow = typeof candidate.actionNow === 'string' ? candidate.actionNow.trim() : '';
  const turnNumbers = Array.isArray(candidate.turnNumbers)
    ? candidate.turnNumbers.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];

  const fragments = [
    summary,
    startedTurn ? `Started at turn ${startedTurn}.` : '',
    turnNumbers.length > 0 ? `Turns involved: ${turnNumbers.join(', ')}.` : '',
    tokensSoFar !== undefined || costUsdSoFar !== undefined
      ? `Estimated waste so far: ${tokensSoFar !== undefined ? `${Math.round(tokensSoFar).toLocaleString()} tokens` : 'unknown tokens'}${costUsdSoFar !== undefined ? ` / ${formatUsd(costUsdSoFar)}` : ''}.`
      : '',
    actionNow ? `Do now: ${actionNow}` : '',
  ].filter(Boolean);

  return fragments.join(' ');
}

function buildFallbackSessionPersonality(
  chat: ConversationChat,
  diagnostics: SessionDiagnostics
): string {
  const primaryIssue = diagnostics.issues[0]?.pattern;
  if (primaryIssue === 're-explainer') {
    return 'This session reads like an over-explaining collaborator: you front-load a lot of architecture and requirement context, then end up re-sending it when the chat drifts.';
  }
  if (primaryIssue === 'error-paster') {
    return 'This session reads like an error-loop debugger: once the first fix fails, you tend to paste the latest failure back into the same thread instead of forcing a new root-cause plan.';
  }
  if (primaryIssue === 'frustration-spiral') {
    return 'This session reads like a terse corrector: prompts get shorter and more corrective over time, which is usually a sign the thread is burning cycles instead of converging.';
  }

  const promptCount = chat.metrics?.promptCount ?? 0;
  if (promptCount >= 6) {
    return 'This session reads like a multitask collaborator: you use one thread for planning, debugging, editing, and follow-up corrections, which is powerful but expensive once the history starts replaying.';
  }

  return 'This session reads like a direct task-oriented collaborator: you are trying to move quickly, but the efficiency depends heavily on whether each prompt makes the objective and constraints explicit.';
}

function buildNextSessionBriefing(chat: ConversationChat): string {
  const prompts = chat.turns
    .filter((turn) => Boolean(turn.blocks['user-input'].content.trim()))
    .map((turn) => turn.blocks['user-input'].content.trim());
  const opening = prompts[0] ? summarizeText(prompts[0], 180) : summarizeText(chat.title || 'Untitled session', 120);
  const latest = prompts[prompts.length - 1] ? summarizeText(prompts[prompts.length - 1], 180) : 'Continue from the latest task in this session.';

  return truncateWords(
    `Working session: ${opening} Current task: ${latest} Assume the core project context has not changed unless I say it has. Keep the thread focused on one objective, call out if a cheaper model is enough, and when debugging give one root-cause hypothesis plus one verification step before proposing more edits.`,
    150
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function summarizeText(value: string, maxLength = 96): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return 'Untitled';
  }

  return truncate(singleLine, maxLength);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncateWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return value.trim();
  }

  return `${words.slice(0, maxWords).join(' ')}...`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 3)}`;
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
