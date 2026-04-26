import {
  AgentSourceId,
  BreakdownRow,
  BudgetAlert,
  BudgetSettings,
  CoachInsight,
  CrossSessionPatterns,
  ConversationChat,
  ConversationTurn,
  DashboardAnalytics,
  MonitorSnapshot,
  PersistedSessionSummary,
  PromptComplexity,
  PromptSuggestion,
  RankedPrompt,
  RankedSession,
  SavedPrompt,
  SessionDiagnostics,
  SessionAnalysisState,
  SessionHealthTrendPoint,
  SourceSnapshot,
  TimeOfDayPattern,
  TimeboxMetrics,
  TrendPoint,
} from './types';
import { analyzeChatContext } from './CursorContextAnalyzer';
import { analyzeSessionDiagnostics, toCoachInsight } from './sessionDiagnostics';

interface DashboardBuildOptions {
  app: MonitorSnapshot['app'];
  appLabel: string;
  sources: SourceSnapshot[];
  activeChatKey?: string;
  promptLibrary: SavedPrompt[];
  budgets: BudgetSettings;
  hasGroqKey: boolean;
  groqInsights?: CoachInsight[];
  persistedSessions?: PersistedSessionSummary[];
  sessionAnalysis?: SessionAnalysisState;
  workspacePaths?: string[];
  now?: number;
}

interface ModelProfile {
  inputRateUsdPer1k: number;
  outputRateUsdPer1k: number;
  thinkingRateUsdPer1k: number;
  contextWindowTokens: number;
}

interface PromptRecord {
  key: string;
  sourceId: AgentSourceId;
  sourceLabel: string;
  chatId: string;
  turnId: string;
  text: string;
  words: Set<string>;
  turn: ConversationTurn;
  chat: ConversationChat;
}

interface CoachCandidate extends CoachInsight {
  weight: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 14;
const MAX_TOP_ITEMS = 6;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
  'for', 'from', 'has', 'have', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'please',
  'so', 'that', 'the', 'their', 'them', 'there', 'this', 'to',
  'us', 'we', 'with', 'you', 'your',
]);

export function createDefaultBudgets(): BudgetSettings {
  return {
    dailyCostUsd: null,
    monthlyCostUsd: null,
    dailyTokens: null,
    monthlyTokens: null,
  };
}

export function createEmptyAnalytics(): DashboardAnalytics {
  return {
    today: createEmptyTimebox(),
    week: createEmptyTimebox(),
    month: createEmptyTimebox(),
    byAgent: [],
    byModel: [],
    expensiveSessions: [],
    expensivePrompts: [],
    trend: [],
    coach: [],
    patterns: createEmptyCrossSessionPatterns(),
  };
}

function createEmptyCrossSessionPatterns(): CrossSessionPatterns {
  return {
    summaries: [],
    averageHealthTrend: [],
    expensivePromptPatterns: [],
    timeOfDay: [],
  };
}

export function buildDashboardSnapshot(options: DashboardBuildOptions): MonitorSnapshot {
  const now = options.now ?? Date.now();
  const promptLibrary = [...options.promptLibrary]
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const sources = options.sources.map((source) => enrichSource(source, options.workspacePaths ?? []));
  const promptRecords = collectPromptRecords(sources);
  const repeatedCounts = computeRepeatedPromptCounts(promptRecords);
  applyPromptAssessments(sources, promptRecords, repeatedCounts, promptLibrary);

  const activeChat = resolveActiveChat(sources, options.activeChatKey);
  const activeSuggestion = activeChat
    ? findSavedPromptSuggestion(getLatestPromptText(activeChat), promptLibrary)
    : undefined;

  const analytics = computeAnalytics(
    sources,
    promptRecords,
    now,
    activeChat,
    activeSuggestion,
    repeatedCounts,
    options.groqInsights,
    options.persistedSessions ?? []
  );
  const alerts = computeBudgetAlerts(options.budgets, analytics, now);

  return {
    app: options.app,
    appLabel: options.appLabel,
    sources,
    activeChat,
    activeSuggestion,
    analytics,
    promptLibrary,
    budgets: options.budgets,
    alerts,
    hasGroqKey: options.hasGroqKey,
    sessionAnalysis: options.sessionAnalysis ?? { isGenerating: false },
    generatedAt: now,
  };
}

export function createPersistedSessionSummary(chat: ConversationChat): PersistedSessionSummary | undefined {
  const metrics = chat.metrics;
  if (!metrics || metrics.promptCount <= 0) {
    return undefined;
  }

  const promptSummaries = chat.turns
    .filter((turn) => Boolean(turn.blocks['user-input'].content.trim()))
    .map((turn) => {
      const promptText = turn.blocks['user-input'].content.trim();
      return {
        promptText,
        promptPreview: summarizePrompt(promptText),
        promptSignature: createPromptSignature(promptText),
        inputTokens: turn.metrics?.inputTokens ?? estimateTokens(promptText),
        totalTokens: turn.metrics?.totalTokens ?? estimateTokens(promptText),
        costUsd: turn.metrics?.costUsd ?? 0,
        promptScore: turn.assessment?.score ?? 50,
        complexity: turn.assessment?.complexity ?? classifyPromptComplexity(
          promptText,
          turn.metrics?.inputTokens ?? estimateTokens(promptText)
        ),
      };
    });
  const averagePromptScore = promptSummaries.length > 0
    ? promptSummaries.reduce((sum, prompt) => sum + prompt.promptScore, 0) / promptSummaries.length
    : 0;
  const healthScore = metrics.healthScore ?? 100;

  return {
    id: `${chat.sourceId}:${chat.id}:${chat.updatedAt}`,
    sourceId: chat.sourceId,
    sourceLabel: chat.sourceLabel,
    chatId: chat.id,
    title: chat.title || 'Untitled session',
    model: chat.model ?? 'Unknown model',
    startedAt: chat.createdAt,
    endedAt: chat.updatedAt,
    healthScore,
    efficiencyScore: computeSessionEfficiencyScore(healthScore, averagePromptScore, metrics.historyBloatRatio),
    averagePromptScore,
    costUsd: metrics.costUsd,
    totalTokens: metrics.totalTokens,
    promptCount: metrics.promptCount,
    historyBloatRatio: metrics.historyBloatRatio,
    prompts: promptSummaries,
  };
}

