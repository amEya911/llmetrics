export type HostApp = 'cursor' | 'antigravity' | 'unknown';

export type AgentSourceId = 'cursor' | 'antigravity' | 'manual';

export type BlockType = 'user-input' | 'agent-thinking' | 'agent-output';

export type CoachInsightLevel = 'danger' | 'warn' | 'info';

export type PromptComplexity = 'trivial' | 'moderate' | 'complex' | 'reasoning-heavy';

export const BLOCK_TYPES: readonly BlockType[] = [
  'user-input',
  'agent-thinking',
  'agent-output',
];

export type ModelConfidence = 'exact' | 'inferred' | 'unknown';

export interface ConversationSegment {
  content: string;
  isStreaming: boolean;
}

export interface TokenEstimate {
  inputTokens: number;
  historyTokens: number;
  thinkingTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  historyCostUsd: number;
  thinkingCostUsd: number;
  outputCostUsd: number;
  totalTokens: number;
  costUsd: number;
  isEstimated: boolean;
}

export interface ContextReference {
  type: 'file' | 'folder' | 'selection' | 'terminal' | 'documentation';
  name: string;
  uri?: string;
  tokenCountEstimate: number;
  mentionCount: number;
  referencedInResponse: boolean;
}

export interface ContextHealthScore {
  score: number;
  historyBloatRatio: number;
  deadReferences: ContextReference[];
  warnings: string[];
  deadWeightTokensPerTurn: number;
}

export interface ModelRecommendation {
  complexity: PromptComplexity;
  currentModel: string;
  recommendedModel: string;
  reason: string;
  estimatedOverspendUsd: number;
  estimatedOverspendPct: number;
}

export interface PromptAssessment {
  score: number;
  repeatedCount: number;
  notes: string[];
  complexity?: PromptComplexity;
  similarSavedPromptId?: string;
}

export interface SessionMetrics {
  inputTokens: number;
  historyTokens: number;
  thinkingTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  promptCount: number;
  turnCount: number;
  historyBloatRatio: number;
  healthScore?: number;
}

export interface ConversationTurn {
  id: string;
  createdAt: number;
  updatedAt: number;
  isComplete: boolean;
  blocks: Record<BlockType, ConversationSegment>;
  model?: string;
  modelConfidence?: ModelConfidence;
  metrics?: TokenEstimate;
  assessment?: PromptAssessment;
  modelRecommendation?: ModelRecommendation;
}

export interface ConversationChat {
  id: string;
  title: string;
  subtitle?: string;
  createdAt: number;
  updatedAt: number;
  turns: ConversationTurn[];
  isEphemeral?: boolean;
  sourceId: AgentSourceId;
  sourceLabel: string;
  model?: string;
  modelConfidence?: ModelConfidence;
  contextUsagePercent?: number;
  contextWindowTokens?: number;
  contextHealth?: ContextHealthScore;
  metrics?: SessionMetrics;
}

export interface ConversationCollection {
  chats: ConversationChat[];
  selectedChatId?: string;
}

export interface SourceSnapshot {
  id: AgentSourceId;
  label: string;
  chats: ConversationChat[];
  selectedChatId?: string;
}

export interface TimeboxMetrics {
  tokens: number;
  costUsd: number;
  prompts: number;
  sessions: number;
}

export interface BreakdownRow {
  label: string;
  tokens: number;
  costUsd: number;
  sessions: number;
  prompts: number;
  outputPerDollar: number;
  outputShare: number;
  costShare: number;
  costPer1kTokens: number;
  efficiencyScore: number;
}

export interface RankedSession {
  sourceId: AgentSourceId;
  sourceLabel: string;
  chatId: string;
  title: string;
  model: string;
  costUsd: number;
  totalTokens: number;
  updatedAt: number;
  contextUsagePercent?: number;
}

export interface RankedPrompt {
  sourceId: AgentSourceId;
  sourceLabel: string;
  chatId: string;
  turnId: string;
  promptPreview: string;
  model: string;
  costUsd: number;
  totalTokens: number;
  updatedAt: number;
  score: number;
}

export interface TrendPoint {
  timestamp: number;
  label: string;
  tokens: number;
  costUsd: number;
}

export interface CoachInsight {
  id: string;
  level: CoachInsightLevel;
  title: string;
  detail: string;
}

export interface SessionPromptSummary {
  promptText: string;
  promptPreview: string;
  promptSignature: string;
  inputTokens: number;
  totalTokens: number;
  costUsd: number;
  promptScore: number;
  complexity: PromptComplexity;
}

