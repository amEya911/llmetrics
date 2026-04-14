import {
  AgentSourceId,
  BreakdownRow,
  BudgetAlert,
  BudgetSettings,
  CoachInsight,
  ConversationChat,
  ConversationTurn,
  DashboardAnalytics,
  MonitorSnapshot,
  PromptSuggestion,
  RankedPrompt,
  RankedSession,
  SavedPrompt,
  SourceSnapshot,
  TimeboxMetrics,
  TrendPoint,
} from './types';

interface DashboardBuildOptions {
  app: MonitorSnapshot['app'];
  appLabel: string;
  sources: SourceSnapshot[];
  activeChatKey?: string;
  promptLibrary: SavedPrompt[];
  budgets: BudgetSettings;
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
  };
}

export function buildDashboardSnapshot(options: DashboardBuildOptions): MonitorSnapshot {
  const now = options.now ?? Date.now();
  const promptLibrary = [...options.promptLibrary]
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const sources = options.sources.map((source) => enrichSource(source));
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
    repeatedCounts
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
    generatedAt: now,
  };
}

function enrichSource(source: SourceSnapshot): SourceSnapshot {
  return {
    ...source,
    chats: source.chats
      .map((chat) => enrichChat(chat))
      .sort((left, right) => right.updatedAt - left.updatedAt),
  };
}