function enrichSource(source: SourceSnapshot, workspacePaths: string[]): SourceSnapshot {
  return {
    ...source,
    chats: source.chats
      .map((chat) => enrichChat(chat, workspacePaths))
      .sort((left, right) => right.updatedAt - left.updatedAt),
  };
}

function enrichChat(chat: ConversationChat, workspacePaths: string[]): ConversationChat {
  const model = normalizeModelLabel(chat.model, chat.sourceId);
  const profile = resolveModelProfile(model, chat.sourceId);
  const turns = [...chat.turns]
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      return left.id.localeCompare(right.id);
    })
    .map((turn) => ({ ...turn }));

  let transcriptTokens = 0;
  let sessionInputTokens = 0;
  let sessionHistoryTokens = 0;
  let sessionThinkingTokens = 0;
  let sessionSubagentTokens = 0;
  let sessionEditorTokens = 0;
  let sessionOutputTokens = 0;
  let sessionCostUsd = 0;

  for (const turn of turns) {
    const inputTokens = estimateTokens(turn.blocks['user-input'].content);
    const thinkingTokens = resolveTurnTokenCount(
      turn,
      'thinkingTokens',
      turn.blocks['agent-thinking'].content
    );
    const subagentTokens = resolveTurnTokenCount(
      turn,
      'subagentTokens',
      turn.blocks['agent-subagent'].content
    );
    const editorTokens = resolveTurnTokenCount(
      turn,
      'editorTokens',
      turn.blocks['agent-editor'].content
    );
    const outputTokens = resolveTurnTokenCount(
      turn,
      'outputTokens',
      turn.blocks['agent-output'].content
    );
    const historyTokens = transcriptTokens;
    const paidInputTokens = inputTokens + historyTokens;
    const auxiliaryRateUsdPer1k = (profile.inputRateUsdPer1k + profile.outputRateUsdPer1k) / 2;
    const inputCostUsd = (inputTokens * profile.inputRateUsdPer1k) / 1000;
    const historyCostUsd = (historyTokens * profile.inputRateUsdPer1k) / 1000;
    const thinkingCostUsd = (thinkingTokens * profile.thinkingRateUsdPer1k) / 1000;
    const subagentCostUsd = (subagentTokens * auxiliaryRateUsdPer1k) / 1000;
    const editorCostUsd = (editorTokens * auxiliaryRateUsdPer1k) / 1000;
    const outputCostUsd = (outputTokens * profile.outputRateUsdPer1k) / 1000;
    const totalTokens = paidInputTokens + thinkingTokens + subagentTokens + editorTokens + outputTokens;
    const costUsd = inputCostUsd
      + historyCostUsd
      + thinkingCostUsd
      + subagentCostUsd
      + editorCostUsd
      + outputCostUsd;

    transcriptTokens += inputTokens + thinkingTokens + outputTokens;
    sessionInputTokens += inputTokens;
    sessionHistoryTokens += historyTokens;
    sessionThinkingTokens += thinkingTokens;
    sessionSubagentTokens += subagentTokens;
    sessionEditorTokens += editorTokens;
    sessionOutputTokens += outputTokens;
    sessionCostUsd += costUsd;

    turn.model = normalizeModelLabel(turn.model ?? model, chat.sourceId);
    turn.modelConfidence = turn.modelConfidence ?? chat.modelConfidence ?? 'unknown';
    turn.metrics = {
      inputTokens,
      historyTokens,
      thinkingTokens,
      subagentTokens,
      editorTokens,
      outputTokens,
      inputCostUsd,
      historyCostUsd,
      thinkingCostUsd,
      subagentCostUsd,
      editorCostUsd,
      outputCostUsd,
      totalTokens,
      costUsd,
      isEstimated: !turn.capturedTokenUsage,
    };
  }

  const historyBloatRatio = sessionHistoryTokens > 0
    ? sessionHistoryTokens / Math.max(1, sessionInputTokens + sessionHistoryTokens)
    : 0;

  const metrics = {
    inputTokens: sessionInputTokens,
    historyTokens: sessionHistoryTokens,
    thinkingTokens: sessionThinkingTokens,
    subagentTokens: sessionSubagentTokens,
    editorTokens: sessionEditorTokens,
    outputTokens: sessionOutputTokens,
    totalTokens: sessionInputTokens
      + sessionHistoryTokens
      + sessionThinkingTokens
      + sessionSubagentTokens
      + sessionEditorTokens
      + sessionOutputTokens,
    costUsd: sessionCostUsd,
    promptCount: turns.filter((turn) => Boolean(turn.blocks['user-input'].content.trim())).length,
    turnCount: turns.length,
    historyBloatRatio,
    healthScore: 100, // Will be overridden by rigorous analyzeChatContext below
  };

  let contextWindowTokens = chat.contextWindowTokens;
  if (!contextWindowTokens) {
    const usageFraction = (chat.contextUsagePercent ?? 0) / 100;
    const transcriptVisibleTokens = sessionInputTokens + sessionThinkingTokens + sessionOutputTokens;
    if (usageFraction > 0.01 && transcriptVisibleTokens > 0) {
      contextWindowTokens = Math.round(transcriptVisibleTokens / usageFraction);
    } else {
      contextWindowTokens = profile.contextWindowTokens;
    }
  }

  const enrichedChat = {
    ...chat,
    model,
    modelConfidence: chat.modelConfidence ?? (chat.model ? 'inferred' : 'unknown'),
    contextWindowTokens,
    metrics,
    turns,
  };

  const contextHealth = analyzeChatContext(enrichedChat, workspacePaths);
  enrichedChat.contextHealth = contextHealth;
  enrichedChat.metrics.healthScore = contextHealth.score;
  enrichedChat.metrics.historyBloatRatio = contextHealth.historyBloatRatio;

  return enrichedChat;
}

