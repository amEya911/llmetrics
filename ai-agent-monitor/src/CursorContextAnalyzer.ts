import * as fs from 'fs';
import * as path from 'path';
import {
  ContextHealthScore,
  ContextReference,
  ConversationChat,
} from './types';

const REFERENCE_REGEX = /(^|\s)@([^\s,;:(){}\[\]<>]+)/g;
const MAX_REFERENCE_FILE_SIZE = 256 * 1024;

interface MutableReference extends ContextReference {
  searchTerms: string[];
}

export class CursorContextAnalyzer {
  private turnCount = 0;
  private historyBloatRatio = 0;
  private readonly references = new Map<string, MutableReference>();

  constructor(private readonly workspacePaths: string[] = []) {}

  analyzeUserPrompt(promptText: string, turnIndex: number): void {
    this.turnCount = Math.max(this.turnCount, turnIndex);

    for (const mention of extractMentions(promptText)) {
      const normalized = normalizeMention(mention);
      if (!normalized) {
        continue;
      }

      const existing = this.references.get(normalized);
      if (existing) {
        existing.mentionCount += 1;
        existing.lastMentionTurn = turnIndex;
        existing.mentionedTurns = [...new Set([...(existing.mentionedTurns ?? []), turnIndex])];
        continue;
      }

      this.references.set(normalized, buildReference(normalized, this.workspacePaths, turnIndex));
    }
  }

  analyzeOutput(agentOutput: string): void {
    if (!agentOutput.trim()) {
      return;
    }

    const haystack = agentOutput.toLowerCase();
    for (const reference of this.references.values()) {
      if (reference.referencedInResponse) {
        continue;
      }

      if (reference.searchTerms.some((term) => term.length > 1 && haystack.includes(term))) {
        reference.referencedInResponse = true;
      }
    }
  }

  setHistoryBloatRatio(historyBloatRatio: number): void {
    this.historyBloatRatio = Math.max(0, historyBloatRatio);
  }

  analyzeChat(chat: ConversationChat): ContextHealthScore {
    this.references.clear();
    this.turnCount = 0;
    this.historyBloatRatio = chat.metrics?.historyBloatRatio ?? 0;

    let promptIndex = 0;

    for (const turn of chat.turns) {
      if (turn.blocks['user-input'].content.trim()) {
        promptIndex += 1;
        this.analyzeUserPrompt(turn.blocks['user-input'].content, promptIndex);
      }
      this.analyzeOutput([
        turn.blocks['agent-thinking'].content,
        turn.blocks['agent-output'].content,
      ].join('\n'));
    }

    return this.getHealthScore();
  }

  getHealthScore(): ContextHealthScore {
    const deadReferences = [...this.references.values()]
      .filter((reference) => !reference.referencedInResponse)
      .sort((left, right) => right.tokenCountEstimate - left.tokenCountEstimate)
      .map(({ searchTerms: _searchTerms, ...reference }) => {
        const firstMentionTurn = reference.firstMentionTurn ?? 1;
        const estimatedReplayTurns = Math.max(0, this.turnCount - firstMentionTurn);
        return {
          ...reference,
          estimatedReplayTurns,
          estimatedReplayTokens: reference.tokenCountEstimate * estimatedReplayTurns,
        };
      });

    const deadWeightTokensPerTurn = deadReferences
      .reduce((sum, reference) => sum + reference.tokenCountEstimate, 0);
    const deadWeightTokensSoFar = deadReferences
      .reduce((sum, reference) => sum + (reference.estimatedReplayTokens ?? 0), 0);

    const warnings: string[] = [];
    let score = 100;

    if (this.turnCount > 10) {
      const overage = this.turnCount - 10;
      score -= Math.min(24, overage * 3);
      warnings.push('This session is long enough that replay cost is starting to compound.');
    }

    if (this.historyBloatRatio >= 0.32) {
      score -= Math.min(24, Math.round(this.historyBloatRatio * 36));
      warnings.push('A large share of prompt spend is going into old context instead of new work.');
    }

    if (deadWeightTokensPerTurn > 0) {
      score -= Math.min(30, Math.round(deadWeightTokensPerTurn / 450));
      warnings.push(`Unused @ references are likely replaying ~${Math.round(deadWeightTokensPerTurn).toLocaleString()} tokens every turn.`);
    }

    if (deadReferences.length >= 3) {
      score -= Math.min(12, deadReferences.length * 2);
    }

    return {
      score: Math.max(0, Math.min(100, score)),
      historyBloatRatio: this.historyBloatRatio,
      deadReferences,
      warnings,
      deadWeightTokensPerTurn,
      deadWeightTokensSoFar,
    };
  }
}

