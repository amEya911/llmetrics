import * as vscode from 'vscode';
import { cloneSnapshot, MonitorSnapshot, MonitorStatus, WebviewOutgoing } from './types';
import { getConversationWebviewHtml } from './webviewContent';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiAgentMonitor.sidebarView';

  private view?: vscode.WebviewView;
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
        this.sync(this.currentSnapshot, this.currentStatus);
      }
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

  private postMessage(message: WebviewOutgoing): void {
    if (!this.view || !this.ready) {
      return;
    }

    this.view.webview.postMessage(message);
  }
}
