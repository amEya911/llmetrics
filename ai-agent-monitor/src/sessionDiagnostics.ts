import {
  CoachInsight,
  ConversationChat,
  ConversationTurn,
  PromptComplexity,
  SessionDiagnostics,
  SessionFailureInsight,
  SessionFailurePattern,
  TokenWasteBreakdown,
} from './types';

interface ErrorBlock {
  signature: string;
  summary: string;
  tokens: number;
}

interface SetupCandidate {
  text: string;
  tokens: number;
  words: Set<string>;
}

interface UserTurnSnapshot {
  promptIndex: number;
  prompt: string;
  promptTokens: number;
  totalTokens: number;
  inputCostUsd: number;
  historyTokens: number;
  historyCostUsd: number;
  totalCostUsd: number;
  model: string;
  complexity: PromptComplexity;
  words: Set<string>;
  setupCandidates: SetupCandidate[];
  taskWords: Set<string>;
  taskLabel: string;
  errorBlocks: ErrorBlock[];
  frustrationMarkers: string[];
  turn: ConversationTurn;
}

interface TaskCluster {
  id: number;
  label: string;
  words: Set<string>;
  turns: number[];
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
  'for', 'from', 'has', 'have', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'please',
  'so', 'that', 'the', 'their', 'them', 'there', 'this', 'to',
  'us', 'we', 'with', 'you', 'your',
]);