function enrichChat(chat: ConversationChat): ConversationChat {
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
  let sessionOutputTokens = 0;
  let sessionCostUsd = 0;

  for (const turn of turns) {
    const inputTokens = estimateTokens(turn.blocks['user-input'].content);
    const thinkingTokens = estimateTokens(turn.blocks['agent-thinking'].content);
    const outputTokens = estimateTokens(turn.blocks['agent-output'].content);
    const historyTokens = transcriptTokens;
    const paidInputTokens = inputTokens + historyTokens;
    const inputCostUsd = (inputTokens * profile.inputRateUsdPer1k) / 1000;
    const historyCostUsd = (historyTokens * profile.inputRateUsdPer1k) / 1000;
    const thinkingCostUsd = (thinkingTokens * profile.thinkingRateUsdPer1k) / 1000;
    const outputCostUsd = (outputTokens * profile.outputRateUsdPer1k) / 1000;
    const totalTokens = paidInputTokens + thinkingTokens + outputTokens;
    const costUsd = inputCostUsd + historyCostUsd + thinkingCostUsd + outputCostUsd;

    transcriptTokens += inputTokens + thinkingTokens + outputTokens;
    sessionInputTokens += inputTokens;
    sessionHistoryTokens += historyTokens;
    sessionThinkingTokens += thinkingTokens;
    sessionOutputTokens += outputTokens;
    sessionCostUsd += costUsd;

    turn.model = normalizeModelLabel(turn.model ?? model, chat.sourceId);
    turn.modelConfidence = turn.modelConfidence ?? chat.modelConfidence ?? 'unknown';
    turn.metrics = {
      inputTokens,
      historyTokens,
      thinkingTokens,
      outputTokens,
      inputCostUsd,
      historyCostUsd,
      thinkingCostUsd,
      outputCostUsd,
      totalTokens,
      costUsd,
      isEstimated: true,
    };
  }

  const metrics = {
    inputTokens: sessionInputTokens,
    historyTokens: sessionHistoryTokens,
    thinkingTokens: sessionThinkingTokens,
    outputTokens: sessionOutputTokens,
    totalTokens: sessionInputTokens + sessionHistoryTokens + sessionThinkingTokens + sessionOutputTokens,
    costUsd: sessionCostUsd,
    promptCount: turns.filter((turn) => Boolean(turn.blocks['user-input'].content.trim())).length,
    turnCount: turns.length,
    historyBloatRatio: sessionHistoryTokens > 0
      ? sessionHistoryTokens / Math.max(1, sessionInputTokens + sessionHistoryTokens)
      : 0,
  };

  let contextWindowTokens = chat.contextWindowTokens;
  if (!contextWindowTokens) {
    const usageFraction = (chat.contextUsagePercent ?? 0) / 100;
    const transcriptVisibleTokens = metrics.totalTokens - metrics.historyTokens;
    if (usageFraction > 0.01 && transcriptVisibleTokens > 0) {
      contextWindowTokens = Math.round(transcriptVisibleTokens / usageFraction);
    } else {
      contextWindowTokens = profile.contextWindowTokens;
    }
  }

  return {
    ...chat,
    model,
    modelConfidence: chat.modelConfidence ?? (chat.model ? 'inferred' : 'unknown'),
    contextWindowTokens,
    metrics,
    turns,
  };
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

        const suggestion = findSavedPromptSuggestion(text, promptLibrary);
        if (suggestion) {
          notes.push(`Saved prompt "${suggestion.title}" is close to this task.`);
          score -= 6;
        }

        turn.assessment = {
          score: clamp(Math.round(score), 25, 100),
          repeatedCount,
          notes,
          similarSavedPromptId: suggestion?.promptId,
        };
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
  repeatedCounts: Map<string, number>
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
  const coach = computeCoachInsights(promptRecords, activeChat, activeSuggestion, repeatedCounts);
  const bestValueModel = [...byModelRows]
    .filter((row) => row.costUsd > 0)
    .sort((left, right) => right.outputPerDollar - left.outputPerDollar)[0];

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
    coach,
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
  repeatedCounts: Map<string, number>
): CoachInsight[] {
  const candidates: Array<CoachInsight & { weight: number }> = [];

  if (activeChat?.contextUsagePercent !== undefined && activeChat.contextUsagePercent >= 82) {
    candidates.push({
      id: 'context-near-full',
      level: activeChat.contextUsagePercent >= 92 ? 'danger' : 'warn',
      title: `"${activeChat.title}" is nearly full`,
      detail: `${Math.round(activeChat.contextUsagePercent)}% of context is already used. The next turn will likely drag ~${formatTokenCount(activeChat.metrics?.historyTokens ?? 0)} history tokens back in.`,
      weight: activeChat.contextUsagePercent >= 92 ? 98 : 82,
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

  const worstRepeatedRecord = [...promptRecords]
    .map((record) => ({
      record,
      repeatedCount: repeatedCounts.get(record.key) ?? 1,
      wastedTokens: (record.turn.metrics?.inputTokens ?? 0) * Math.max(0, (repeatedCounts.get(record.key) ?? 1) - 1),
    }))
    .filter((item) => item.repeatedCount > 1)
    .sort((left, right) => {
      if (right.repeatedCount !== left.repeatedCount) {
        return right.repeatedCount - left.repeatedCount;
      }
      return right.wastedTokens - left.wastedTokens;
    })[0];

  if (worstRepeatedRecord) {
    candidates.push({
      id: 'repeated-prompts',
      level: worstRepeatedRecord.repeatedCount >= 4 ? 'danger' : 'warn',
      title: `Repeated prompt pattern: "${summarizePrompt(worstRepeatedRecord.record.text)}"`,
      detail: `Seen ${worstRepeatedRecord.repeatedCount} times already, burning roughly ${formatTokenCount(worstRepeatedRecord.wastedTokens)} duplicate input tokens.`,
      weight: worstRepeatedRecord.repeatedCount >= 4 ? 95 : 74,
    });
  }

  const codebaseLikeRecords = promptRecords.filter((record) => looksLikeCodebaseDump(record.text));
  if (codebaseLikeRecords.length >= 3) {
    const totalTokens = codebaseLikeRecords.reduce((sum, record) => sum + (record.turn.metrics?.inputTokens ?? 0), 0);
    candidates.push({
      id: 'codebase-brief',
      level: 'warn',
      title: 'You keep re-sending codebase setup',
      detail: `${codebaseLikeRecords.length} prompts look like repo/context setup, adding about ${formatTokenCount(totalTokens)} input tokens that could be saved into one reusable brief.`,
      weight: 72,
    });
  }

  if (activeSuggestion) {
    candidates.push({
      id: 'saved-prompt-match',
      level: 'success',
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

  return candidates
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 3)
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