function resolveTurnTokenCount(
  turn: ConversationTurn,
  key: 'thinkingTokens' | 'subagentTokens' | 'editorTokens' | 'outputTokens',
  fallbackContent: string
): number {
  const capturedValue = turn.capturedTokenUsage?.[key];
  if (typeof capturedValue === 'number' && Number.isFinite(capturedValue) && capturedValue >= 0) {
    return capturedValue;
  }

  return estimateTokens(fallbackContent);
}

function collectPromptRecords(sources: SourceSnapshot[]): PromptRecord[] {
  const records: PromptRecord[] = [];

  for (const source of sources) {
    for (const chat of source.chats) {
      for (const turn of chat.turns) {
        const text = turn.blocks['user-input'].content.trim();
        if (!text) {
          continue;
        }

        records.push({
          key: `${source.id}:${chat.id}:${turn.id}`,
          sourceId: source.id,
          sourceLabel: source.label,
          chatId: chat.id,
          turnId: turn.id,
          text,
          words: tokenizePrompt(text),
          turn,
          chat,
        });
      }
    }
  }

  return records;
}

function computeRepeatedPromptCounts(records: PromptRecord[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const record of records) {
    counts.set(record.key, 1);
  }

  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const similarity = promptSimilarity(records[leftIndex].words, records[rightIndex].words);
      if (similarity < 0.72) {
        continue;
      }

      counts.set(records[leftIndex].key, (counts.get(records[leftIndex].key) ?? 1) + 1);
      counts.set(records[rightIndex].key, (counts.get(records[rightIndex].key) ?? 1) + 1);
    }
  }

  return counts;
}

function applyPromptAssessments(
  sources: SourceSnapshot[],
  records: PromptRecord[],
  repeatedCounts: Map<string, number>,
  promptLibrary: SavedPrompt[]
): void {
  const lookup = new Map(records.map((record) => [record.key, record]));

  for (const source of sources) {
    for (const chat of source.chats) {
      for (const turn of chat.turns) {
        const key = `${source.id}:${chat.id}:${turn.id}`;
        const record = lookup.get(key);
        const text = turn.blocks['user-input'].content.trim();
        if (!record || !text) {
          continue;
        }

        const repeatedCount = repeatedCounts.get(key) ?? 1;
        const notes: string[] = [];
        let score = 100;
        const wordCount = record.words.size;
        const tokenCount = turn.metrics?.inputTokens ?? estimateTokens(text);
        const complexity = classifyPromptComplexity(text, tokenCount);

        if (wordCount < 6) {
          notes.push('Very little task detail.');
          score -= 24;
        } else if (wordCount < 12) {
          notes.push('Could be more specific.');
          score -= 10;
        }

        if (tokenCount > 320) {
          notes.push('Likely over-explains context.');
          score -= 16;
        } else if (tokenCount > 180) {
          notes.push('Long prompt; trim repeated context if possible.');
          score -= 8;
        }

        if (repeatedCount > 1) {
          notes.push(`Similar to ${repeatedCount - 1} other prompts.`);
          score -= Math.min(28, repeatedCount * 6);
        }

        if (looksLikeCodebaseDump(text)) {
          notes.push('Reads like reusable project context.');
          score -= 12;
        }

        if (complexity === 'reasoning-heavy') {
          notes.push('This is a high-reasoning task, so precision in constraints matters.');
        } else if (complexity === 'trivial') {
          notes.push('Simple enough that a cheaper fast model would probably handle it.');
        }

        const suggestion = findSavedPromptSuggestion(text, promptLibrary);
        if (suggestion) {
          notes.push(`Saved prompt "${suggestion.title}" is close to this task.`);
          score -= 6;
        }

        turn.assessment = {
          score: clamp(Math.round(score), 25, 100),
          repeatedCount,
          notes,
          complexity,
          similarSavedPromptId: suggestion?.promptId,
        };
        turn.modelRecommendation = buildModelRecommendation(
          text,
          turn.model ?? chat.model ?? 'Unknown model',
          chat.sourceId,
          tokenCount,
          turn.metrics?.outputTokens ?? 0
        );
      }
    }
  }
}