const contextHealthCache = new Map<string, { updatedAt: number; score: ContextHealthScore }>();

export function analyzeChatContext(
  chat: ConversationChat,
  workspacePaths: string[] = []
): ContextHealthScore {
  const cacheKey = chat.id;
  const cached = contextHealthCache.get(cacheKey);
  if (cached && cached.updatedAt === chat.updatedAt) {
    return cached.score;
  }

  const analyzer = new CursorContextAnalyzer(workspacePaths);
  const result = analyzer.analyzeChat(chat);
  
  contextHealthCache.set(cacheKey, { updatedAt: chat.updatedAt, score: result });
  if (contextHealthCache.size > 200) {
    const firstKey = contextHealthCache.keys().next().value;
    if (firstKey) contextHealthCache.delete(firstKey);
  }

  return result;
}

function extractMentions(text: string): string[] {
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = REFERENCE_REGEX.exec(text)) !== null) {
    mentions.push(match[2]);
  }

  return mentions;
}

function normalizeMention(value: string): string {
  return value
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .replace(/^["'`]+|["'`]+$/g, '');
}

function buildReference(
  mention: string,
  workspacePaths: string[],
  turnIndex: number
): MutableReference {
  const resolvedPath = resolveWorkspacePath(mention, workspacePaths);
  const stat = resolvedPath ? safeStat(resolvedPath) : undefined;
  const isDirectory = Boolean(stat?.isDirectory());
  const tokenCountEstimate = estimateReferenceTokens(resolvedPath, stat, mention);
  const searchTerms = [...new Set([
    mention.toLowerCase(),
    path.basename(mention).toLowerCase(),
    resolvedPath ? path.basename(resolvedPath).toLowerCase() : undefined,
  ].filter((value): value is string => Boolean(value)))];

  return {
    type: isDirectory ? 'folder' : 'file',
    name: mention,
    uri: resolvedPath,
    tokenCountEstimate,
    mentionCount: 1,
    referencedInResponse: false,
    firstMentionTurn: turnIndex,
    lastMentionTurn: turnIndex,
    mentionedTurns: [turnIndex],
    searchTerms,
  };
}

function resolveWorkspacePath(mention: string, workspacePaths: string[]): string | undefined {
  const trimmed = mention.trim();
  const directCandidates = trimmed.startsWith('/')
    ? [trimmed]
    : workspacePaths.flatMap((workspacePath) => [
        path.resolve(workspacePath, trimmed),
        path.join(workspacePath, trimmed),
      ]);

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function estimateReferenceTokens(
  resolvedPath: string | undefined,
  stat: fs.Stats | undefined,
  mention: string
): number {
  if (resolvedPath && stat?.isDirectory()) {
    return 1200;
  }

  if (resolvedPath && stat?.isFile()) {
    try {
      if (stat.size <= MAX_REFERENCE_FILE_SIZE) {
        const content = fs.readFileSync(resolvedPath, 'utf8');
        return estimateTokens(content);
      }
      return Math.max(64, Math.round(stat.size / 4));
    } catch {
      return Math.max(64, Math.round((stat.size || 0) / 4));
    }
  }

  return Math.max(48, mention.length * 12);
}

function estimateTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.round(normalized.length / 4));
}

function safeStat(targetPath: string): fs.Stats | undefined {
  try {
    return fs.statSync(targetPath);
  } catch {
    return undefined;
  }
}
