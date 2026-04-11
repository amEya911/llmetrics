import * as vscode from 'vscode';
import { AgentMonitor } from './AgentMonitor';
import { MonitorPanel } from './MonitorPanel';
import { SidebarProvider } from './SidebarProvider';
import { BlockType } from './types';

let monitor: AgentMonitor | undefined;
let sidebarProvider: SidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  monitor = new AgentMonitor();
  context.subscriptions.push(monitor);

  sidebarProvider = new SidebarProvider(context.extensionUri);
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
      const panel = MonitorPanel.createOrShow(context.extensionUri);
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
      sidebarProvider?.clear();
      MonitorPanel.getInstance()?.clear();
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