const FRUSTRATION_PATTERNS = [
  /\bno\b/i,
  /\bthat(?:'s| is) wrong\b/i,
  /\bagain\b/i,
  /\bi said\b/i,
  /\bstill broken\b/i,
  /\bwhy are you\b/i,
  /\byou keep\b/i,
  /\bnot that\b/i,
  /\bdo not\b/i,
  /\bwrong\b/i,
];

const ERROR_LINE_REGEX = /(?:error|exception|traceback|failed|failure|cannot find|enoent|ts\d{3,5}|err_[a-z0-9_]+|syntaxerror|referenceerror|typeerror)/i;
const STACK_LINE_REGEX = /^\s*(?:at\s+\S+|File\s+.+,\s+line\s+\d+|Caused by:|> \d+\s*\|)/;
const INLINE_ERROR_REGEX = /(?:TS\d{3,5}:[^`\n.]+|Cannot find [^`\n.]+|ENOENT[^`\n.]*|ERR_[A-Z0-9_]+[^`\n.]*|(?:TypeError|ReferenceError|SyntaxError):[^`\n.]+)/gi;
const CHEAP_TASK_REGEX = /\b(?:rename|format|cleanup|clean up|lint|sort imports|fix typo|typo|spacing|comment only|reword|small refactor|minor refactor|trivial refactor|formatting|prettier)\b/i;
const SETUP_HINT_REGEX = /\b(?:codebase|repo|repository|project|architecture|service|services|component|components|schema|database|backend|frontend|folder|folders|module|modules|currently|we have|we're using|working on|requirements?)\b/i;

export function analyzeSessionDiagnostics(chat: ConversationChat): SessionDiagnostics {
  const turns = buildUserTurnSnapshots(chat);
  const issues = compact([
    detectReExplainer(turns),
    detectErrorPaster(turns),
    detectScopeCreeper(turns),
    detectCheapTaskTax(turns),
    detectDeadAttachment(chat, turns),
    detectFrustrationSpiral(turns),
  ]).sort((left, right) => {
    if (right.costUsdSoFar !== left.costUsdSoFar) {
      return right.costUsdSoFar - left.costUsdSoFar;
    }
    return right.tokensSoFar - left.tokensSoFar;
  });

  const tokenWasteBreakdown = issues.map((issue) => ({
    label: issue.title,
    tokens: issue.tokensSoFar,
    costUsd: issue.costUsdSoFar,
    detail: issue.summary,
  }))
    .sort((left, right) => {
      if (right.tokens !== left.tokens) {
        return right.tokens - left.tokens;
      }
      return right.costUsd - left.costUsd;
    });

  const repeatedSetupIssue = issues.find((issue) => issue.pattern === 're-explainer');
  const repeatedErrorIssue = issues.find((issue) => issue.pattern === 'error-paster');

  return {
    issues,
    tokenWaste: {
      totalTokens: Math.round(tokenWasteBreakdown.reduce((sum, item) => sum + item.tokens, 0)),
      totalCostUsd: tokenWasteBreakdown.reduce((sum, item) => sum + item.costUsd, 0),
      breakdown: tokenWasteBreakdown,
    },
    distinctTaskCount: countDistinctTaskClusters(turns),
    frustrationMarkers: turns.flatMap((turn) => turn.frustrationMarkers.map((phrase) => ({
      turn: turn.promptIndex,
      phrase,
    }))),
    repeatedSetupTurns: repeatedSetupIssue?.turnNumbers ?? [],
    repeatedErrorTurns: repeatedErrorIssue?.turnNumbers ?? [],
  };
}

export function toCoachInsight(issue: SessionFailureInsight): CoachInsight {
  return {
    id: issue.id,
    level: issue.level,
    title: issue.title,
    detail: formatFailureDetail(issue),
    pattern: issue.pattern,
    startedTurn: issue.startedTurn,
    turnNumbers: issue.turnNumbers,
    tokensSoFar: issue.tokensSoFar,
    costUsdSoFar: issue.costUsdSoFar,
    actionNow: issue.actionNow,
  };
}

function detectReExplainer(turns: UserTurnSnapshot[]): SessionFailureInsight | undefined {
  const clusters: Array<{
    turns: number[];
    snippets: Array<{ turn: UserTurnSnapshot; text: string; tokens: number; words: Set<string> }>;
  }> = [];

  for (const turn of turns) {
    for (const candidate of turn.setupCandidates) {
      const cluster = clusters.find((item) => similarity(item.snippets[0].words, candidate.words) >= 0.66);
      if (cluster) {
        cluster.turns.push(turn.promptIndex);
        cluster.snippets.push({ turn, text: candidate.text, tokens: candidate.tokens, words: candidate.words });
      } else {
        clusters.push({
          turns: [turn.promptIndex],
          snippets: [{ turn, text: candidate.text, tokens: candidate.tokens, words: candidate.words }],
        });
      }
    }
  }

  const best = clusters
    .map((cluster) => {
      const distinctTurns = [...new Set(cluster.turns)].sort((left, right) => left - right);
      if (distinctTurns.length < 2) {
        return undefined;
      }

      const duplicateSnippets = cluster.snippets.slice(1);
      const tokensSoFar = duplicateSnippets.reduce((sum, item) => sum + item.tokens, 0);
      const costUsdSoFar = duplicateSnippets.reduce((sum, item) => sum + proportionalInputCost(item.turn, item.tokens), 0);
      return {
        distinctTurns,
        tokensSoFar,
        costUsdSoFar,
        snippets: cluster.snippets,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => {
      if (right.tokensSoFar !== left.tokensSoFar) {
        return right.tokensSoFar - left.tokensSoFar;
      }
      return right.costUsdSoFar - left.costUsdSoFar;
    })[0];

  if (!best || best.tokensSoFar < 60) {
    const firstSetupTurn = turns.find((turn) => turn.setupCandidates.length > 0);
    const explicitRepeats = turns.filter((turn) =>
      /\b(?:same context again|same repo context|remember the same repo context|because you drifted)\b/i.test(turn.prompt)
    );

    if (!firstSetupTurn || explicitRepeats.length === 0) {
      return undefined;
    }

    const tokensSoFar = explicitRepeats.reduce((sum, turn) => sum + turn.promptTokens, 0);
    const costUsdSoFar = explicitRepeats.reduce((sum, turn) => sum + turn.inputCostUsd, 0);

    return {
      id: 'the-re-explainer',
      pattern: 're-explainer',
      level: explicitRepeats.length >= 2 ? 'danger' : 'warn',
      title: 'The Re-explainer',
      summary: `The session explicitly re-sends repo setup in turns ${formatTurnList(explicitRepeats.map((turn) => turn.promptIndex))} because the model drifted off the original context from turn ${firstSetupTurn.promptIndex}.`,
      startedTurn: explicitRepeats[0].promptIndex,
      turnNumbers: [firstSetupTurn.promptIndex, ...explicitRepeats.map((turn) => turn.promptIndex)],
      tokensSoFar,
      costUsdSoFar,
      actionNow: 'Stop restating the repo in-line. Open a fresh chat with a short project brief and link back to the exact file or failing symbol.',
      evidence: explicitRepeats.map((turn) => `Turn ${turn.promptIndex}: ${summarizeText(turn.prompt)}`),
    };
  }

  const repeatedTurns = best.distinctTurns.slice(1);
  return {
    id: 'the-re-explainer',
    pattern: 're-explainer',
    level: repeatedTurns.length >= 3 ? 'danger' : 'warn',
    title: 'The Re-explainer',
    summary: `Setup or requirement context from turn ${best.distinctTurns[0]} gets re-described in turns ${formatTurnList(repeatedTurns)} instead of being carried forward.`,
    startedTurn: repeatedTurns[0],
    turnNumbers: best.distinctTurns,
    tokensSoFar: best.tokensSoFar,
    costUsdSoFar: best.costUsdSoFar,
    actionNow: 'Start a fresh chat with a 120-word project brief and stop pasting the same architecture paragraph again.',
    evidence: best.snippets.slice(0, 3).map((item) => summarizeText(item.text)),
  };
}

function detectErrorPaster(turns: UserTurnSnapshot[]): SessionFailureInsight | undefined {
  const grouped = new Map<string, Array<{ turn: UserTurnSnapshot; block: ErrorBlock }>>();

  for (const turn of turns) {
    for (const block of turn.errorBlocks) {
      const existing = grouped.get(block.signature) ?? [];
      existing.push({ turn, block });
      grouped.set(block.signature, existing);
    }
  }

  const best = [...grouped.entries()]
    .map(([signature, entries]) => {
      const distinctTurns = [...new Set(entries.map((entry) => entry.turn.promptIndex))].sort((left, right) => left - right);
      if (distinctTurns.length < 2) {
        return undefined;
      }

      const repeatedEntries = entries.slice(1);
      const tokensSoFar = repeatedEntries.reduce((sum, entry) => sum + entry.block.tokens, 0);
      const costUsdSoFar = repeatedEntries.reduce((sum, entry) => sum + proportionalInputCost(entry.turn, entry.block.tokens), 0);
      return {
        signature,
        entries,
        distinctTurns,
        tokensSoFar,
        costUsdSoFar,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => {
      if (right.tokensSoFar !== left.tokensSoFar) {
        return right.tokensSoFar - left.tokensSoFar;
      }
      return right.costUsdSoFar - left.costUsdSoFar;
    })[0];

  if (!best || best.tokensSoFar < 12) {
    return undefined;
  }

  const repeatedTurns = best.distinctTurns.slice(1);
  const signatureSummary = best.entries[0]?.block.summary ?? 'same error signature';
  return {
    id: 'the-error-paster',
    pattern: 'error-paster',
    level: repeatedTurns.length >= 2 ? 'danger' : 'warn',
    title: 'The Error Paster',
    summary: `"${signatureSummary}" keeps getting pasted back in turns ${formatTurnList(repeatedTurns)} without a strategy change.`,
    startedTurn: repeatedTurns[0],
    turnNumbers: best.distinctTurns,
    tokensSoFar: best.tokensSoFar,
    costUsdSoFar: best.costUsdSoFar,
    actionNow: 'Paste the error once, list what you already tried, and ask for one ranked root-cause hypothesis plus one verification step before any new patch.',
    evidence: best.entries.slice(0, 3).map((entry) => `Turn ${entry.turn.promptIndex}: ${entry.block.summary}`),
  };
}

function detectScopeCreeper(turns: UserTurnSnapshot[]): SessionFailureInsight | undefined {
  if (turns.length < 6) {
    return undefined;
  }

  const clusters: TaskCluster[] = [];
  const assignments: Array<{ turn: UserTurnSnapshot; clusterId: number; clusterCount: number }> = [];

  for (const turn of turns) {
    const bestMatch = clusters
      .map((cluster) => ({ cluster, score: similarity(cluster.words, turn.taskWords) }))
      .sort((left, right) => right.score - left.score)[0];

    const usePreviousCluster = turn.promptTokens < 12 && assignments.length > 0;
    if (usePreviousCluster) {
      const previous = assignments[assignments.length - 1];
      previous && assignments.push({
        turn,
        clusterId: previous.clusterId,
        clusterCount: clusters.length,
      });
      continue;
    }

    if (bestMatch && bestMatch.score >= 0.38) {
      bestMatch.cluster.turns.push(turn.promptIndex);
      bestMatch.cluster.words = unionWords(bestMatch.cluster.words, turn.taskWords);
      assignments.push({
        turn,
        clusterId: bestMatch.cluster.id,
        clusterCount: clusters.length,
      });
      continue;
    }

    const nextCluster: TaskCluster = {
      id: clusters.length + 1,
      label: turn.taskLabel,
      words: new Set(turn.taskWords),
      turns: [turn.promptIndex],
    };
    clusters.push(nextCluster);
    assignments.push({
      turn,
      clusterId: nextCluster.id,
      clusterCount: clusters.length,
    });
  }

  if (clusters.length < 4) {
    return undefined;
  }

  const startedAssignment = assignments.find((assignment) => assignment.clusterCount >= 4);
  if (!startedAssignment) {
    return undefined;
  }

  const startedTurn = startedAssignment.turn.promptIndex;
  const postStartTurns = turns.filter((turn) => turn.promptIndex >= startedTurn);
  const tokensSoFar = postStartTurns.reduce((sum, turn) => sum + turn.historyTokens, 0);
  const costUsdSoFar = postStartTurns.reduce((sum, turn) => sum + turn.historyCostUsd, 0);
  const clusterLabels = clusters.slice(-3).map((cluster) => `"${cluster.label}"`);

  if (tokensSoFar < 120) {
    return undefined;
  }

  return {
    id: 'the-scope-creeper',
    pattern: 'scope-creeper',
    level: clusters.length >= 5 ? 'danger' : 'warn',
    title: 'The Scope Creeper',
    summary: `This chat grows from one task into ${clusters.length} separate workstreams by turn ${startedTurn}, so later prompts are paying history for unrelated work.`,
    startedTurn,
    turnNumbers: postStartTurns.map((turn) => turn.promptIndex),
    tokensSoFar,
    costUsdSoFar,
    actionNow: `Split the remaining work into focused chats for ${clusterLabels.join(', ')} and keep this thread on one task.`,
    evidence: clusters.slice(0, 5).map((cluster) => `${cluster.label} (turns ${formatTurnList(cluster.turns)})`),
  };
}

function detectCheapTaskTax(turns: UserTurnSnapshot[]): SessionFailureInsight | undefined {
  const flagged = turns.filter((turn) => {
    const recommendation = turn.turn.modelRecommendation;
    if (!recommendation || recommendation.estimatedOverspendUsd < 0.003) {
      return false;
    }

    if (recommendation.complexity === 'trivial') {
      return true;
    }

    return recommendation.complexity === 'moderate' && CHEAP_TASK_REGEX.test(turn.prompt);
  });

  if (flagged.length === 0) {
    return undefined;
  }

  const first = flagged[0];
  const recommendation = first.turn.modelRecommendation;
  if (!recommendation) {
    return undefined;
  }

  const tokensSoFar = flagged.reduce((sum, turn) => sum + turn.totalTokens, 0);
  const costUsdSoFar = flagged.reduce(
    (sum, turn) => sum + (turn.turn.modelRecommendation?.estimatedOverspendUsd ?? 0),
    0
  );

  return {
    id: 'the-cheap-task-tax',
    pattern: 'cheap-task-tax',
    level: flagged.length >= 2 ? 'warn' : 'info',
    title: 'The Cheap Task Tax',
    summary: `Cheap work like turn ${first.promptIndex}${flagged.length > 1 ? ` and ${formatTurnList(flagged.slice(1).map((turn) => turn.promptIndex))}` : ''} ran on ${recommendation.currentModel} instead of ${recommendation.recommendedModel}.`,
    startedTurn: first.promptIndex,
    turnNumbers: flagged.map((turn) => turn.promptIndex),
    tokensSoFar,
    costUsdSoFar,
    actionNow: `Move renames, formatting, and small refactors to ${recommendation.recommendedModel} before spending another premium turn here.`,
    evidence: flagged.slice(0, 3).map((turn) => `Turn ${turn.promptIndex}: ${summarizeText(turn.prompt)}`),
  };
}

function detectDeadAttachment(
  chat: ConversationChat,
  turns: UserTurnSnapshot[]
): SessionFailureInsight | undefined {
  const deadReferences = chat.contextHealth?.deadReferences ?? [];
  if (deadReferences.length === 0) {
    return undefined;
  }

  const ranked = deadReferences
    .map((reference) => {
      const firstMentionTurn = reference.firstMentionTurn ?? 1;
      const replayTurns = Math.max(0, reference.estimatedReplayTurns ?? (turns.length - firstMentionTurn));
      const tokensSoFar = Math.max(0, reference.estimatedReplayTokens ?? (reference.tokenCountEstimate * replayTurns));
      const costUsdSoFar = estimateReplayCost(reference.tokenCountEstimate, firstMentionTurn, turns);
      return {
        reference,
        firstMentionTurn,
        tokensSoFar,
        costUsdSoFar,
      };
    })
    .sort((left, right) => {
      if (right.tokensSoFar !== left.tokensSoFar) {
        return right.tokensSoFar - left.tokensSoFar;
      }
      return right.costUsdSoFar - left.costUsdSoFar;
    })[0];

  if (!ranked || ranked.tokensSoFar < 120) {
    return undefined;
  }

  return {
    id: 'the-dead-attachment',
    pattern: 'dead-attachment',
    level: ranked.reference.tokenCountEstimate >= 1000 ? 'danger' : 'warn',
    title: 'The Dead Attachment',
    summary: `@${ranked.reference.name} first appears in turn ${ranked.firstMentionTurn} and never shows up in any assistant response, yet it is still costing about ${formatTokenCount(ranked.reference.tokenCountEstimate)} tokens per turn.`,
    startedTurn: ranked.firstMentionTurn,
    turnNumbers: turns
      .filter((turn) => turn.promptIndex >= ranked.firstMentionTurn)
      .map((turn) => turn.promptIndex),
    tokensSoFar: ranked.tokensSoFar,
    costUsdSoFar: ranked.costUsdSoFar,
    actionNow: `Drop @${ranked.reference.name} from the next prompt or restart the chat without it attached.`,
    evidence: [
      `Estimated size: ${formatTokenCount(ranked.reference.tokenCountEstimate)} tokens`,
      `Replay turns: ${Math.max(0, ranked.reference.estimatedReplayTurns ?? 0)}`,
    ],
  };
}

function detectFrustrationSpiral(turns: UserTurnSnapshot[]): SessionFailureInsight | undefined {
  const frustratedTurns = turns.filter((turn) => turn.frustrationMarkers.length > 0);
  if (frustratedTurns.length === 0) {
    return undefined;
  }

  const startedTurn = frustratedTurns[0].promptIndex;
  const trailingTurns = turns.filter((turn) => turn.promptIndex >= startedTurn);
  const firstWindow = turns.slice(0, Math.min(3, turns.length));
  const lastWindow = turns.slice(-Math.min(3, turns.length));
  const firstAverage = average(firstWindow.map((turn) => turn.promptTokens));
  const lastAverage = average(lastWindow.map((turn) => turn.promptTokens));
  const sharplyShorter = firstAverage > 0 && lastAverage <= firstAverage * 0.55;

  if (!sharplyShorter && frustratedTurns.length < 2) {
    return undefined;
  }

  return {
    id: 'the-frustration-spiral',
    pattern: 'frustration-spiral',
    level: frustratedTurns.length >= 2 ? 'danger' : 'warn',
    title: 'The Frustration Spiral',
    summary: `Prompt tone turns terse around turn ${startedTurn}${frustratedTurns.length > 1 ? `, with markers like ${frustratedTurns.slice(0, 3).flatMap((turn) => turn.frustrationMarkers).map((phrase) => `"${phrase}"`).join(', ')}` : ''}.`,
    startedTurn,
    turnNumbers: trailingTurns.map((turn) => turn.promptIndex),
    tokensSoFar: trailingTurns.reduce((sum, turn) => sum + turn.totalTokens, 0),
    costUsdSoFar: trailingTurns.reduce((sum, turn) => sum + turn.totalCostUsd, 0),
    actionNow: 'Switch models or start a fresh chat with one clear objective before spending more turns in the same loop.',
    evidence: frustratedTurns.slice(0, 3).map((turn) => `Turn ${turn.promptIndex}: ${summarizeText(turn.prompt)}`),
  };
}

function buildUserTurnSnapshots(chat: ConversationChat): UserTurnSnapshot[] {
  return chat.turns
    .map((turn, index) => ({ turn, promptIndex: index + 1 }))
    .filter(({ turn }) => Boolean(turn.blocks['user-input'].content.trim()))
    .map(({ turn, promptIndex }) => {
      const prompt = turn.blocks['user-input'].content.trim();
      const promptTokens = turn.metrics?.inputTokens ?? estimateTokens(prompt);
      return {
        promptIndex,
        prompt,
        promptTokens,
        totalTokens: turn.metrics?.totalTokens ?? promptTokens,
        inputCostUsd: turn.metrics?.inputCostUsd ?? 0,
        historyTokens: turn.metrics?.historyTokens ?? 0,
        historyCostUsd: turn.metrics?.historyCostUsd ?? 0,
        totalCostUsd: turn.metrics?.costUsd ?? 0,
        model: turn.model ?? chat.model ?? 'Unknown model',
        complexity: turn.assessment?.complexity ?? classifyPromptComplexity(prompt, promptTokens),
        words: tokenize(prompt),
        setupCandidates: extractSetupCandidates(prompt),
        taskWords: tokenize(stripErrorNoise(prompt)),
        taskLabel: extractTaskLabel(prompt),
        errorBlocks: extractErrorBlocks(prompt),
        frustrationMarkers: detectFrustrationMarkers(prompt),
        turn,
      };
    });
}

function countDistinctTaskClusters(turns: UserTurnSnapshot[]): number {
  const clusters: Array<Set<string>> = [];

  for (const turn of turns) {
    const best = clusters
      .map((words) => similarity(words, turn.taskWords))
      .sort((left, right) => right - left)[0];

    if (typeof best === 'number' && best >= 0.38) {
      continue;
    }

    clusters.push(turn.taskWords);
  }

  return clusters.length;
}

function extractSetupCandidates(prompt: string): SetupCandidate[] {
  const strippedPrompt = stripSetupNoise(prompt);
  const paragraphs = prompt
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  const matches = paragraphs
    .filter((part) => {
      const tokens = estimateTokens(part);
      return tokens >= 28 && looksLikeSetup(part);
    })
    .map((text) => ({
      text,
      tokens: estimateTokens(text),
      words: tokenize(text),
    }));

  if (matches.length > 0) {
    return matches;
  }

  if (strippedPrompt !== prompt && estimateTokens(strippedPrompt) >= 24 && looksLikeSetup(strippedPrompt)) {
    return [{
      text: strippedPrompt,
      tokens: estimateTokens(strippedPrompt),
      words: tokenize(strippedPrompt),
    }];
  }

  if (estimateTokens(prompt) >= 70 && looksLikeSetup(prompt)) {
    return [{
      text: prompt,
      tokens: estimateTokens(prompt),
      words: tokenize(prompt),
    }];
  }

  return [];
}

function looksLikeSetup(value: string): boolean {
  if (SETUP_HINT_REGEX.test(value)) {
    return true;
  }

  const backtickIdentifiers = (value.match(/`[^`]+`/g) ?? []).length;
  const pathLikeValues = (value.match(/[./][A-Za-z0-9_\-/]+\.[A-Za-z0-9]+/g) ?? []).length;
  return backtickIdentifiers >= 2 || pathLikeValues >= 2;
}

function extractErrorBlocks(prompt: string): ErrorBlock[] {
  const lines = prompt.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }

    blocks.push(current.join('\n').trim());
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isErrorLine = ERROR_LINE_REGEX.test(trimmed) || STACK_LINE_REGEX.test(trimmed);
    if (isErrorLine) {
      current.push(line);
      continue;
    }

    if (current.length > 0) {
      flush();
    }
  }
  flush();

  if (blocks.length === 0 && ERROR_LINE_REGEX.test(prompt)) {
    blocks.push(prompt.trim());
  }

  const inlineMatches = prompt.match(INLINE_ERROR_REGEX) ?? [];
  for (const match of inlineMatches) {
    blocks.push(match.trim());
  }

  const seen = new Set<string>();
  const results: ErrorBlock[] = [];

  for (const block of blocks) {
    const signature = normalizeErrorSignature(block);
    if (!signature || seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    results.push({
      signature,
      summary: summarizeError(block),
      tokens: estimateTokens(block),
    });
  }

  return results;
}