export interface PersistedSessionSummary {
  id: string;
  sourceId: AgentSourceId;
  sourceLabel: string;
  chatId: string;
  title: string;
  model: string;
  startedAt: number;
  endedAt: number;
  healthScore: number;
  efficiencyScore: number;
  averagePromptScore: number;
  costUsd: number;
  totalTokens: number;
  promptCount: number;
  historyBloatRatio: number;
  prompts: SessionPromptSummary[];
}

export interface SessionHealthTrendPoint {
  timestamp: number;
  label: string;
  healthScore: number;
  efficiencyScore: number;
}

export interface PromptPatternInsight {
  label: string;
  averageCostUsd: number;
  totalCostUsd: number;
  prompts: number;
  sessions: number;
}

export interface TimeOfDayPattern {
  label: string;
  averageHealthScore: number;
  averageEfficiencyScore: number;
  averageCostUsd: number;
  sessions: number;
}

export interface CrossSessionPatterns {
  summaries: PersistedSessionSummary[];
  averageHealthTrend: SessionHealthTrendPoint[];
  expensivePromptPatterns: PromptPatternInsight[];
  bestSession?: PersistedSessionSummary;
  worstSession?: PersistedSessionSummary;
  timeOfDay: TimeOfDayPattern[];
}

export interface SavedPrompt {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  sourceId?: AgentSourceId;
  sourceLabel?: string;
  model?: string;
  useCount: number;
  lastUsedAt?: number;
  efficiencyScore?: number;
}

export interface PromptSuggestion {
  promptId: string;
  title: string;
  similarity: number;
}

export interface BudgetSettings {
  dailyCostUsd: number | null;
  monthlyCostUsd: number | null;
  dailyTokens: number | null;
  monthlyTokens: number | null;
}

export interface BudgetAlert {
  id: string;
  level: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  progress: number;
}

export interface DashboardAnalytics {
  today: TimeboxMetrics;
  week: TimeboxMetrics;
  month: TimeboxMetrics;
  byAgent: BreakdownRow[];
  byModel: BreakdownRow[];
  expensiveSessions: RankedSession[];
  expensivePrompts: RankedPrompt[];
  trend: TrendPoint[];
  bestValueModel?: BreakdownRow;
  primaryCoachInsight?: CoachInsight;
  coach: CoachInsight[];
  patterns: CrossSessionPatterns;
}

export interface SessionAnalysisState {
  isGenerating: boolean;
  activeChatId?: string;
  lastGeneratedAt?: number;
  lastError?: string;
}

export interface MonitorSnapshot {
  app: HostApp;
  appLabel: string;
  sources: SourceSnapshot[];
  activeChat?: ConversationChat;
  activeSuggestion?: PromptSuggestion;
  analytics: DashboardAnalytics;
  promptLibrary: SavedPrompt[];
  budgets: BudgetSettings;
  alerts: BudgetAlert[];
  hasGroqKey: boolean;
  sessionAnalysis: SessionAnalysisState;
  generatedAt: number;
}

export interface MonitorMessage {
  type: BlockType;
  content: string;
  sourceLabel?: string;
  model?: string;
}

export interface MonitorStatus {
  status: 'connected' | 'disconnected' | 'monitoring';
  text: string;
}

export interface WebviewIncoming {
  command:
    | 'ready'
    | 'savePrompt'
    | 'copyPrompt'
    | 'deletePrompt'
    | 'markPromptUsed'
    | 'updateBudgets'
    | 'generateSessionAnalysis';
  promptId?: string;
  sourceId?: AgentSourceId;
  chatId?: string;
  turnId?: string;
  title?: string;
  tags?: string[];
  budgets?: BudgetSettings;
}

export interface WebviewOutgoing {
  command: 'sync' | 'clear' | 'setStatus';
  snapshot?: MonitorSnapshot;
  status?: MonitorStatus['status'];
  text?: string;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneTurn(turn: ConversationTurn): ConversationTurn {
  return cloneValue(turn);
}

export function cloneChat(chat: ConversationChat): ConversationChat {
  return cloneValue(chat);
}

export function cloneCollection(collection: ConversationCollection): ConversationCollection {
  return cloneValue(collection);
}

export function cloneSnapshot(snapshot: MonitorSnapshot): MonitorSnapshot {
  return cloneValue(snapshot);
}