function resolveActiveChat(
  sources: SourceSnapshot[],
  activeChatKey?: string
): ConversationChat | undefined {
  if (activeChatKey) {
    for (const source of sources) {
      for (const chat of source.chats) {
        if (`${source.id}:${chat.id}` === activeChatKey) {
          return chat;
        }
      }
    }
  }

  const selectedChats = sources
    .map((source) => source.chats.find((chat) => chat.id === source.selectedChatId))
    .filter((chat): chat is ConversationChat => Boolean(chat));

  if (selectedChats.length > 0) {
    return [...selectedChats].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  return sources
    .flatMap((source) => source.chats)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function computeAnalytics(
  sources: SourceSnapshot[],
  promptRecords: PromptRecord[],
  now: number,
  activeChat: ConversationChat | undefined,
  activeSuggestion: PromptSuggestion | undefined,
  repeatedCounts: Map<string, number>,
  groqInsights: CoachInsight[] | undefined,
  persistedSessions: PersistedSessionSummary[]
): DashboardAnalytics {
  const dayStart = startOfLocalDay(now);
  const weekStart = startOfLocalDay(now - ((new Date(now).getDay() + 6) % 7) * DAY_MS);
  const monthStart = startOfLocalMonth(now);
  const trendStart = startOfLocalDay(now - (TREND_DAYS - 1) * DAY_MS);

  const today = createEmptyTimebox();
  const week = createEmptyTimebox();
  const month = createEmptyTimebox();

  const sessionRows: RankedSession[] = [];
  const promptRows: RankedPrompt[] = [];
  const byAgent = new Map<string, MutableBreakdown>();
  const byModel = new Map<string, MutableBreakdown>();
  const trend = new Map<number, TrendPoint>();

  const sessionsToday = new Set<string>();
  const sessionsWeek = new Set<string>();
  const sessionsMonth = new Set<string>();

  for (const source of sources) {
    for (const chat of source.chats) {
      const sessionKey = `${source.id}:${chat.id}`;

      if (chat.metrics && chat.metrics.totalTokens > 0) {
        sessionRows.push({
          sourceId: source.id,
          sourceLabel: source.label,
          chatId: chat.id,
          title: chat.title || 'Untitled session',
          model: chat.model ?? 'Unknown model',
          costUsd: chat.metrics.costUsd,
          totalTokens: chat.metrics.totalTokens,
          updatedAt: chat.updatedAt,
          contextUsagePercent: chat.contextUsagePercent,
        });
      }

      for (const turn of chat.turns) {
        const metrics = turn.metrics;
        if (!metrics) {
          continue;
        }

        const promptPreview = summarizePrompt(turn.blocks['user-input'].content);
        promptRows.push({
          sourceId: source.id,
          sourceLabel: source.label,
          chatId: chat.id,
          turnId: turn.id,
          promptPreview,
          model: turn.model ?? chat.model ?? 'Unknown model',
          costUsd: metrics.costUsd,
          totalTokens: metrics.totalTokens,
          updatedAt: turn.updatedAt,
          score: turn.assessment?.score ?? 0,
        });

        updateBreakdown(byAgent, source.label, metrics, chat);
        updateBreakdown(byModel, turn.model ?? chat.model ?? 'Unknown model', metrics, chat);

        if (turn.updatedAt >= monthStart) {
          accumulateTimebox(month, metrics, sessionKey, sessionsMonth);
        }
        if (turn.updatedAt >= weekStart) {
          accumulateTimebox(week, metrics, sessionKey, sessionsWeek);
        }
        if (turn.updatedAt >= dayStart) {
          accumulateTimebox(today, metrics, sessionKey, sessionsToday);
        }

        if (turn.updatedAt >= trendStart) {
          const bucket = startOfLocalDay(turn.updatedAt);
          const point = trend.get(bucket) ?? {
            timestamp: bucket,
            label: formatTrendLabel(bucket),
            tokens: 0,
            costUsd: 0,
          };
          point.tokens += metrics.totalTokens;
          point.costUsd += metrics.costUsd;
          trend.set(bucket, point);
        }
      }
    }
  }

  const byAgentRows = finalizeBreakdown(byAgent);
  const byModelRows = finalizeBreakdown(byModel);
  const activeDiagnostics = activeChat ? analyzeSessionDiagnostics(activeChat) : undefined;
  const coach = computeCoachInsights(
    promptRecords,
    activeChat,
    activeSuggestion,
    repeatedCounts,
    groqInsights,
    activeDiagnostics
  );
  const bestValueModel = [...byModelRows]
    .filter((row) => row.costUsd > 0)
    .sort((left, right) => right.outputPerDollar - left.outputPerDollar)[0];
  const patterns = computeCrossSessionPatterns(persistedSessions);

  return {
    today,
    week,
    month,
    byAgent: byAgentRows,
    byModel: byModelRows,
    expensiveSessions: sessionRows
      .sort((left, right) => right.costUsd - left.costUsd)
      .slice(0, MAX_TOP_ITEMS),
    expensivePrompts: promptRows
      .sort((left, right) => right.costUsd - left.costUsd)
      .slice(0, MAX_TOP_ITEMS),
    trend: buildTrendSeries(trend, trendStart, now),
    bestValueModel,
    primaryCoachInsight: coach[0],
    coach,
    patterns,
  };
}

function computeBudgetAlerts(
  budgets: BudgetSettings,
  analytics: DashboardAnalytics,
  now: number
): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];

  pushBudgetAlert(alerts, 'daily-cost', 'Daily cost', analytics.today.costUsd, budgets.dailyCostUsd, '$');
  pushBudgetAlert(alerts, 'monthly-cost', 'Monthly cost', analytics.month.costUsd, budgets.monthlyCostUsd, '$');
  pushBudgetAlert(alerts, 'daily-tokens', 'Daily tokens', analytics.today.tokens, budgets.dailyTokens, '');
  pushBudgetAlert(alerts, 'monthly-tokens', 'Monthly tokens', analytics.month.tokens, budgets.monthlyTokens, '');

  if (budgets.monthlyCostUsd && analytics.month.costUsd > 0) {
    const dayOfMonth = Math.max(1, new Date(now).getDate());
    const dailyRunRate = analytics.month.costUsd / dayOfMonth;
    if (dailyRunRate > 0) {
      const remainingBudget = budgets.monthlyCostUsd - analytics.month.costUsd;
      const daysToHit = remainingBudget > 0
        ? Math.ceil(remainingBudget / dailyRunRate)
        : 0;
      alerts.push({
        id: 'monthly-cost-projection',
        level: remainingBudget <= 0 ? 'critical' : daysToHit <= 7 ? 'warn' : 'info',
        title: 'Monthly projection',
        detail: remainingBudget <= 0
          ? 'You have already crossed this month’s cost budget.'
          : `At the current rate, you will hit the monthly cost budget in about ${daysToHit} day${daysToHit === 1 ? '' : 's'}.`,
        progress: Math.min(1.5, analytics.month.costUsd / budgets.monthlyCostUsd),
      });
    }
  }

  return alerts.sort((left, right) => right.progress - left.progress);
}

