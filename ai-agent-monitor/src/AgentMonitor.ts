import * as vscode from 'vscode';
import { ConversationStoreWatcher } from './ConversationStoreWatcher';
import { NetworkInterceptor } from './NetworkInterceptor';
import {
  BLOCK_TYPES,
  BlockType,
  ConversationSegment,
  ConversationTurn,
  MonitorMessage,
  MonitorStatus,
} from './types';

function createEmptySegment(): ConversationSegment {
  return {
    content: '',
    isStreaming: false,
  };
}

function createEmptyBlocks(): Record<BlockType, ConversationSegment> {
  return {
    'user-input': createEmptySegment(),
    'agent-thinking': createEmptySegment(),
    'agent-output': createEmptySegment(),
  };
}

export class AgentMonitor implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly turns: ConversationTurn[] = [];
  private readonly output: vscode.OutputChannel;
  private readonly storeWatcher: ConversationStoreWatcher;
  private readonly networkInterceptor: NetworkInterceptor;

  private turnCounter = 0;
  private activeNetworkTurnId?: string;
  private status: MonitorStatus = {
    status: 'monitoring',
    text: 'Listening for AI conversations...',
  };

  private readonly _onTurnAdded = new vscode.EventEmitter<ConversationTurn>();
  readonly onTurnAdded = this._onTurnAdded.event;

  private readonly _onTurnUpdated = new vscode.EventEmitter<ConversationTurn>();
  readonly onTurnUpdated = this._onTurnUpdated.event;

  private readonly _onStatusChanged = new vscode.EventEmitter<MonitorStatus>();
  readonly onStatusChanged = this._onStatusChanged.event;

  constructor() {
    this.output = vscode.window.createOutputChannel('AI Agent Monitor');
    this.output.appendLine('AI Agent Monitor activated.');

    this.storeWatcher = new ConversationStoreWatcher({
      onTurnCaptured: (turn) => this.upsertTrackedTurn(turn),
    }, this.output);
    this.disposables.push(this.storeWatcher);
    this.storeWatcher.start();

    this.networkInterceptor = new NetworkInterceptor();
    this.disposables.push(this.networkInterceptor);
    this.setupNetworkFallback();
    this.networkInterceptor.start();

    this.setStatus(
      'monitoring',
      'File-backed capture enabled. Generic fallback enabled.'
    );
  }

  pushMessage(message: MonitorMessage): ConversationTurn {
    const turn = message.type === 'user-input'
      ? this.createTurn(message.source)
      : this.getLastOpenTurn(message.source) ?? this.createTurn(message.source);

    this.setBlockContent(turn.id, message.type, message.content);

    if (message.type === 'agent-output') {
      this.finalizeTurn(turn.id);
    }

    return this.cloneTurn(this.mustGetTurn(turn.id));
  }

  clearBlocks(): void {
    this.turns.length = 0;
    this.turnCounter = 0;
    this.activeNetworkTurnId = undefined;
    this.storeWatcher.resetBaseline();
  }

  getTurns(): ConversationTurn[] {
    return this.turns.map((turn) => this.cloneTurn(turn));
  }

  getStatus(): MonitorStatus {
    return { ...this.status };
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this._onTurnAdded.dispose();
    this._onTurnUpdated.dispose();
    this._onStatusChanged.dispose();
    this.output.dispose();
  }

  private setupNetworkFallback(): void {
    this.disposables.push(
      this.networkInterceptor.onUserMessage(({ content, source }) => {
        if (this.activeNetworkTurnId) {
          this.finalizeTurn(this.activeNetworkTurnId);
        }

        const turn = this.createTurn(source);
        this.activeNetworkTurnId = turn.id;
        this.setBlockContent(turn.id, 'user-input', content);
        this.setStatus('connected', `Capturing ${source}...`);
      })
    );

    this.disposables.push(
      this.networkInterceptor.onAiResponseStart(({ source }) => {
        const turn = this.getOrCreateActiveNetworkTurn(source);
        this.startBlock(turn.id, 'agent-output');
        this.setStatus('connected', `Streaming ${source}...`);
      })
    );

    this.disposables.push(
      this.networkInterceptor.onAiResponseChunk(({ content, source }) => {
        const turn = this.getOrCreateActiveNetworkTurn(source);
        this.appendToBlock(turn.id, 'agent-output', content);
      })
    );

    this.disposables.push(
      this.networkInterceptor.onAiResponseEnd(() => {
        if (this.activeNetworkTurnId) {
          this.finalizeTurn(this.activeNetworkTurnId);
          this.activeNetworkTurnId = undefined;
        }
        this.setStatus('monitoring', 'Waiting for the next AI conversation...');
      })
    );
  }

  private createTurn(source?: string): ConversationTurn {
    const now = Date.now();
    const turn: ConversationTurn = {
      id: `turn-${++this.turnCounter}`,
      source,
      createdAt: now,
      updatedAt: now,
      isComplete: false,
      blocks: createEmptyBlocks(),
    };

    this.turns.push(turn);
    this._onTurnAdded.fire(this.cloneTurn(turn));
    return turn;
  }

  private getOrCreateActiveNetworkTurn(source?: string): ConversationTurn {
    const existing = this.activeNetworkTurnId ? this.getTurn(this.activeNetworkTurnId) : undefined;
    if (existing) {
      return existing;
    }

    const turn = this.createTurn(source);
    this.activeNetworkTurnId = turn.id;
    return turn;
  }

  private getLastOpenTurn(source?: string): ConversationTurn | undefined {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i];
      if (!turn.isComplete && (source === undefined || turn.source === source)) {
        return turn;
      }
    }

    return undefined;
  }

  private getTurn(turnId: string): ConversationTurn | undefined {
    return this.turns.find((turn) => turn.id === turnId);
  }

  private mustGetTurn(turnId: string): ConversationTurn {
    const turn = this.getTurn(turnId);
    if (!turn) {
      throw new Error(`Unknown conversation turn: ${turnId}`);
    }
    return turn;
  }

  private setBlockContent(turnId: string, blockType: BlockType, content: string): void {
    const turn = this.getTurn(turnId);
    if (!turn) {
      return;
    }

    const block = turn.blocks[blockType];
    block.content = content;
    block.isStreaming = false;
    this.touchTurn(turn);
  }

  private startBlock(turnId: string, blockType: BlockType): void {
    const turn = this.getTurn(turnId);
    if (!turn) {
      return;
    }

    turn.blocks[blockType].isStreaming = true;
    this.touchTurn(turn);
  }

  private appendToBlock(turnId: string, blockType: BlockType, content: string): void {
    if (!content) {
      return;
    }

    const turn = this.getTurn(turnId);
    if (!turn) {
      return;
    }

    const block = turn.blocks[blockType];
    if (!block.isStreaming) {
      block.isStreaming = true;
    }
    block.content += content;
    this.touchTurn(turn);
  }

  private completeBlock(turnId: string, blockType: BlockType): void {
    const turn = this.getTurn(turnId);
    if (!turn) {
      return;
    }

    turn.blocks[blockType].isStreaming = false;
    this.touchTurn(turn);
  }

  private finalizeTurn(turnId: string): void {
    const turn = this.getTurn(turnId);
    if (!turn) {
      return;
    }

    for (const blockType of BLOCK_TYPES) {
      turn.blocks[blockType].isStreaming = false;
    }
    turn.isComplete = true;
    this.touchTurn(turn);
  }

  private touchTurn(turn: ConversationTurn): void {
    turn.updatedAt = Date.now();
    this._onTurnUpdated.fire(this.cloneTurn(turn));
  }

  private upsertTrackedTurn(turn: ConversationTurn): void {
    const existing = this.getTurn(turn.id);
    if (!existing) {
      const next = this.cloneTurn(turn);
      this.turns.push(next);
      this._onTurnAdded.fire(this.cloneTurn(next));
      return;
    }

    if (this.areTurnsEquivalent(existing, turn)) {
      return;
    }

    existing.source = turn.source;
    existing.createdAt = turn.createdAt;
    existing.updatedAt = turn.updatedAt;
    existing.isComplete = turn.isComplete;
    for (const blockType of BLOCK_TYPES) {
      existing.blocks[blockType].content = turn.blocks[blockType].content;
      existing.blocks[blockType].isStreaming = turn.blocks[blockType].isStreaming;
    }

    this._onTurnUpdated.fire(this.cloneTurn(existing));
  }

  private setStatus(status: MonitorStatus['status'], text: string): void {
    this.status = { status, text };
    this._onStatusChanged.fire({ ...this.status });
  }

  private areTurnsEquivalent(left: ConversationTurn, right: ConversationTurn): boolean {
    if (
      left.source !== right.source ||
      left.createdAt !== right.createdAt ||
      left.updatedAt !== right.updatedAt ||
      left.isComplete !== right.isComplete
    ) {
      return false;
    }

    return BLOCK_TYPES.every((blockType) => {
      return left.blocks[blockType].content === right.blocks[blockType].content &&
        left.blocks[blockType].isStreaming === right.blocks[blockType].isStreaming;
    });
  }

  private cloneTurn(turn: ConversationTurn): ConversationTurn {
    return {
      ...turn,
      blocks: {
        'user-input': { ...turn.blocks['user-input'] },
        'agent-thinking': { ...turn.blocks['agent-thinking'] },
        'agent-output': { ...turn.blocks['agent-output'] },
      },
    };
  }
}
