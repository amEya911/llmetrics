import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentMonitor } from './AgentMonitor';
import { MonitorPanel } from './MonitorPanel';
import { SidebarProvider } from './SidebarProvider';
import { BlockType, WebviewIncoming } from './types';

let monitor: AgentMonitor | undefined;
let sidebarProvider: SidebarProvider | undefined;

function handleWebviewMessage(message: WebviewIncoming): void {
  monitor?.handleWebviewMessage(message);
}

export function activate(context: vscode.ExtensionContext) {
  const activationLogPath = path.join(os.tmpdir(), 'ai-token-analytics-activation.log');
  const activationPayload = JSON.stringify({
    timestamp: new Date().toISOString(),
    pid: process.pid,
    appName: vscode.env.appName,
    remoteName: vscode.env.remoteName ?? null,
    uiKind: vscode.env.uiKind,
    execPath: process.execPath,
    cwd: process.cwd(),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  });

  try {
    fs.appendFileSync(activationLogPath, `${activationPayload}\n`, 'utf8');
  } catch {
    // Ignore activation log write failures during diagnostics.
  }

  console.log(
    '[ai-agent-monitor] activate',
    activationPayload
  );

  monitor = new AgentMonitor(context);
  context.subscriptions.push(monitor);

  sidebarProvider = new SidebarProvider(context.extensionUri, handleWebviewMessage);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  sidebarProvider.sync(monitor.getSnapshot(), monitor.getStatus());

  context.subscriptions.push(
    vscode.commands.registerCommand('aiAgentMonitor.open', () => {
      const panel = MonitorPanel.createOrShow(context.extensionUri, handleWebviewMessage);
      panel.sync(monitor!.getSnapshot(), monitor!.getStatus());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiAgentMonitor.openSidebar', () => {
      void vscode.commands.executeCommand('workbench.view.extension.ai-agent-monitor');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiAgentMonitor.clear', () => {
      monitor!.clearBlocks();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiAgentMonitor.fullSessionAnalysis', () => {
      return monitor!.generateSessionAnalysisReport();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'aiAgentMonitor.pushMessage',
      (type?: BlockType, content?: string) => {
        if (!type || !content) {
          return;
        }

        monitor!.pushMessage({ type, content });
      }
    )
  );

  monitor.onSnapshotChanged((snapshot) => {
    sidebarProvider?.sync(snapshot, monitor!.getStatus());
    MonitorPanel.getInstance()?.sync(snapshot, monitor!.getStatus());
  });

  monitor.onStatusChanged((status) => {
    sidebarProvider?.setStatus(status.status, status.text);
    MonitorPanel.getInstance()?.setStatus(status.status, status.text);
  });

  return {
    getSnapshot: () => monitor?.getSnapshot(),
    openPanel: () => vscode.commands.executeCommand('aiAgentMonitor.open'),
    openSidebar: () => vscode.commands.executeCommand('aiAgentMonitor.openSidebar'),
    pushMessage: (type: BlockType, content: string) => {
      return monitor?.pushMessage({ type, content });
    },
  };
}

export function deactivate() {
  monitor?.dispose();
  monitor = undefined;
}