function computeCoachInsights(
  promptRecords: PromptRecord[],
  activeChat: ConversationChat | undefined,
  activeSuggestion: PromptSuggestion | undefined,
  repeatedCounts: Map<string, number>,
  groqInsights: CoachInsight[] | undefined,
  diagnostics: SessionDiagnostics | undefined
): CoachInsight[] {
  const candidates: CoachCandidate[] = [];

  for (const issue of diagnostics?.issues ?? []) {
    const insight = toCoachInsight(issue);
    candidates.push({
      ...insight,
      weight: issue.level === 'danger'
        ? 120 + Math.round(issue.costUsdSoFar * 100)
        : 96 + Math.round(issue.costUsdSoFar * 100),
    });
  }

  if (activeChat?.contextUsagePercent !== undefined && activeChat.contextUsagePercent >= 82) {
    candidates.push({
      id: 'context-near-full',
      level: activeChat.contextUsagePercent >= 92 ? 'danger' : 'warn',
      title: `"${activeChat.title}" is nearly full`,
      detail: `${Math.round(activeChat.contextUsagePercent)}% of context is already used. The next turn will likely drag ~${formatTokenCount(activeChat.metrics?.historyTokens ?? 0)} history tokens back in.`,
      weight: activeChat.contextUsagePercent >= 92 ? 98 : 82,
    });
  }

  const deadReferences = activeChat?.contextHealth?.deadReferences ?? [];
  if (deadReferences.length > 0 && activeChat?.contextHealth) {
    const heaviestDeadWeight = deadReferences[0];
    candidates.push({
      id: 'dead-context',
      level: activeChat.contextHealth.deadWeightTokensPerTurn >= 1800 ? 'danger' : 'warn',
      title: `Dead context detected: @${heaviestDeadWeight.name}`,
      detail: `${deadReferences.length} attached reference${deadReferences.length === 1 ? '' : 's'} never showed up in the assistant response path, likely replaying about ${formatTokenCount(activeChat.contextHealth.deadWeightTokensPerTurn)} tokens every turn.`,
      weight: activeChat.contextHealth.deadWeightTokensPerTurn >= 1800 ? 97 : 80,
    });
  }

  if (activeChat?.metrics && activeChat.metrics.historyBloatRatio >= 0.32) {
    const historyTokens = activeChat.metrics.historyTokens;
    const ratio = Math.round(activeChat.metrics.historyBloatRatio * 100);
    candidates.push({
      id: 'history-bloat',
      level: activeChat.metrics.historyBloatRatio >= 0.5 ? 'danger' : 'warn',
      title: `"${activeChat.title}" is paying for old context`,
      detail: `${ratio}% of this session’s input spend is history replay, or about ${formatTokenCount(historyTokens)} tokens.`,
      weight: activeChat.metrics.historyBloatRatio >= 0.5 ? 96 : 78,
    });
  }

  if (activeSuggestion) {
    candidates.push({
      id: 'saved-prompt-match',
      level: 'info',
      title: `Saved prompt match: "${activeSuggestion.title}"`,
      detail: `${Math.round(activeSuggestion.similarity * 100)}% similar to the current task. Reusing it would cut prompt setup time immediately.`,
      weight: 48,
    });
  }

  if (activeChat?.metrics && activeChat.metrics.promptCount >= 8 && activeChat.metrics.historyBloatRatio >= 0.28) {
    candidates.push({
      id: 'fresh-chat',
      level: 'warn',
      title: `Fresh chat recommended for "${activeChat.title}"`,
      detail: `${activeChat.metrics.promptCount} prompts are already stacked in this session. Starting fresh would stop another ${formatTokenCount(activeChat.metrics.historyTokens)} tokens from rolling forward.`,
      weight: 70,
    });
  }

  for (const insight of groqInsights ?? []) {
    const isDuplicate = candidates.some((candidate) =>
      candidate.pattern && insight.pattern
        ? candidate.pattern === insight.pattern
        : candidate.title === insight.title
    );
    if (isDuplicate) {
      continue;
    }

    candidates.push({
      ...insight,
      level: insight.level === 'info' ? 'info' : insight.level,
      weight: insight.level === 'danger'
        ? 88
        : insight.level === 'warn'
          ? 68
          : 40,
    });
  }

  return candidates
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 5)
    .map(({ weight: _weight, ...insight }) => insight);
}

function findSavedPromptSuggestion(
  promptText: string | undefined,
  promptLibrary: SavedPrompt[]
): PromptSuggestion | undefined {
  const normalized = promptText?.trim();
  if (!normalized) {
    return undefined;
  }

  const words = tokenizePrompt(normalized);
  let bestMatch: PromptSuggestion | undefined;

  for (const savedPrompt of promptLibrary) {
    const similarity = promptSimilarity(words, tokenizePrompt(savedPrompt.content));
    if (similarity < 0.62) {
      continue;
    }

    if (!bestMatch || similarity > bestMatch.similarity) {
      bestMatch = {
        promptId: savedPrompt.id,
        title: savedPrompt.title,
        similarity,
      };
    }
  }

  return bestMatch;
}

function getLatestPromptText(chat: ConversationChat): string | undefined {
  for (let index = chat.turns.length - 1; index >= 0; index -= 1) {
    const value = chat.turns[index].blocks['user-input'].content.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function estimateTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.round(normalized.length / 4));
}

function normalizeModelLabel(model: string | undefined, sourceId: AgentSourceId): string {
  const normalized = (model ?? '').trim();
  if (!normalized) {
    return sourceId === 'cursor'
      ? 'Cursor Auto'
      : sourceId === 'antigravity'
        ? 'Antigravity'
        : 'Unknown model';
  }

  const compact = normalized.toLowerCase();
  if (compact === 'default') {
    return sourceId === 'cursor' ? 'Auto' : 'Default';
  }

  return normalized
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bO(\d)\b/g, 'o$1')
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bCodex\b/g, 'Codex')
    .replace(/\bKimi\b/g, 'Kimi');
}

