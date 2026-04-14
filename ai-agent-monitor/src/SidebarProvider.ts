import * as vscode from 'vscode';
import { cloneSnapshot, MonitorSnapshot, MonitorStatus, WebviewIncoming, WebviewOutgoing } from './types';
import { getConversationWebviewHtml } from './webviewContent';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiAgentMonitor.sidebarView';

  private view?: vscode.WebviewView;
  private ready = false;
  private currentSnapshot: MonitorSnapshot = {
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
  private currentStatus: MonitorStatus = {
    status: 'monitoring',
    text: 'Building the AI analytics dashboard...',
  };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageHandler?: (message: WebviewIncoming) => void
  ) {}

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

    webviewView.webview.html = getConversationWebviewHtml(webviewView.webview, 'AI Token Analytics');

    webviewView.webview.onDidReceiveMessage((message: WebviewIncoming) => {
      if (message.command === 'ready') {
        this.ready = true;
        this.sync(this.currentSnapshot, this.currentStatus);
        return;
      }

      this.messageHandler?.(message);
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
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

  private postMessage(message: WebviewOutgoing): void {
    if (!this.view || !this.ready) {
      return;
    }

    this.view.webview.postMessage(message);
  }
}
