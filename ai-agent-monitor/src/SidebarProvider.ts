import * as vscode from 'vscode';
import { ConversationTurn, MonitorStatus, WebviewOutgoing } from './types';
import { getConversationWebviewHtml } from './webviewContent';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiAgentMonitor.sidebarView';

  private view?: vscode.WebviewView;
  private ready = false;
  private currentTurns: ConversationTurn[] = [];
  private currentStatus: MonitorStatus = {
    status: 'monitoring',
    text: 'Listening for AI conversations...',
  };

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    this.ready = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = getConversationWebviewHtml(webviewView.webview, 'AI Agent Monitor');

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.command === 'ready') {
        this.ready = true;
        this.sync(this.currentTurns, this.currentStatus);
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  sync(turns: ConversationTurn[], status: MonitorStatus): void {
    this.currentTurns = turns.map((turn) => cloneTurn(turn));
    this.currentStatus = { ...status };

    this.postMessage({
      command: 'sync',
      turns: this.currentTurns,
    });
    this.postMessage({
      command: 'setStatus',
      status: status.status,
      text: status.text,
    });
  }

  updateTurn(turn: ConversationTurn): void {
    const next = cloneTurn(turn);
    const existingIndex = this.currentTurns.findIndex((candidate) => candidate.id === next.id);

    if (existingIndex === -1) {
      this.currentTurns.push(next);
    } else {
      this.currentTurns[existingIndex] = next;
    }

    this.postMessage({
      command: 'updateTurn',
      turn: next,
    });
  }

  clear(): void {
    this.currentTurns = [];
    this.postMessage({ command: 'clear' });
  }

  setStatus(status: MonitorStatus['status'], text: string): void {
    this.currentStatus = { status, text };
    this.postMessage({
      command: 'setStatus',
      status,
      text,
    });
  }

  private postMessage(message: WebviewOutgoing): void {
    if (!this.view || !this.ready) {
      return;
    }

    this.view.webview.postMessage(message);
  }
}

function cloneTurn(turn: ConversationTurn): ConversationTurn {
  return {
    ...turn,
    blocks: {
      'user-input': { ...turn.blocks['user-input'] },
      'agent-thinking': { ...turn.blocks['agent-thinking'] },
      'agent-output': { ...turn.blocks['agent-output'] },
    },
  };
}