function resolveModelProfile(model: string | undefined, sourceId: AgentSourceId): ModelProfile {
  const normalized = (model ?? '').toLowerCase();

  if (normalized.includes('composer 2') || normalized.includes('composer-2') || normalized.includes('cursor auto') || normalized === 'auto') {
    return {
      inputRateUsdPer1k: 0.003,
      outputRateUsdPer1k: 0.015,
      thinkingRateUsdPer1k: 0.015,
      contextWindowTokens: 200_000,
    };
  }

  if (normalized.includes('claude') || normalized.includes('sonnet') || normalized.includes('opus')) {
    return {
      inputRateUsdPer1k: normalized.includes('opus') ? 0.015 : 0.003,
      outputRateUsdPer1k: normalized.includes('opus') ? 0.075 : 0.015,
      thinkingRateUsdPer1k: normalized.includes('opus') ? 0.075 : 0.015,
      contextWindowTokens: 200_000,
    };
  }

  if (normalized.includes('gpt-5') || normalized.includes('codex') || normalized.includes('gpt 5')) {
    return {
      inputRateUsdPer1k: 0.003,
      outputRateUsdPer1k: 0.012,
      thinkingRateUsdPer1k: 0.012,
      contextWindowTokens: 256_000,
    };
  }

  if (normalized.includes('gpt-4o') || normalized.includes('gpt 4o') || normalized.includes('gpt-4.1') || normalized.includes('gpt 4.1')) {
    return {
      inputRateUsdPer1k: 0.0025,
      outputRateUsdPer1k: 0.01,
      thinkingRateUsdPer1k: 0.01,
      contextWindowTokens: 128_000,
    };
  }

  if (normalized.includes('gemini 2.5 pro') || normalized.includes('gemini-2.5-pro')) {
    return {
      inputRateUsdPer1k: 0.00125,
      outputRateUsdPer1k: 0.01,
      thinkingRateUsdPer1k: 0.01,
      contextWindowTokens: 1_000_000,
    };
  }

  if (normalized.includes('gemini 2.5 flash') || normalized.includes('gemini-2.5-flash') || normalized.includes('gemini 2.0 flash')) {
    return {
      inputRateUsdPer1k: 0.0003,
      outputRateUsdPer1k: 0.0025,
      thinkingRateUsdPer1k: 0.0025,
      contextWindowTokens: 1_000_000,
    };
  }

  return {
    inputRateUsdPer1k: sourceId === 'antigravity' ? 0.001 : 0.0025,
    outputRateUsdPer1k: sourceId === 'antigravity' ? 0.006 : 0.012,
    thinkingRateUsdPer1k: sourceId === 'antigravity' ? 0.006 : 0.012,
    contextWindowTokens: sourceId === 'antigravity' ? 1_000_000 : 128_000,
  };
}

function classifyPromptComplexity(value: string, tokenCount: number): PromptComplexity {
  const normalized = value.toLowerCase();

  if (
    /(root cause|why is|diagnose|architecture|system design|trade[- ]?off|reason about|investigate|full session|full project|entire project|every single file|compare approaches|migration plan|debug this deeply)/i.test(normalized)
    || tokenCount >= 260
  ) {
    return 'reasoning-heavy';
  }

  if (
    /(implement|refactor|restructure|build|feature|multi[- ]step|end[- ]to[- ]end|database|authentication|streaming|analytics|dashboard|report|persist|cross[- ]session|monitor|integration|keyboard shortcut)/i.test(normalized)
    || tokenCount >= 140
  ) {
    return 'complex';
  }

  if (
    /(fix|update|explain|summarize|review|optimize|clean up|write tests|add tests|rename|convert|transform|format)/i.test(normalized)
    || tokenCount >= 55
  ) {
    return 'moderate';
  }

  return 'trivial';
}

function buildModelRecommendation(
  promptText: string,
  currentModel: string,
  sourceId: AgentSourceId,
  inputTokens: number,
  outputTokens: number
) {
  const complexity = classifyPromptComplexity(promptText, inputTokens);
  const currentTier = resolveModelTier(currentModel);
  const recommendation = getRecommendedModelTarget(complexity, sourceId);

  if (currentTier <= recommendation.maxTier) {
    return undefined;
  }

  const currentProfile = resolveModelProfile(currentModel, sourceId);
  const estimatedOutputTokens = outputTokens > 0
    ? outputTokens
    : Math.max(
        120,
        Math.round(
          inputTokens * (
            complexity === 'trivial'
              ? 1.4
              : complexity === 'moderate'
                ? 2.1
                : complexity === 'complex'
                  ? 3.1
                  : 4.2
          )
        )
      );
  const currentCost = estimateProjectedTurnCost(currentProfile, inputTokens, estimatedOutputTokens);
  const recommendedCost = estimateProjectedTurnCost(
    recommendation.profile,
    inputTokens,
    estimatedOutputTokens
  );
  const overspendUsd = Math.max(0, currentCost - recommendedCost);
  const overspendPct = recommendedCost > 0
    ? Math.round((overspendUsd / recommendedCost) * 100)
    : 0;

  return {
    complexity,
    currentModel,
    recommendedModel: recommendation.label,
    reason: recommendation.reason,
    estimatedOverspendUsd: overspendUsd,
    estimatedOverspendPct: overspendPct,
  };
}

function estimateProjectedTurnCost(
  profile: ModelProfile,
  inputTokens: number,
  outputTokens: number
): number {
  return ((inputTokens * profile.inputRateUsdPer1k) + (outputTokens * profile.outputRateUsdPer1k)) / 1000;
}