function normalizeErrorSignature(value: string): string {
  return value
    .toLowerCase()
    .replace(/\/users\/[^\s:'"]+/g, '<path>')
    .replace(/\bline\s+\d+\b/g, 'line #')
    .replace(/:\d+:\d+/g, ':#:#')
    .replace(/:\d+/g, ':#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function summarizeError(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return summarizeText(firstLine ?? value);
}

function detectFrustrationMarkers(prompt: string): string[] {
  const matches: string[] = [];
  for (const pattern of FRUSTRATION_PATTERNS) {
    const match = prompt.match(pattern);
    if (match?.[0]) {
      matches.push(match[0].trim());
    }
  }
  return [...new Set(matches)];
}

function extractTaskLabel(prompt: string): string {
  const firstSentence = prompt
    .split(/[\n.!?]/)
    .map((part) => part.trim())
    .find(Boolean)
    ?? prompt.trim();

  return summarizeText(
    firstSentence
      .replace(/^(please|can you|could you|need to|i need you to)\s+/i, '')
      .replace(/\s+/g, ' ')
  , 68);
}

function stripErrorNoise(prompt: string): string {
  return prompt
    .split(/\r?\n/)
    .filter((line) => !ERROR_LINE_REGEX.test(line) && !STACK_LINE_REGEX.test(line))
    .join('\n');
}

function stripSetupNoise(prompt: string): string {
  return stripErrorNoise(prompt)
    .replace(/\b(?:same context again because you drifted|also remember the same repo context)\b[:,-]?\s*/gi, '')
    .replace(INLINE_ERROR_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): Set<string> {
  const words = value
    .toLowerCase()
    .replace(/[`"'()[\]{}:;,.!?/\\]+/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

  return new Set(words);
}

function similarity(left: Set<string>, right: Set<string>): number {
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

function unionWords(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

function estimateTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.round(normalized.length / 4));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function proportionalInputCost(turn: UserTurnSnapshot, tokens: number): number {
  if (turn.promptTokens <= 0 || turn.inputCostUsd <= 0) {
    return 0;
  }

  return (turn.inputCostUsd / turn.promptTokens) * tokens;
}

function estimateReplayCost(
  replayTokensPerTurn: number,
  firstMentionTurn: number,
  turns: UserTurnSnapshot[]
): number {
  return turns
    .filter((turn) => turn.promptIndex > firstMentionTurn)
    .reduce((sum, turn) => {
      if (turn.promptTokens <= 0 || turn.inputCostUsd <= 0) {
        return sum;
      }

      return sum + ((turn.inputCostUsd / turn.promptTokens) * replayTokensPerTurn);
    }, 0);
}

function formatFailureDetail(issue: SessionFailureInsight): string {
  return `${issue.summary} Started at turn ${issue.startedTurn}. Estimated waste so far: ${formatTokenCount(issue.tokensSoFar)} tokens / ${formatUsd(issue.costUsdSoFar)}. Do now: ${issue.actionNow}`;
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 3)}`;
}

function formatTurnList(turns: number[]): string {
  if (turns.length === 0) {
    return '';
  }

  if (turns.length === 1) {
    return String(turns[0]);
  }

  if (turns.length === 2) {
    return `${turns[0]} and ${turns[1]}`;
  }

  return `${turns.slice(0, -1).join(', ')}, and ${turns[turns.length - 1]}`;
}

function summarizeText(value: string, maxLength = 96): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return 'Untitled';
  }

  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, maxLength - 3).trimEnd()}...`;
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

function compact<T>(values: Array<T | undefined>): T[] {
  return values.filter((value): value is T => value !== undefined);
}
