import * as vscode from 'vscode';
import { ConversationTurn, MonitorStatus, WebviewOutgoing } from './types';
import { getConversationWebviewHtml } from './webviewContent';

export class MonitorPanel implements vscode.Disposable {
  static readonly viewType = 'aiAgentMonitor.panel';
  private static instance: MonitorPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private currentTurns: ConversationTurn[] = [];
  private currentStatus: MonitorStatus = {
    status: 'monitoring',
    text: 'Listening for AI conversations...',
  };

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = getConversationWebviewHtml(this.panel.webview, 'AI Agent Monitor');

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message) => {
        if (message.command === 'ready') {
          this.ready = true;
          this.sync(this.currentTurns, this.currentStatus);
        }
      })
    );

    this.disposables.push(
      this.panel.onDidDispose(() => {
        MonitorPanel.instance = undefined;
        this.ready = false;
      })
    );
  }

  static createOrShow(extensionUri: vscode.Uri): MonitorPanel {
    const column = vscode.ViewColumn.Beside;

    if (MonitorPanel.instance) {
      MonitorPanel.instance.panel.reveal(column);
      return MonitorPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      MonitorPanel.viewType,
      'AI Agent Monitor',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-dark.svg'),
    };

    MonitorPanel.instance = new MonitorPanel(panel);
    return MonitorPanel.instance;
  }

  static getInstance(): MonitorPanel | undefined {
    return MonitorPanel.instance;
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

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private postMessage(message: WebviewOutgoing): void {
    if (!this.ready) {
      return;
    }

    this.panel.webview.postMessage(message);
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