function resolveModelTier(model: string): number {
  const normalized = model.toLowerCase();

  if (/(flash|haiku|mini|nano)/i.test(normalized)) {
    return 0;
  }

  if (/(opus|gpt-5|gpt 5|o1|o3|gemini 2\.5 pro|gemini-2\.5-pro)/i.test(normalized)) {
    return 3;
  }

  if (/(sonnet|gpt-4o|gpt 4o|gpt-4\.1|gpt 4\.1|codex|cursor auto|auto|gemini)/i.test(normalized)) {
    return 1;
  }

  return 1;
}

function getRecommendedModelTarget(complexity: PromptComplexity, sourceId: AgentSourceId) {
  switch (complexity) {
    case 'trivial':
      return {
        label: 'Gemini Flash or Claude Haiku',
        maxTier: 0,
        profile: resolveModelProfile(sourceId === 'antigravity' ? 'Gemini Flash' : 'Claude Haiku', sourceId),
        reason: 'This looks like a light transformation task, so a fast low-cost model should be enough.',
      };
    case 'moderate':
      return {
        label: 'Claude Sonnet or GPT-4.1',
        maxTier: 1,
        profile: resolveModelProfile('Claude Sonnet', sourceId),
        reason: 'This task needs solid coding reliability, but not top-tier reasoning spend.',
      };
    case 'complex':
      return {
        label: 'Claude Sonnet, Codex, or Cursor Auto',
        maxTier: 1,
        profile: resolveModelProfile('Claude Sonnet', sourceId),
        reason: 'A strong coding model is warranted here, but premium reasoning pricing is probably unnecessary.',
      };
    case 'reasoning-heavy':
      return {
        label: 'Claude Opus, GPT-5, or Gemini 2.5 Pro',
        maxTier: 3,
        profile: resolveModelProfile('Claude Opus', sourceId),
        reason: 'This prompt is genuinely high-context or high-reasoning.',
      };
  }
}

function promptSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const word of left) {
    if (right.has(word)) {
      intersection += 1;
    }
  }

  return intersection / Math.max(left.size, right.size);
}

function createPromptSignature(value: string): string {
  const tokens = [...tokenizePrompt(value)].slice(0, 6);
  if (tokens.length > 0) {
    return tokens.join(' ');
  }

  return summarizePrompt(value).toLowerCase();
}

