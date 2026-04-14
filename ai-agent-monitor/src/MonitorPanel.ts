import * as vscode from 'vscode';
import { cloneSnapshot, MonitorSnapshot, MonitorStatus, WebviewIncoming, WebviewOutgoing } from './types';
import { getConversationWebviewHtml } from './webviewContent';

function createEmptySnapshot(): MonitorSnapshot {
  return {
    app: 'unknown',
    appLabel: 'VS Code',
    sources: [],
    analytics: {
      today: { tokens: 0, costUsd: 0, prompts: 0, sessions: 0 },
      week: { tokens: 0, costUsd: 0, prompts: 0, sessions: 0 },
      month: { tokens: 0, costUsd: 0, prompts: 0, sessions: 0 },
      byAgent: [],
      byModel: [],
      expensiveSessions: [],
      expensivePrompts: [],
      trend: [],
      coach: [],
    },
    promptLibrary: [],
    budgets: {
      dailyCostUsd: null,
      monthlyCostUsd: null,
      dailyTokens: null,
      monthlyTokens: null,
    },
    alerts: [],
    generatedAt: Date.now(),
  };
}

export class MonitorPanel implements vscode.Disposable {
  static readonly viewType = 'aiAgentMonitor.panel';
  private static instance: MonitorPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly messageHandler?: (message: WebviewIncoming) => void;
  private ready = false;
  private currentSnapshot: MonitorSnapshot = createEmptySnapshot();
  private currentStatus: MonitorStatus = {
    status: 'monitoring',
    text: 'Building the AI analytics dashboard...',
  };

  private constructor(
    panel: vscode.WebviewPanel,
    messageHandler?: (message: WebviewIncoming) => void
  ) {
    this.panel = panel;
    this.messageHandler = messageHandler;
    this.panel.webview.html = getConversationWebviewHtml(this.panel.webview, 'AI Token Analytics');

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewIncoming) => {
        if (message.command === 'ready') {
          this.ready = true;
          this.sync(this.currentSnapshot, this.currentStatus);
          return;
        }

        this.messageHandler?.(message);
      })
    );

    this.disposables.push(
      this.panel.onDidDispose(() => {
        MonitorPanel.instance = undefined;
        this.ready = false;
      })
    );
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    messageHandler?: (message: WebviewIncoming) => void
  ): MonitorPanel {
    const column = vscode.ViewColumn.Beside;

    if (MonitorPanel.instance) {
      MonitorPanel.instance.panel.reveal(column);
      return MonitorPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      MonitorPanel.viewType,
      'AI Token Analytics',
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

    MonitorPanel.instance = new MonitorPanel(panel, messageHandler);
    return MonitorPanel.instance;
  }

  static getInstance(): MonitorPanel | undefined {
    return MonitorPanel.instance;
  }

  sync(snapshot: MonitorSnapshot, status: MonitorStatus): void {
    this.currentSnapshot = cloneSnapshot(snapshot);
    this.currentStatus = { ...status };

    this.postMessage({
      command: 'sync',
      snapshot: this.currentSnapshot,
    });
    this.postMessage({
      command: 'setStatus',
      status: status.status,
      text: status.text,
    });
  }

  clear(): void {
    this.currentSnapshot = {
      ...this.currentSnapshot,
      sources: [],
      activeChat: undefined,
      analytics: {
        ...this.currentSnapshot.analytics,
        byAgent: [],
        byModel: [],
        expensiveSessions: [],
        expensivePrompts: [],
        trend: [],
        coach: [],
      },
      alerts: [],
      generatedAt: Date.now(),
    };
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
