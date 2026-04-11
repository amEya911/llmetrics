import * as vscode from 'vscode';
import { cloneSnapshot, MonitorSnapshot, MonitorStatus, WebviewOutgoing } from './types';
import { getConversationWebviewHtml } from './webviewContent';

export class MonitorPanel implements vscode.Disposable {
  static readonly viewType = 'aiAgentMonitor.panel';
  private static instance: MonitorPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private currentSnapshot: MonitorSnapshot = {
    app: 'unknown',
    appLabel: 'AI Sidebar',
    chats: [],
  };
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
          this.sync(this.currentSnapshot, this.currentStatus);
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
      chats: [],
      selectedChatId: undefined,
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