function tokenizePrompt(value: string): Set<string> {
  const words = value
    .toLowerCase()
    .replace(/[`"'()[\]{}:;,.!?/\\]+/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

  return new Set(words);
}

function looksLikeCodebaseDump(value: string): boolean {
  return /(codebase|entire repo|whole repo|all files|entire project|full project|every file|repository context|repo context)/i.test(value);
}

function summarizePrompt(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return 'Untitled prompt';
  }

  return singleLine.length <= 96
    ? singleLine
    : `${singleLine.slice(0, 93).trimEnd()}...`;
}

function computeSessionEfficiencyScore(
  healthScore: number,
  averagePromptScore: number,
  historyBloatRatio: number
): number {
  return clamp(
    Math.round(
      (healthScore * 0.5)
      + (averagePromptScore * 0.35)
      + ((1 - Math.min(1, historyBloatRatio)) * 100 * 0.15)
    ),
    0,
    100
  );
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfLocalMonth(timestamp: number): number {
  const date = new Date(timestamp);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatTrendLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
}

function createEmptyTimebox(): TimeboxMetrics {
  return {
    tokens: 0,
    costUsd: 0,
    prompts: 0,
    sessions: 0,
  };
}

function accumulateTimebox(
  target: TimeboxMetrics,
  metrics: NonNullable<ConversationTurn['metrics']>,
  sessionKey: string,
  sessions: Set<string>
): void {
  target.tokens += metrics.totalTokens;
  target.costUsd += metrics.costUsd;
  target.prompts += 1;
  sessions.add(sessionKey);
  target.sessions = sessions.size;
}

interface MutableBreakdown {
  label: string;
  tokens: number;
  costUsd: number;
  sessions: Set<string>;
  prompts: number;
  outputTokens: number;
}

function updateBreakdown(
  bucket: Map<string, MutableBreakdown>,
  label: string,
  metrics: NonNullable<ConversationTurn['metrics']>,
  chat: ConversationChat
): void {
  const entry = bucket.get(label) ?? {
    label,
    tokens: 0,
    costUsd: 0,
    sessions: new Set<string>(),
    prompts: 0,
    outputTokens: 0,
  };
  entry.tokens += metrics.totalTokens;
  entry.costUsd += metrics.costUsd;
  entry.prompts += 1;
  entry.outputTokens += metrics.outputTokens;
  entry.sessions.add(`${chat.sourceId}:${chat.id}`);
  bucket.set(label, entry);
}

function finalizeBreakdown(bucket: Map<string, MutableBreakdown>): BreakdownRow[] {
  const totalCostUsd = [...bucket.values()]
    .reduce((sum, item) => sum + item.costUsd, 0);
  const totalOutputTokens = [...bucket.values()]
    .reduce((sum, item) => sum + item.outputTokens, 0);
  const maxOutputPerDollar = [...bucket.values()]
    .reduce((max, item) => Math.max(max, item.costUsd > 0 ? item.outputTokens / item.costUsd : 0), 0);

  return [...bucket.values()]
    .map((item) => ({
      label: item.label,
      tokens: item.tokens,
      costUsd: item.costUsd,
      sessions: item.sessions.size,
      prompts: item.prompts,
      outputPerDollar: item.costUsd > 0 ? item.outputTokens / item.costUsd : 0,
      outputShare: totalOutputTokens > 0 ? item.outputTokens / totalOutputTokens : 0,
      costShare: totalCostUsd > 0 ? item.costUsd / totalCostUsd : 0,
      costPer1kTokens: item.tokens > 0 ? (item.costUsd / item.tokens) * 1000 : 0,
      efficiencyScore: maxOutputPerDollar > 0
        ? Math.round(((item.costUsd > 0 ? item.outputTokens / item.costUsd : 0) / maxOutputPerDollar) * 100)
        : 0,
    }))
    .sort((left, right) => right.costUsd - left.costUsd);
}

function buildTrendSeries(
  trend: Map<number, TrendPoint>,
  start: number,
  now: number
): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (let timestamp = startOfLocalDay(start); timestamp <= startOfLocalDay(now); timestamp += DAY_MS) {
    points.push(
      trend.get(timestamp) ?? {
        timestamp,
        label: formatTrendLabel(timestamp),
        tokens: 0,
        costUsd: 0,
      }
    );
  }

  return points;
}

function computeCrossSessionPatterns(
  summaries: PersistedSessionSummary[]
): CrossSessionPatterns {
  const recent = [...summaries]
    .sort((left, right) => right.endedAt - left.endedAt)
    .slice(0, 10);

  if (recent.length === 0) {
    return createEmptyCrossSessionPatterns();
  }

  const averageHealthTrend: SessionHealthTrendPoint[] = [...recent]
    .sort((left, right) => left.endedAt - right.endedAt)
    .map((summary) => ({
      timestamp: summary.endedAt,
      label: formatTrendLabel(summary.endedAt),
      healthScore: summary.healthScore,
      efficiencyScore: summary.efficiencyScore,
    }));

  const promptPatterns = new Map<string, {
    label: string;
    totalCostUsd: number;
    prompts: number;
    sessions: Set<string>;
  }>();
  const timeOfDay = new Map<string, {
    label: string;
    totalHealthScore: number;
    totalEfficiencyScore: number;
    totalCostUsd: number;
    sessions: number;
  }>();

  for (const summary of recent) {
    for (const prompt of summary.prompts) {
      const pattern = promptPatterns.get(prompt.promptSignature) ?? {
        label: prompt.promptPreview,
        totalCostUsd: 0,
        prompts: 0,
        sessions: new Set<string>(),
      };
      pattern.totalCostUsd += prompt.costUsd;
      pattern.prompts += 1;
      pattern.sessions.add(summary.id);
      promptPatterns.set(prompt.promptSignature, pattern);
    }

    const bucketLabel = timeOfDayLabel(summary.startedAt);
    const bucket = timeOfDay.get(bucketLabel) ?? {
      label: bucketLabel,
      totalHealthScore: 0,
      totalEfficiencyScore: 0,
      totalCostUsd: 0,
      sessions: 0,
    };
    bucket.totalHealthScore += summary.healthScore;
    bucket.totalEfficiencyScore += summary.efficiencyScore;
    bucket.totalCostUsd += summary.costUsd;
    bucket.sessions += 1;
    timeOfDay.set(bucketLabel, bucket);
  }

  const expensivePromptPatterns = [...promptPatterns.values()]
    .map((pattern) => ({
      label: pattern.label,
      averageCostUsd: pattern.prompts > 0 ? pattern.totalCostUsd / pattern.prompts : 0,
      totalCostUsd: pattern.totalCostUsd,
      prompts: pattern.prompts,
      sessions: pattern.sessions.size,
    }))
    .sort((left, right) => right.totalCostUsd - left.totalCostUsd)
    .slice(0, 5);

  const timeOfDayRows: TimeOfDayPattern[] = [...timeOfDay.values()]
    .map((bucket) => ({
      label: bucket.label,
      averageHealthScore: bucket.sessions > 0 ? bucket.totalHealthScore / bucket.sessions : 0,
      averageEfficiencyScore: bucket.sessions > 0 ? bucket.totalEfficiencyScore / bucket.sessions : 0,
      averageCostUsd: bucket.sessions > 0 ? bucket.totalCostUsd / bucket.sessions : 0,
      sessions: bucket.sessions,
    }))
    .sort((left, right) => right.averageEfficiencyScore - left.averageEfficiencyScore);

  const byEfficiency = [...recent]
    .sort((left, right) => right.efficiencyScore - left.efficiencyScore);

  return {
    summaries: recent,
    averageHealthTrend,
    expensivePromptPatterns,
    bestSession: byEfficiency[0],
    worstSession: byEfficiency[byEfficiency.length - 1],
    timeOfDay: timeOfDayRows,
  };
}

function timeOfDayLabel(timestamp: number): string {
  const hour = new Date(timestamp).getHours();

  if (hour >= 5 && hour < 10) {
    return 'Morning';
  }
  if (hour >= 10 && hour < 14) {
    return 'Late Morning';
  }
  if (hour >= 14 && hour < 18) {
    return 'Afternoon';
  }
  if (hour >= 18 && hour < 23) {
    return 'Evening';
  }
  return 'Late Night';
}

function pushBudgetAlert(
  alerts: BudgetAlert[],
  id: string,
  label: string,
  used: number,
  budget: number | null,
  prefix: string
): void {
  if (!budget || budget <= 0) {
    return;
  }

  const progress = used / budget;
  if (progress < 0.8) {
    return;
  }

  const level = progress >= 1 ? 'critical' : progress >= 0.95 ? 'warn' : 'info';
  const remaining = Math.max(0, budget - used);
  const formatValue = prefix === '$'
    ? `${prefix}${used.toFixed(2)} / ${prefix}${budget.toFixed(2)}`
    : `${Math.round(used).toLocaleString()} / ${Math.round(budget).toLocaleString()}`;
  const remainingValue = prefix === '$'
    ? `${prefix}${remaining.toFixed(2)}`
    : `${Math.round(remaining).toLocaleString()} tokens`;

  alerts.push({
    id,
    level,
    title: `${label} budget ${progress >= 1 ? 'exceeded' : 'approaching limit'}`,
    detail: `${formatValue}. Remaining: ${remainingValue}.`,
    progress,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 0.1 ? 2 : 4)}`;
}
